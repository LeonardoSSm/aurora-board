/**
 * Data Hub (D2-B) — agregação NATIVA sobre o conjunto inteiro (saída `groups` do bloco `aurora.dataset`).
 *
 * O bloco HTML só recebe uma página de linhas (limites do Bridge). Para dashboards sobre o conjunto todo, o
 * próprio bloco de dados agrupa por uma coluna e resume uma coluna numérica — contagem, soma, média, mínimo e
 * máximo por grupo — e entrega só o resultado, limitado a 500 grupos e a 60 KB de JSON.
 */
import type { CellValue, DatasetContent } from './model';
import { PROJECTION_LIMITS } from './project';

export const AGGREGATE_LIMITS = { maxGroups: 500, maxGroupLabelChars: 200 };

export interface GroupStats {
  /** Rótulo do grupo (texto do valor; `null` = células vazias). */
  group: string | null;
  /** Linhas no grupo. */
  count: number;
  /** Linhas do grupo com número na coluna medida. */
  valid: number;
  sum: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface DatasetGroups {
  groupBy: { id: string; label: string };
  measure: { id: string; label: string } | null;
  /** Ordenados pela soma (ou pela contagem, sem medida), do maior para o menor. */
  groups: GroupStats[];
  groupCount: number;
  rowCount: number;
  truncated: boolean;
  notes: string[];
}

/** Chave de agrupamento: o valor ORIGINAL inteiro (revisão do Codex, PR #28 — encurtar antes juntava grupos). */
const groupKey = (v: CellValue): string | null => (v === null ? null : typeof v === 'string' ? v : String(v));
/** Rótulo de SAÍDA (só ele é encurtado). */
const shortLabel = (s: string | null): string | null => (s !== null && s.length > AGGREGATE_LIMITS.maxGroupLabelChars ? `${s.slice(0, AGGREGATE_LIMITS.maxGroupLabelChars - 1)}…` : s);

/** Agrupa `content` pela coluna `groupBy` (chave técnica) resumindo `measure` (opcional). Null se a coluna não existe. */
export function aggregateDataset(content: DatasetContent, groupBy: string, measure: string): DatasetGroups | null {
  const gi = content.columns.findIndex((c) => c.key === groupBy);
  if (gi < 0) return null;
  const mi = measure ? content.columns.findIndex((c) => c.key === measure) : -1;
  const acc = new Map<string | null, { count: number; valid: number; sum: number; min: number; max: number }>();
  for (const row of content.rows) {
    const g = groupKey(row[gi]);
    let a = acc.get(g);
    if (!a) { a = { count: 0, valid: 0, sum: 0, min: Infinity, max: -Infinity }; acc.set(g, a); }
    a.count++;
    if (mi >= 0) {
      const v = row[mi];
      if (typeof v === 'number' && Number.isFinite(v)) {
        a.valid++; a.sum += v;
        if (v < a.min) a.min = v;
        if (v > a.max) a.max = v;
      }
    }
  }
  const all: GroupStats[] = [...acc.entries()].map(([group, a]) => ({
    group: shortLabel(group),
    count: a.count,
    valid: a.valid,
    sum: a.sum,
    mean: a.valid ? a.sum / a.valid : null,
    min: a.valid ? a.min : null,
    max: a.valid ? a.max : null,
  }));
  all.sort((x, y) => (mi >= 0 ? y.sum - x.sum : 0) || y.count - x.count || String(x.group ?? '').localeCompare(String(y.group ?? ''), 'pt-BR'));
  const notes: string[] = [];
  let truncated = false;
  let groups = all;
  if (groups.length > AGGREGATE_LIMITS.maxGroups) {
    groups = groups.slice(0, AGGREGATE_LIMITS.maxGroups);
    truncated = true;
    notes.push(`Só os ${AGGREGATE_LIMITS.maxGroups} maiores grupos (de ${all.length}).`);
  }
  const col = (i: number) => ({ id: content.columns[i].key, label: content.columns[i].label });
  const out: DatasetGroups = { groupBy: col(gi), measure: mi >= 0 ? col(mi) : null, groups, groupCount: all.length, rowCount: content.rows.length, truncated, notes };
  // Cabe no limite por saída: corta os menores grupos até caber (informado).
  while (JSON.stringify(out).length > PROJECTION_LIMITS.maxOutputChars && out.groups.length > 1) {
    out.groups = out.groups.slice(0, Math.max(1, Math.floor(out.groups.length * 0.8)));
    if (!out.truncated) out.notes.push('Grupos limitados para caber no limite por saída.');
    out.truncated = true;
  }
  return out;
}
