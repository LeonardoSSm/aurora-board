/**
 * Dados importados (`aurora.dataset`) — Data Hub, issue #24 (D2-A).
 *
 * Fonte de dados nativa: o usuário importa um CSV ou JSON (gesto explícito), confere a PRÉVIA e confirma.
 * O conteúdo vai para um asset imutável local (ver `src/data/store.ts`); o bloco guarda só a referência,
 * metadados (nome, contagens, origem) e opções de exibição. Nunca usa `aurora.setState` nem as saídas efêmeras
 * do HTML Data Bridge para guardar linhas.
 *
 * Saídas (projeção limitada — ver `src/data/project.ts`): `rows` (página de linhas como objetos), `columns`,
 * `summary` (contagens, paginação, cortes e estatísticas numéricas) e `count` (número de linhas).
 *
 * Privacidade: os dados são PRIVADOS. Nada vai para a IA (o bloco e tudo o que deriva dele ficam bloqueados por
 * `financialTaint`), o resumo textual não traz valores nem nomes de colunas e a exportação de imagem mostra só
 * esse resumo.
 */
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, Download, Trash2, Upload } from 'lucide-react';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import type { WidgetHostApi, WidgetPlugin, WidgetProps } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import { decFromNumber } from '../../core/decimal';
import { numberValue } from '../../core/scalar';
import { Badge, Button, Field, Label } from '../../ui/primitives';
import { openDialog, toast } from '../../store/ui';
import { updateElement as updateEl } from '../../store/actions';
import { getState } from '../../store/editor';
import { getAdapter } from '../../persistence/autosave';
import { assetIdsOf, downloadText, safeFileName } from '../../persistence/exportImport';
import { cleanLabel, COLUMN_TYPE_LABELS, DATASET_LIMITS, DatasetError, type CellValue, type DatasetContent, type DatasetKind, type DatasetSource } from '../../data/model';
import { checkDatasetFileSize, decodeDatasetBytes, parseDatasetText, type ParsedDataset } from '../../data/parse';
import { datasetEntry, deleteDatasetAsset, loadDatasetContent, requestDataset, saveDataset } from '../../data/store';
import { PROJECTION_LIMITS, projectDataset, sanitizeView, type DatasetProjection, type DatasetView } from '../../data/project';
import { datasetToCSV, datasetToJSON } from '../../data/export';

export interface DatasetData {
  source: DatasetSource | null;
  view: DatasetView;
}

export const DATASET_DEFAULT_TITLE = 'Dados importados';
const STATUS_KEY = '$dataset';

type DatasetStatus =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projection: DatasetProjection };

const ASSET_ID = /^[A-Za-z0-9_-]{1,80}$/;
const safeInt = (v: unknown, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);

export function sanitizeSource(raw: unknown): DatasetSource | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.assetId !== 'string' || !ASSET_ID.test(o.assetId)) return null;
  const rows = safeInt(o.rows, DATASET_LIMITS.maxRows);
  const columns = safeInt(o.columns, DATASET_LIMITS.maxColumns);
  const bytes = safeInt(o.bytes, DATASET_LIMITS.maxFileBytes);
  if (rows === null || columns === null || bytes === null) return null;
  const kind: DatasetKind = o.kind === 'json' ? 'json' : 'csv';
  const importedAt = typeof o.importedAt === 'number' && Number.isFinite(o.importedAt) && o.importedAt > 0 ? o.importedAt : 0;
  return { assetId: o.assetId, name: cleanLabel(o.name) || 'dados', kind, rows, columns, bytes, importedAt };
}

export function sanitizeDatasetData(raw: unknown): DatasetData {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { source: sanitizeSource(o.source), view: sanitizeView(o.view) };
}

/* ------------------------------------------------------------------ projeção memoizada */

// A projeção (estatísticas incluídas) só é refeita quando o conteúdo, o nome ou a visão mudam — o fluxo de dados
// recalcula a cada mudança externa (ex.: HTML publicando), e devolver os MESMOS objetos evita re-render a jusante.
const projections = new WeakMap<DatasetContent, Map<string, DatasetProjection>>();
function projectionOf(content: DatasetContent, name: string, view: DatasetView): DatasetProjection {
  let m = projections.get(content);
  if (!m) { m = new Map(); projections.set(content, m); }
  const key = JSON.stringify([name, view]);
  let p = m.get(key);
  if (!p) {
    if (m.size > 20) m.clear();
    p = projectDataset(content, name, view);
    m.set(key, p);
  }
  return p;
}

