/**
 * Aurora Command Center (issue #14) — índice em memória, busca, navegação até o resultado e recentes.
 *
 * - Índice construído no cliente, sob demanda (ao abrir a paleta), lendo os quadros pelo PersistenceAdapter.
 *   Cache por quadro com a `updatedAt` dos metadados: só relê o que mudou (nada de varredura contínua); quadros
 *   excluídos saem do cache. O quadro ATIVO é indexado do estado em memória (inclui o que ainda não foi salvo).
 * - Nada do índice é gravado; consultas nunca saem do navegador. Recentes guardam só chaves (sem texto).
 * - Indexação em lotes com pausas (`setTimeout 0`) para não travar o canvas; uma nova indexação cancela a antiga.
 */
import { elementDocs, normalize, pushRecent, sanitizeRecents, scoreDoc, snippet, terms, type RecentRef, type SearchDoc, type SearchFilter, type Snippet } from '../core/search';
import type { AuroraElement, BoardMeta, Workspace } from '../core/schema';
import type { SpatialCheckpoint } from '../core/checkpoints';
import { getWidget } from '../widgets/registry';
import { getAdapter } from '../persistence/autosave';
import { focusElement, openBoard, switchWorkspace } from './actions';
import { navigateToCheckpoint } from './checkpointActions';
import { getState, setState } from './editor';
import { toast } from './ui';

interface IndexedDoc extends SearchDoc { nt: string; nb: string }
interface BoardEntry { updatedAt: number; docs: IndexedDoc[] }

const widgetName = (t: string) => getWidget(t)?.name ?? 'Widget';

function indexDocs(list: SearchDoc[]): IndexedDoc[] {
  return list.map((d) => ({ ...d, nt: normalize(d.title), nb: normalize(d.body) }));
}

export function buildBoardDocs(meta: Pick<BoardMeta, 'id' | 'workspaceId' | 'name' | 'description' | 'updatedAt'>, elements: readonly AuroraElement[], checkpoints: readonly SpatialCheckpoint[]): IndexedDoc[] {
  const out: SearchDoc[] = [];
  out.push({ key: `board:${meta.id}:${meta.id}`, kind: 'board', boardId: meta.id, workspaceId: meta.workspaceId, id: meta.id, title: meta.name, body: meta.description ?? '', typeLabel: 'Quadro', filter: 'boards', updatedAt: meta.updatedAt ?? 0 });
  for (const c of checkpoints) {
    if (!c || typeof c.name !== 'string') continue;
    out.push({ key: `checkpoint:${meta.id}:${c.id}`, kind: 'checkpoint', boardId: meta.id, workspaceId: meta.workspaceId, id: c.id, title: c.name, body: c.description ?? '', typeLabel: 'Local', filter: 'places', updatedAt: c.updatedAt ?? 0 });
  }
  for (const el of elements) {
    try { out.push(...elementDocs(el, meta.id, meta.workspaceId, widgetName)); } catch { /* elemento malformado: ignora */ }
  }
  return indexDocs(out);
}

/* ------------------------------------------------------------------ */
/* Estado do índice                                                    */
/* ------------------------------------------------------------------ */

const closed = new Map<string, BoardEntry>();
let metas: (BoardMeta & { workspaceName: string })[] = [];
let current: { boardId: string; elements: readonly AuroraElement[]; checkpoints: readonly SpatialCheckpoint[]; meta: BoardMeta | undefined; docs: IndexedDoc[] } | null = null;
let indexRun = 0;

