/**
 * Data Hub (D2-A) — PROJEÇÃO de um conjunto de dados para o fluxo de dados (saídas do bloco `aurora.dataset`).
 *
 * O conjunto inteiro nunca é empurrado para conexões nem para o iframe HTML: as saídas trazem uma página de
 * linhas (com colunas escolhidas), a lista de colunas, um resumo com estatísticas das colunas numéricas e a
 * contagem. Cada saída cabe no limite de VALOR do HTML Data Bridge (64 KB de JSON) com folga, e a soma das
 * quatro fica abaixo de 1 MB por envio. Quando algo é cortado, `summary.truncated` diz o quê e por quê.
 */
import { BRIDGE_LIMITS } from '../core/htmlBridge';
import type { CellValue, ColumnType, DatasetContent } from './model';

export const PROJECTION_LIMITS = {
  maxPageSize: 500,
  defaultPageSize: 100,
  /** Colunas por linha projetada (as demais ficam fora de `rows`, mas continuam em `columns`). */
  maxProjectedColumns: 50,
  /** JSON de cada saída, abaixo do limite de valor do Bridge (64 KB) para sobrar espaço. */
  maxOutputChars: Math.min(60 * 1024, BRIDGE_LIMITS.maxValueChars - 4 * 1024),
  /** Texto de uma célula projetada (o restante fica guardado; aqui é cortado com “…”). */
  maxProjectedCellChars: 2000,
  /** Colunas numéricas com estatística no resumo. */
  maxStatsColumns: 50,
};

export interface DatasetView {
  page: number;
  pageSize: number;
  /** Chaves das colunas projetadas em `rows`; vazio = todas (até o limite). */
  columns: string[];
  /** D2-B: agrupamento nativo (saída `groups`) — chave da coluna de grupo e da coluna numérica; '' = desligado. */
  groupBy: string;
  measure: string;
}

export interface ColumnStats { count: number; sum: number; min: number | null; max: number | null; mean: number | null }

export interface DatasetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Primeira linha (base 0) da página e quantidade entregue em `rows`. */
  offset: number;
  rowsInPage: number;
  projectedColumns: string[];
  truncated: boolean;
  /** Motivos de corte (texto para pessoas). */
  notes: string[];
  stats: Record<string, ColumnStats>;
}

export interface DatasetProjection {
  rows: Record<string, CellValue>[];
  /**
   * `id` = chave técnica usada nas linhas (`rows[i][id]`). Não se chama `key` porque o HTML Data Bridge remove
   * propriedades `key` de valores do fluxo de dados (revisão do Codex, PR #27).
   */
  columns: { id: string; label: string; type: ColumnType }[];
  summary: DatasetSummary;
}

const clampInt = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : dflt);

export function sanitizeView(raw: unknown): DatasetView {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const columns = Array.isArray(o.columns) ? [...new Set(o.columns.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 200))].slice(0, PROJECTION_LIMITS.maxProjectedColumns) : [];
  const key = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : '');
  return {
    page: clampInt(o.page, 0, 1_000_000, 0),
    pageSize: clampInt(o.pageSize, 1, PROJECTION_LIMITS.maxPageSize, PROJECTION_LIMITS.defaultPageSize),
    columns,
    groupBy: key(o.groupBy),
    measure: key(o.measure),
  };
}

function statsOf(content: DatasetContent, c: number): ColumnStats {
  let count = 0, sum = 0, min = Infinity, max = -Infinity;
  for (const r of content.rows) {
    const v = r[c];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    count++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return count ? { count, sum, min, max, mean: sum / count } : { count: 0, sum: 0, min: null, max: null, mean: null };
}

const cut = (v: CellValue): CellValue => (typeof v === 'string' && v.length > PROJECTION_LIMITS.maxProjectedCellChars ? `${v.slice(0, PROJECTION_LIMITS.maxProjectedCellChars - 1)}…` : v);

/** Projeção das saídas. Pura e determinística (mesma entrada → mesmo resultado). */
export function projectDataset(content: DatasetContent, name: string, viewRaw: unknown): DatasetProjection {
  const view = sanitizeView(viewRaw);
  const total = content.rows.length;
  const pageCount = Math.max(1, Math.ceil(total / view.pageSize));
  const page = Math.min(view.page, pageCount - 1);
  const offset = page * view.pageSize;
  const notes: string[] = [];
  let truncated = false;

  // Colunas projetadas: as escolhidas que existem (na ordem do conjunto) ou todas, até o limite.
  const wanted = view.columns.length ? new Set(view.columns) : null;
  let idx = content.columns.map((_, i) => i).filter((i) => !wanted || wanted.has(content.columns[i].key));
  if (!idx.length) idx = content.columns.map((_, i) => i);
  if (idx.length > PROJECTION_LIMITS.maxProjectedColumns) {
    idx = idx.slice(0, PROJECTION_LIMITS.maxProjectedColumns);
    truncated = true;
    notes.push(`Só as primeiras ${PROJECTION_LIMITS.maxProjectedColumns} colunas entram nas linhas (escolha as colunas no painel).`);
  }
  const keys = idx.map((i) => content.columns[i].key);

  // Linhas da página como objetos (Object.fromEntries cria propriedades próprias; as chaves já são seguras).
  const rows: Record<string, CellValue>[] = [];
  let chars = 2;
  let cellCut = false;
  for (let r = offset; r < Math.min(total, offset + view.pageSize); r++) {
    const src = content.rows[r];
    const obj = Object.fromEntries(idx.map((i, k) => {
      const v = cut(src[i]);
      if (v !== src[i]) cellCut = true;
      return [keys[k], v];
    }));
    const size = JSON.stringify(obj).length + 1;
    if (chars + size > PROJECTION_LIMITS.maxOutputChars) {
      truncated = true;
      notes.push(`Página limitada a ${rows.length} linha(s) para caber no limite de ${Math.round(PROJECTION_LIMITS.maxOutputChars / 1024)} KB por saída (diminua o tamanho da página ou escolha menos colunas).`);
      break;
    }
    chars += size;
    rows.push(obj);
  }
  if (cellCut) { truncated = true; notes.push(`Textos com mais de ${PROJECTION_LIMITS.maxProjectedCellChars} caracteres foram encurtados nas linhas (o dado guardado está completo).`); }

  const stats: Record<string, ColumnStats> = {};
  let statCols = 0;
  for (let c = 0; c < content.columns.length; c++) {
    if (content.columns[c].type !== 'number') continue;
    if (++statCols > PROJECTION_LIMITS.maxStatsColumns) { truncated = true; notes.push(`Estatísticas só das primeiras ${PROJECTION_LIMITS.maxStatsColumns} colunas numéricas.`); break; }
    stats[content.columns[c].key] = statsOf(content, c);
  }

  return {
    rows,
    columns: content.columns.map((c) => ({ id: c.key, label: c.label, type: c.type })),
    summary: {
      name,
      rowCount: total,
      columnCount: content.columns.length,
      page,
      pageSize: view.pageSize,
      pageCount,
      offset,
      rowsInPage: rows.length,
      projectedColumns: keys,
      truncated,
      notes,
      stats,
    },
  };
}