export function computeDataset(d: DatasetData): Record<string, unknown> {
  if (!d.source) return { [STATUS_KEY]: { status: 'empty' } satisfies DatasetStatus };
  const e = datasetEntry(d.source.assetId);
  if (!e || e.status === 'loading') {
    void requestDataset(d.source.assetId);
    return { [STATUS_KEY]: { status: 'loading' } satisfies DatasetStatus };
  }
  if (e.status === 'missing') return { [STATUS_KEY]: { status: 'missing' } satisfies DatasetStatus };
  if (e.status === 'error') return { [STATUS_KEY]: { status: 'error', message: e.message } satisfies DatasetStatus };
  const p = projectionOf(e.content, d.source.name, d.view);
  return {
    rows: p.rows,
    columns: p.columns,
    summary: p.summary,
    count: numberValue(decFromNumber(p.summary.rowCount) ?? 0n),
    [STATUS_KEY]: { status: 'ready', projection: p } satisfies DatasetStatus,
  };
}

/* ------------------------------------------------------------------ importação / exportação */

const fmtInt = (n: number) => n.toLocaleString('pt-BR');
const baseName = (name: string) => cleanLabel(name.replace(/\.(csv|tsv|txt|json)$/i, '')) || 'dados';

function formatCell(v: CellValue): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'number') return v.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
  return v.length > 120 ? `${v.slice(0, 119)}…` : v;
}