export interface IndexStatus { state: 'idle' | 'indexing' | 'ready' | 'error'; done: number; total: number; message?: string }
let status: IndexStatus = { state: 'idle', done: 0, total: 0 };
const listeners = new Set<() => void>();
function emit(next: Partial<IndexStatus>) { status = { ...status, ...next }; listeners.forEach((l) => l()); }
export function indexStatus() { return status; }
export function subscribeIndex(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Atualiza o índice dos quadros fechados de TODAS as workspaces: lê só quadros novos ou alterados desde a última
 * leitura, em lotes. Chamadas novas cancelam a anterior.
 */
export async function refreshIndex(): Promise<void> {
  const run = ++indexRun;
  try {
    const adapter = getAdapter();
    const workspaces: Workspace[] = await adapter.listWorkspaces();
    const all: (BoardMeta & { workspaceName: string })[] = [];
    for (const ws of workspaces) for (const m of await adapter.listBoards(ws.id)) all.push({ ...m, workspaceName: ws.name });
    if (run !== indexRun) return;
    metas = all;
    const ids = new Set(all.map((m) => m.id));
    for (const id of [...closed.keys()]) if (!ids.has(id)) closed.delete(id); // excluídos saem
    const stale = all.filter((m) => m.id !== getState().boardId && closed.get(m.id)?.updatedAt !== m.updatedAt);
    emit({ state: stale.length ? 'indexing' : 'ready', done: 0, total: stale.length, message: undefined });
    let done = 0;
    for (const m of stale) {
      if (run !== indexRun) return;
      try {
        const b = await adapter.loadBoard(m.id);
        if (b) closed.set(m.id, { updatedAt: m.updatedAt, docs: buildBoardDocs(m, Array.isArray(b.elements) ? b.elements : [], Array.isArray(b.checkpoints) ? b.checkpoints : []) });
      } catch { /* quadro ilegível: fica de fora, sem travar o resto */ }
      done++;
      if (done % 4 === 0) { emit({ done }); await yieldToUi(); }
    }
    if (run === indexRun) emit({ state: 'ready', done, total: stale.length });
  } catch (e) {
    if (run === indexRun) emit({ state: 'error', message: (e as Error).message || 'Falha ao ler os quadros.' });
  }
}

/** Documentos do quadro ativo, recalculados só quando elementos/checkpoints/metadados mudam (referência). */
function currentDocs(): IndexedDoc[] {
  const s = getState();
  const meta = s.boards.find((b) => b.id === s.boardId);
  if (!current || current.boardId !== s.boardId || current.elements !== s.elements || current.checkpoints !== s.checkpoints || current.meta !== meta) {
    current = { boardId: s.boardId, elements: s.elements, checkpoints: s.checkpoints, meta, docs: meta ? buildBoardDocs(meta, s.elements, s.checkpoints) : [] };
  }
  return current.docs;
}

/** Testes/diagnóstico: quantos documentos há no índice (sem conteúdo). */
export function indexSize() {
  let n = currentDocs().length;
  for (const [id, e] of closed) if (id !== getState().boardId) n += e.docs.length;
  return n;
}

export interface SearchResult { doc: SearchDoc; score: number; snippet: Snippet | null; boardName: string; workspaceName: string; archived: boolean }

export interface SearchOptions { filter?: SearchFilter; scope?: 'all' | 'workspace' | 'board'; includeArchived?: boolean; limit?: number }

export function search(query: string, opts: SearchOptions = {}): SearchResult[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const s = getState();
  const filter = opts.filter ?? 'all';
  const scope = opts.scope ?? 'all';
  const metaById = new Map(metas.map((m) => [m.id, m]));
  for (const b of s.boards) if (!metaById.has(b.id)) metaById.set(b.id, { ...b, workspaceName: s.workspaces.find((w) => w.id === b.workspaceId)?.name ?? '' });
  const pools: IndexedDoc[][] = [currentDocs()];
  for (const [id, e] of closed) if (id !== s.boardId) pools.push(e.docs);
  const now = Date.now();
  const out: SearchResult[] = [];
  for (const pool of pools) {
    for (const d of pool) {
      if (filter !== 'all' && d.filter !== filter) continue;
      if (scope === 'board' && d.boardId !== s.boardId) continue;
      if (scope === 'workspace' && d.workspaceId !== s.workspaceId) continue;
      const meta = metaById.get(d.boardId);
      if (!meta) continue; // quadro excluído
      if (meta.archived && !opts.includeArchived) continue;
      const sc = scoreDoc(d, ts, d.nt, d.nb, now);
      if (sc < 0) continue;
      out.push({ doc: d, score: sc + (d.boardId === s.boardId ? 0.5 : 0), snippet: null, boardName: meta.name, workspaceName: meta.workspaceName, archived: !!meta.archived });
    }
  }
  out.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt || a.doc.key.localeCompare(b.doc.key));
  const top = out.slice(0, opts.limit ?? 60);
  for (const r of top) if (r.doc.body && !r.doc.contentHidden) r.snippet = snippet(r.doc.body, ts);
  return top;
}

/** Documento indexado por chave (recentes). */
export function docByKey(key: string): SearchResult | null {
  const s = getState();
  const pools: IndexedDoc[][] = [currentDocs()];
  for (const [id, e] of closed) if (id !== s.boardId) pools.push(e.docs);
  for (const pool of pools) {
    const d = pool.find((x) => x.key === key);
    if (!d) continue;
    const meta = metas.find((m) => m.id === d.boardId) ?? s.boards.find((b) => b.id === d.boardId);
    if (!meta) return null;
    return { doc: d, score: 0, snippet: null, boardName: meta.name, workspaceName: (meta as { workspaceName?: string }).workspaceName ?? '', archived: !!meta.archived };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Recentes (configuração local: só chaves, sem texto)                  */
/* ------------------------------------------------------------------ */

let recents: RecentRef[] = [];
export async function loadRecents() {
  try { recents = sanitizeRecents(await getAdapter().getSetting('commandRecents')); } catch { recents = []; }
  return recents;
}
export function recentResults(): SearchResult[] {
  return recents.map((r) => docByKey(r.key)).filter((x): x is SearchResult => !!x);
}
async function remember(key: string) {
  recents = pushRecent(recents, key);
  try { await getAdapter().setSetting('commandRecents', recents); } catch { /* recentes são opcionais */ }
}

/* ------------------------------------------------------------------ */
/* Navegação até o resultado                                           */
/* ------------------------------------------------------------------ */

let navToken = 0;

/**
 * Abre o quadro (e a workspace) do resultado, espera carregar e então foca o alvo. Navegações sucessivas: só a
 * ÚLTIMA aplica o foco (um resultado antigo nunca foca em outro quadro). Não altera elementos nem o histórico.
 */
export async function jumpTo(doc: SearchDoc): Promise<'ok' | 'stale' | 'missing'> {
  const token = ++navToken;
  const stale = () => token !== navToken;
  void remember(doc.key);
  if (getState().workspaceId !== doc.workspaceId) {
    await switchWorkspace(doc.workspaceId);
    if (stale()) return 'stale';
  }
  // Sempre passa por `openBoard`, MESMO se o destino já é o quadro atual: isso invalida uma abertura anterior ainda
  // em curso (A→B carregando e o usuário escolhe um resultado em A: fica em A, não em B).
  const opened = await openBoard(doc.boardId);
  if (stale() || opened === 'superseded') return 'stale';
  if (getState().boardId !== doc.boardId) { toast('Não foi possível abrir o quadro deste resultado.', 'error'); return 'missing'; }
  if (doc.kind === 'board') return 'ok';
  if (doc.kind === 'checkpoint') {
    if (!getState().checkpoints.some((c) => c.id === doc.id)) { toast('Este local foi excluído desde a busca.', 'warning'); return 'missing'; }
    navigateToCheckpoint(doc.id);
    return 'ok';
  }
  if (!focusElement(doc.id)) { toast('Este item foi excluído desde a busca.', 'warning'); return 'missing'; }
  const at = Date.now();
  setState({ elementFlash: { id: doc.id, at } });
  setTimeout(() => { if (getState().elementFlash?.at === at) setState({ elementFlash: null }); }, 1700);
  return 'ok';
}

/** Testes: zera o índice. */
export function __resetIndex() { closed.clear(); metas = []; current = null; recents = []; indexRun++; status = { state: 'idle', done: 0, total: 0 }; }