/** Tabela de leitura: texto puro em nós React (nunca HTML interpretado). */
function DataTable({ columns, rows, testid }: { columns: { id: string; label: string }[]; rows: CellValue[][]; testid: string }) {
  return (
    <div className="overflow-auto border border-line rounded-md" data-testid={testid}>
      <table className="text-[11px] border-collapse min-w-full">
        <thead>
          <tr>{columns.map((c) => <th key={c.id} className="text-left font-semibold px-2 py-1 border-b border-line bg-panel-2 whitespace-nowrap" title={c.id !== c.label ? `nome técnico: ${c.id}` : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="odd:bg-panel-2/40">
              {r.map((v, j) => <td key={j} className={`px-2 py-0.5 border-b border-line/40 whitespace-nowrap max-w-[16rem] truncate ${v === null ? 'text-soft' : typeof v === 'number' ? 'text-right tabular-nums' : ''}`}>{formatCell(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PREVIEW_ROWS = 8;
const PREVIEW_COLS = 12;

function Preview({ parsed, fileName, replacing }: { parsed: ParsedDataset; fileName: string; replacing: DatasetSource | null }) {
  const { content } = parsed;
  const cols = content.columns.slice(0, PREVIEW_COLS).map((c) => ({ id: c.key, label: c.label }));
  return (
    <div className="flex flex-col gap-2 text-[12px]" data-testid="dataset-preview">
      <div>
        <b>{fileName}</b> — {parsed.kind.toUpperCase()}
        {parsed.delimiter ? ` (separador: ${parsed.delimiter === '\t' ? 'tabulação' : `“${parsed.delimiter}”`})` : ''}
        {' · '}<span data-testid="dataset-preview-counts">{fmtInt(content.rows.length)} linha(s) × {content.columns.length} coluna(s)</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {content.columns.slice(0, 40).map((c) => <Badge key={c.key} tone="muted">{c.label}: {COLUMN_TYPE_LABELS[c.type]}</Badge>)}
        {content.columns.length > 40 && <Badge tone="muted">+{content.columns.length - 40}</Badge>}
      </div>
      <DataTable testid="dataset-preview-table" columns={cols} rows={content.rows.slice(0, PREVIEW_ROWS).map((r) => r.slice(0, PREVIEW_COLS))} />
      {(content.rows.length > PREVIEW_ROWS || content.columns.length > PREVIEW_COLS) && <div className="text-soft text-[11px]">Prévia das primeiras {Math.min(PREVIEW_ROWS, content.rows.length)} linhas e {cols.length} colunas.</div>}
      {parsed.warnings.map((w) => <div key={w} className="text-[11px] text-warn">⚠ {w}</div>)}
      {replacing && <div className="text-[11px]" data-testid="dataset-replace-note">Substitui os dados atuais ({fmtInt(replacing.rows)} × {replacing.columns}). As conexões do bloco continuam; o arquivo anterior fica guardado para cópias deste bloco e para o desfazer.</div>}
      <div className="text-[11px] text-soft">Os dados ficam só neste dispositivo e não são enviados à IA.</div>
    </div>
  );
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.tsv,.txt,.json,text/csv,application/json,text/plain';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function refuse(fileName: string, message: string) {
  await openDialog({ title: 'Importação recusada', message: `“${fileName.slice(0, 80)}”: ${message} Nenhum dado foi alterado.`, buttons: [{ label: 'Ok', value: 'ok', variant: 'primary' }] });
}

/**
 * Importa (ou substitui) os dados de um bloco: arquivo → validação → PRÉVIA → confirmação → asset novo →
 * referência no bloco (uma entrada de histórico). Recusa sem estado parcial: nada é gravado antes de confirmar,
 * e a referência só muda depois do asset gravado.
 */
export async function importIntoBlock(elementId: string, api: Pick<WidgetHostApi, 'getElement' | 'updateElement' | 'toast'>, file?: File | null): Promise<boolean> {
  const f = file ?? (await pickFile());
  if (!f) return false;
  let parsed: ParsedDataset;
  try {
    checkDatasetFileSize(f.size);
    parsed = parseDatasetText(f.name, decodeDatasetBytes(new Uint8Array(await f.arrayBuffer())));
  } catch (e) {
    await refuse(f.name, e instanceof DatasetError ? e.message : 'Não foi possível ler o arquivo.');
    return false;
  }
  const el = api.getElement(elementId);
  if (el?.type !== 'widget') return false;
  const current = sanitizeDatasetData(el.data);
  const r = await openDialog({
    title: current.source ? 'Substituir dados — prévia' : 'Importar dados — prévia',
    body: <Preview parsed={parsed} fileName={f.name} replacing={current.source} />,
    wide: true,
    buttons: [{ label: 'Cancelar', value: 'cancel' }, { label: current.source ? 'Substituir' : 'Importar', value: 'ok', variant: 'primary' }],
  });
  if (r.button !== 'ok') return false;
  let assetId: string;
  try {
    assetId = await saveDataset(parsed.content, f.name);
  } catch (e) {
    await refuse(f.name, e instanceof DatasetError ? e.message : 'Falha ao gravar no armazenamento local.');
    return false;
  }
  const latest = api.getElement(elementId);
  if (latest?.type !== 'widget') {
    // Bloco excluído enquanto gravava: o arquivo recém-criado não tem referência nenhuma — apaga (melhor esforço).
    await deleteDatasetAsset(assetId).catch(() => undefined);
    return false;
  }
  const name = baseName(f.name);
  const source: DatasetSource = { assetId, name, kind: parsed.kind, rows: parsed.content.rows.length, columns: parsed.content.columns.length, bytes: Math.min(f.size, DATASET_LIMITS.maxFileBytes), importedAt: Date.now() };
  const prev = sanitizeDatasetData(latest.data);
  // Colunas escolhidas que não existem mais são descartadas; a página volta ao início.
  const keys = new Set(parsed.content.columns.map((c) => c.key));
  const data: DatasetData = { source, view: { ...prev.view, page: 0, columns: prev.view.columns.filter((k) => keys.has(k)) } };
  const title = latest.title === DATASET_DEFAULT_TITLE || !latest.title.trim() ? name.slice(0, 80) : latest.title;
  api.updateElement(elementId, { data, title } as Partial<AuroraElement>);
  api.toast(`${fmtInt(source.rows)} linha(s) importada(s).`, 'success');
  return true;
}

export async function exportDataset(source: DatasetSource, kind: 'csv' | 'json', toast: WidgetHostApi['toast']) {
  try {
    const content = await loadDatasetContent(source.assetId);
    const file = safeFileName(source.name) || 'dados';
    if (kind === 'csv') downloadText(`${file}.csv`, datasetToCSV(content), 'text/csv;charset=utf-8');
    else downloadText(`${file}.json`, datasetToJSON(content, source.name), 'application/json');
    toast(`Dados exportados (${kind.toUpperCase()}).`, 'success');
  } catch (e) {
    toast(e instanceof DatasetError ? e.message : 'Não foi possível exportar os dados.', 'error');
  }
}

/** Outros elementos (em qualquer quadro deste dispositivo) que usam o mesmo arquivo de dados. */
async function otherReferences(assetId: string, elementId: string): Promise<number> {
  const s = getState();
  let n = s.elements.filter((e) => e.id !== elementId && assetIdsOf([e]).has(assetId)).length;
  const adapter = getAdapter();
  for (const ws of await adapter.listWorkspaces()) {
    for (const m of await adapter.listBoards(ws.id)) {
      if (m.id === s.boardId) continue; // o quadro aberto já foi contado pelo estado em memória (mais recente)
      const b = await adapter.loadBoard(m.id);
      if (b) n += b.elements.filter((e) => assetIdsOf([e]).has(assetId)).length;
    }
  }
  return n;
}

/** Exclusão consciente: apaga o arquivo local se nada mais o usa; senão só desconecta este bloco. */
export async function deleteBlockData(element: WidgetElement, api: Pick<WidgetHostApi, 'confirm' | 'updateElement' | 'toast'>) {
  const d = sanitizeDatasetData(element.data);
  if (!d.source) return;
  const ok = await api.confirm('Excluir dados importados', `Os dados “${d.source.name}” (${fmtInt(d.source.rows)} linha(s)) serão apagados deste dispositivo. Exporte antes se quiser guardar uma cópia. Conexões e o bloco continuam, vazios.`, 'Excluir dados', true);
  if (!ok) return;
  try {
    const others = await otherReferences(d.source.assetId, element.id);
    if (!others) await deleteDatasetAsset(d.source.assetId);
    api.updateElement(element.id, { data: { ...d, source: null, view: { ...d.view, page: 0, columns: [] } } } as Partial<AuroraElement>);
    api.toast(others ? `Outros ${others} bloco(s) usam estes dados: o arquivo foi mantido e só este bloco foi esvaziado.` : 'Dados apagados deste dispositivo.', others ? 'warning' : 'success');
  } catch {
    api.toast('Não foi possível apagar os dados. Nada foi alterado.', 'error');
  }
}

/* ------------------------------------------------------------------ interface */

function statusOf(outputs: Record<string, unknown>, d: DatasetData): DatasetStatus {
  const s = outputs[STATUS_KEY] as DatasetStatus | undefined;
  return s ?? (d.source ? { status: 'loading' } : { status: 'empty' });
}

function Pager({ p, onPage }: { p: DatasetProjection; onPage: (n: number) => void }) {
  const s = p.summary;
  return (
    <div className="flex items-center gap-1 text-[11px]" data-testid="dataset-pager">
      <Button aria-label="Página anterior" disabled={s.page <= 0} onClick={() => onPage(s.page - 1)}><ChevronLeft size={12} /></Button>
      <span data-testid="dataset-page">Página {s.page + 1} de {s.pageCount}</span>
      <Button aria-label="Próxima página" disabled={s.page >= s.pageCount - 1} onClick={() => onPage(s.page + 1)}><ChevronRight size={12} /></Button>
    </div>
  );
}

const TILE_ROWS = 50;

function DatasetTile({ element, data, outputs, update, api }: WidgetProps<DatasetData>) {
  const st = statusOf(outputs, data);
  const doImport = () => void importIntoBlock(element.id, api);
  if (st.status === 'empty') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-3 text-center text-[12px]" data-testid="dataset-empty">
        <Database size={22} className="text-soft" />
        <div>Importe um arquivo CSV ou JSON para usar os dados no quadro.</div>
        <Button variant="primary" data-testid="dataset-import" onClick={doImport}><Upload size={12} /> Importar arquivo</Button>
        <div className="text-[10px] text-soft">Você confere a prévia antes de gravar. Os dados ficam neste dispositivo.</div>
      </div>
    );
  }
  if (st.status !== 'ready') {
    const msg = st.status === 'loading' ? 'Carregando dados…' : st.status === 'missing' ? 'Os dados deste bloco não estão neste dispositivo (backup sem dados importados ou dados excluídos). Importe o arquivo de novo.' : st.message;
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-3 text-center text-[12px]" data-testid="dataset-status" data-status={st.status}>
        <div className={st.status === 'loading' ? 'text-soft' : 'text-warn'}>{msg}</div>
        {st.status !== 'loading' && <Button data-testid="dataset-import" onClick={doImport}><Upload size={12} /> Importar arquivo</Button>}
      </div>
    );
  }
  const p = st.projection;
  const shown = p.rows.slice(0, TILE_ROWS);
  const cols = p.columns.filter((c) => p.summary.projectedColumns.includes(c.id));
  return (
    <div className="h-full flex flex-col gap-1 p-2 text-[12px] min-h-0" data-testid="dataset-tile">
      <div className="flex items-center gap-2 flex-wrap">
        <span data-testid="dataset-counts">{fmtInt(p.summary.rowCount)} linha(s) × {p.summary.columnCount} coluna(s)</span>
        {p.summary.truncated && <Badge tone="warn">saídas limitadas</Badge>}
        <div className="flex-1" />
        <Pager p={p} onPage={(page) => update((d) => ({ ...d, view: { ...d.view, page } }))} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <DataTable testid="dataset-table" columns={cols} rows={shown.map((r) => cols.map((c) => r[c.id] ?? null))} />
        {p.rows.length > shown.length && <div className="text-[10px] text-soft mt-1">Mostrando {shown.length} de {p.rows.length} linhas desta página.</div>}
      </div>
      <div className="flex gap-1 flex-wrap">
        <Button data-testid="dataset-replace" onClick={doImport}><Upload size={12} /> Substituir</Button>
        <Button data-testid="dataset-export-csv" onClick={() => data.source && void exportDataset(data.source, 'csv', api.toast)}><Download size={12} /> CSV</Button>
        <Button data-testid="dataset-export-json" onClick={() => data.source && void exportDataset(data.source, 'json', api.toast)}><Download size={12} /> JSON</Button>
      </div>
    </div>
  );
}

function DatasetInspector({ element, data, outputs, update, api }: WidgetProps<DatasetData>) {
  const st = statusOf(outputs, data);
  const p = st.status === 'ready' ? st.projection : null;
  const [size, setSize] = useState(String(data.view.pageSize));
  const chosen = useMemo(() => new Set(data.view.columns), [data.view.columns]);
  const src = data.source;
  const commitSize = () => {
    const n = Math.round(Number(size));
    const v = Number.isFinite(n) ? Math.min(PROJECTION_LIMITS.maxPageSize, Math.max(1, n)) : data.view.pageSize;
    setSize(String(v));
    if (v !== data.view.pageSize) update((d) => ({ ...d, view: { ...d.view, pageSize: v, page: 0 } }));
  };
  const toggleCol = (key: string) => update((d) => {
    const set = new Set(d.view.columns);
    if (set.has(key)) set.delete(key); else set.add(key);
    return { ...d, view: { ...d.view, columns: [...set].slice(0, PROJECTION_LIMITS.maxProjectedColumns) } };
  });
  return (
    <div className="flex flex-col gap-1 text-[12px]" data-testid="dataset-inspector">
      <Label>Dados</Label>
      {src ? (
        <div className="text-[11px]" data-testid="dataset-source">
          <div><b>{src.name}</b> ({src.kind.toUpperCase()}, {(src.bytes / 1024).toFixed(1)} KB)</div>
          <div>{fmtInt(src.rows)} linha(s) × {src.columns} coluna(s){src.importedAt ? ` · importado em ${new Date(src.importedAt).toLocaleString('pt-BR')}` : ''}</div>
        </div>
      ) : <div className="text-[11px] text-soft">Nenhum arquivo importado.</div>}
      <div className="flex gap-1 flex-wrap">
        <Button data-testid="dataset-inspector-import" onClick={() => void importIntoBlock(element.id, api)}><Upload size={12} /> {src ? 'Substituir…' : 'Importar…'}</Button>
        {src && <Button onClick={() => void exportDataset(src, 'csv', api.toast)}><Download size={12} /> CSV</Button>}
        {src && <Button onClick={() => void exportDataset(src, 'json', api.toast)}><Download size={12} /> JSON</Button>}
      </div>

      <Label>Saídas para conexões</Label>
      <div className="text-[11px] text-soft">
        <code>rows</code> (página de linhas), <code>columns</code>, <code>summary</code> (contagens, paginação e estatísticas) e <code>count</code> (número de linhas). O conjunto inteiro nunca é enviado: no máximo {PROJECTION_LIMITS.maxPageSize} linhas, {PROJECTION_LIMITS.maxProjectedColumns} colunas e {Math.round(PROJECTION_LIMITS.maxOutputChars / 1024)} KB por saída.
      </div>
      <label className="flex items-center gap-2 text-[11px]">Linhas por página
        <Field aria-label="Linhas por página" type="number" min={1} max={PROJECTION_LIMITS.maxPageSize} value={size} className="w-20" onChange={(e) => setSize(e.target.value)} onBlur={commitSize} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitSize(); }} />
      </label>
      {p && <Pager p={p} onPage={(page) => update((d) => ({ ...d, view: { ...d.view, page } }))} />}
      {p && (
        <div className="flex flex-col gap-0.5 max-h-48 overflow-auto" data-testid="dataset-columns">
          <div className="text-[11px] text-soft">Colunas nas linhas ({chosen.size ? `${chosen.size} escolhida(s)` : 'todas'}):</div>
          {p.columns.map((c) => (
            <label key={c.id} className="flex items-center gap-1 text-[11px]">
              <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggleCol(c.id)} aria-label={`Coluna ${c.label}`} />
              <span className="truncate">{c.label}</span> <span className="text-soft">({COLUMN_TYPE_LABELS[c.type]}{c.id !== c.label ? ` · ${c.id}` : ''})</span>
            </label>
          ))}
        </div>
      )}
      {p?.summary.truncated && <div className="text-[11px] text-warn" data-testid="dataset-truncation">{p.summary.notes.map((n) => <div key={n}>⚠ {n}</div>)}</div>}

      <Label>Privacidade</Label>
      <div className="text-[11px] text-soft" data-testid="dataset-privacy">Os dados ficam só neste dispositivo. Não são enviados à IA — nem por blocos conectados (fórmulas, HTML) — e não aparecem em imagens exportadas. Backups de quadro perguntam se devem incluí-los.</div>
      {src && <div className="mt-1"><Button variant="danger" data-testid="dataset-delete" onClick={() => void deleteBlockData(element, api)}><Trash2 size={12} /> Excluir dados deste dispositivo</Button></div>}
    </div>
  );
}

export const datasetPlugin: WidgetPlugin<DatasetData> = {
  id: WIDGET.dataset,
  name: DATASET_DEFAULT_TITLE,
  description: 'Importe CSV ou JSON, confira a prévia e use os dados em gráficos, fórmulas e blocos HTML. Fica neste dispositivo.',
  icon: Database,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#7fc4ff',
  permissions: ['storage:assets'],
  defaultSize: { width: 440, height: 300 },
  minSize: { width: 260, height: 160 },
  inputs: [],
  outputs: [
    { id: 'rows', label: 'Linhas (página)', type: 'object' },
    { id: 'columns', label: 'Colunas', type: 'object' },
    { id: 'summary', label: 'Resumo', type: 'object' },
    { id: 'count', label: 'Número de linhas', type: 'number' },
  ],
  createData: () => ({ source: null, view: sanitizeView({}) }),
  sanitize: sanitizeDatasetData,
  compute: (d) => computeDataset(d),
  // Resumo NÃO sensível (busca, exportação de imagem/texto, contexto genérico): sem valores e sem nomes de colunas.
  summarize: (d, el) => (d.source ? `${el.title}: dados importados (${fmtInt(d.source.rows)} linha(s) × ${d.source.columns} coluna(s)). Os valores ficam neste dispositivo e não entram neste resumo.` : `${el.title}: dados importados (vazio).`),
  aiContext: () => ({ allowed: false, text: '', reason: 'Dados importados são privados: não são enviados à IA.' }),
  Component: DatasetTile,
  Inspector: DatasetInspector,
  menuItems: (el, d) => [
    { id: 'import', label: d.source ? 'Substituir dados…' : 'Importar dados…', run: () => void importIntoBlock(el.id, hostLite()) },
    { id: 'csv', label: 'Exportar dados (CSV)', disabled: !d.source, run: () => d.source && void exportDataset(d.source, 'csv', hostLite().toast) },
    { id: 'json', label: 'Exportar dados (JSON)', disabled: !d.source, run: () => d.source && void exportDataset(d.source, 'json', hostLite().toast) },
  ],
};

/** API mínima para ações fora do componente (menu de contexto). */
function hostLite(): Pick<WidgetHostApi, 'getElement' | 'updateElement' | 'toast'> {
  return { getElement: (id) => getState().elements.find((e) => e.id === id), updateElement: updateEl, toast };
}
