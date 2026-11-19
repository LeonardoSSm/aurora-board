/**
 * Salvamento automático com controle de revisões + diário de recuperação por quadro.
 *
 * Modelo (ver docs/PERSISTENCE.md):
 * - Toda alteração de um quadro recebe uma REVISÃO crescente (`latestRev[quadro]`).
 * - Cada gravação leva o snapshot e a revisão que ele representa. Ao concluir, `savedRev[quadro]`
 *   avança apenas até essa revisão — uma gravação antiga nunca confirma uma revisão mais nova.
 * - O diário (localStorage, síncrono) é escrito ANTES de cada gravação, uma chave por quadro, e só é
 *   apagado quando a revisão gravada é a mais recente daquele quadro.
 * - Falhas mantêm o snapshot em `failed` e o diário; novas tentativas automáticas com espera crescente.
 * - Gravações são serializadas numa fila única; a fila é recriada quando o adaptador muda.
 */
import type { AuroraElement, Board } from '../core/schema';
import { SCHEMA_VERSION } from '../core/schema';
import { getState, setState, useEditor } from '../store/editor';
import type { PersistenceAdapter } from './adapter';
import { toast } from '../store/ui';

export const JOURNAL_PREFIX = 'aurora-board-journal:';
/** Chave do diário único usada até a versão 1.0 (lida na recuperação para compatibilidade). */
export const LEGACY_JOURNAL_KEY = 'aurora-board-journal';
const DEBOUNCE_MS = 400;
const RETRY_DELAYS = [2000, 5000, 15000, 30000];

let adapter: PersistenceAdapter | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let suppressed = 0;
let lastSavedElements: AuroraElement[] | null = null;
let queue: Promise<void> = Promise.resolve();
let activeSaves = 0;
let revision = 0;
const latestRev = new Map<string, number>();
const savedRev = new Map<string, number>();
const failed = new Map<string, { board: Board; rev: number }>();

export function setAdapter(a: PersistenceAdapter) {
  adapter = a;
  // Novo adaptador = nova fila (uma gravação travada de outro adaptador não bloqueia esta).
  queue = Promise.resolve();
  activeSaves = 0;
  latestRev.clear();
  savedRev.clear();
  failed.clear();
  retryAttempt = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

export function getAdapter(): PersistenceAdapter {
  if (!adapter) throw new Error('Persistência não inicializada');
  return adapter;
}

/** Executa `fn` sem disparar salvamento (ex.: ao carregar um quadro). */
export function withoutAutosave<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

export function markLoaded(elements: AuroraElement[], _camera?: unknown) {
  lastSavedElements = elements;
}

export function snapshotCurrentBoard(): Board | null {
  const s = getState();
  const meta = s.boards.find((b) => b.id === s.boardId);
  if (!meta) return null;
  const changed = s.elements !== lastSavedElements;
  return {
    ...meta,
    camera: s.camera,
    elements: s.elements,
    updatedAt: changed ? Date.now() : meta.updatedAt,
    schemaVersion: SCHEMA_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* Diário de recuperação (localStorage, uma chave por quadro)          */
/* ------------------------------------------------------------------ */

export interface Journal { boardId: string; board: Board; at: number; rev: number }

export function writeJournal(board: Board, rev = 0): boolean {
  try {
    localStorage.setItem(JOURNAL_PREFIX + board.id, JSON.stringify({ boardId: board.id, board, at: Date.now(), rev } satisfies Journal));
    return true;
  } catch {
    return false;
  }
}

function parseJournal(raw: string | null): Journal | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Journal;
    return j && j.board && typeof j.boardId === 'string' ? j : null;
  } catch {
    return null;
  }
}

/** Todos os diários pendentes (inclui o formato antigo de chave única). */
export function readJournals(): Journal[] {
  const out: Journal[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(JOURNAL_PREFIX) || k === LEGACY_JOURNAL_KEY)) {
        const j = parseJournal(localStorage.getItem(k));
        if (j) out.push(j);
      }
    }
  } catch {
    /* localStorage indisponível */
  }
  return out;
}

export function clearJournal(boardId: string) {
  try {
    localStorage.removeItem(JOURNAL_PREFIX + boardId);
    const legacy = parseJournal(localStorage.getItem(LEGACY_JOURNAL_KEY));
    if (legacy?.boardId === boardId) localStorage.removeItem(LEGACY_JOURNAL_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

function isDirty(boardId: string) {
  return (latestRev.get(boardId) ?? 0) > (savedRev.get(boardId) ?? 0);
}

function anyDirty() {
  for (const id of latestRev.keys()) if (isDirty(id)) return true;
  return false;
}

/** Reflete o estado real: erro > salvando > pendente > salvo. */
function refreshSaveState() {
  const next = failed.size ? 'error' : activeSaves > 0 ? 'saving' : timer || anyDirty() ? 'pending' : 'saved';
  if (getState().saveState !== next) setState({ saveState: next });
}

/** Registra uma alteração no quadro atual (nova revisão) e agenda a gravação. */
export function scheduleSave() {
  if (suppressed || getState().status !== 'ready') return;
  const id = getState().boardId;
  if (!id) return;
  latestRev.set(id, ++revision);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSave(), DEBOUNCE_MS);
  refreshSaveState();
}

export function hasPendingChanges() {
  return timer !== null || activeSaves > 0 || failed.size > 0 || anyDirty();
}

function enqueue(board: Board, rev: number): Promise<void> {
  const a = adapter;
  if (!a) return Promise.resolve();
  activeSaves++;
  refreshSaveState();
  const run = async () => {
    try {
      await a.saveBoard(board);
      if (a !== adapter) return; // adaptador trocado: resultado irrelevante
      savedRev.set(board.id, Math.max(savedRev.get(board.id) ?? 0, rev));
      const f = failed.get(board.id);
      if (f && f.rev <= rev) failed.delete(board.id);
      if (board.id === getState().boardId && rev === latestRev.get(board.id)) {
        lastSavedElements = board.elements;
      }
      // Diário só é apagado se não houver revisão mais nova pendente deste quadro.
      if (!isDirty(board.id) && !failed.has(board.id)) clearJournal(board.id);
      const s = getState();
      setState({ lastSavedAt: Date.now(), boards: s.boards.map((b) => (b.id === board.id ? { ...b, updatedAt: board.updatedAt } : b)) });
      if (!failed.size) retryAttempt = 0;
    } catch (err) {
      if (a !== adapter) return;
      console.error('Falha ao salvar o quadro', board.id, err);
      if (!failed.size) {
        const quota = (err as Error)?.name === 'QuotaExceededError';
        toast(quota ? 'Armazenamento do navegador cheio: alterações guardadas só em memória/diário. Exporte um backup e libere espaço.' : 'Não foi possível salvar. Nova tentativa automática em instantes; o diário de recuperação foi mantido.', 'error', 8000);
      }
      const prev = failed.get(board.id);
      if (!prev || prev.rev <= rev) failed.set(board.id, { board, rev });
      scheduleRetry();
    } finally {
      if (a === adapter) {
        activeSaves--;
        refreshSaveState();
      }
    }
  };
  queue = queue.then(run, run);
  return queue;
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryFailed();
  }, delay);
}

async function retryFailed() {
  const current = getState().boardId;
  const jobs: Promise<void>[] = [];
  for (const [id, f] of [...failed]) {
    // Quadro aberto: grava o estado mais recente; outros: o último snapshot que falhou.
    if (id === current) jobs.push(flushSave(true));
    else jobs.push(enqueue(f.board, f.rev));
  }
  await Promise.all(jobs);
}

/**
 * Grava o quadro atual agora (cancela o debounce).
 * `force` grava mesmo sem alterações novas (usado nas novas tentativas).
 */
export async function flushSave(force = false): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const id = getState().boardId;
  const board = snapshotCurrentBoard();
  if (!board || !adapter || !id) { refreshSaveState(); return; }
  if (!isDirty(id) && !failed.has(id) && !force) { refreshSaveState(); return; }
  if (!latestRev.has(id)) latestRev.set(id, ++revision);
  const rev = latestRev.get(id)!;
  writeJournal(board, rev);
  return enqueue(board, rev);
}

/** Aguarda todas as gravações em andamento (usado antes de trocar de quadro/workspace). */
export async function drainSaves(): Promise<void> {
  await queue;
}

/**
 * Executa uma escrita de persistência fora do autosave (metadados de quadro fechado, exclusão…)
 * na MESMA fila das gravações, para nunca intercalar com um snapshot antigo do mesmo quadro.
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn, fn);
  queue = job.then(() => undefined, () => undefined);
  return job;
}

/** Esquece pendências de um quadro excluído (impede nova tentativa de recriá-lo). */
export function forgetBoard(id: string) {
  latestRev.delete(id);
  savedRev.delete(id);
  failed.delete(id);
  clearJournal(id);
  refreshSaveState();
}

/** Inicia observação do estado para salvar automaticamente. */
export function startAutosave(): () => void {
  const unsubs = [
    useEditor.subscribe((s) => s.elements, () => scheduleSave()),
    useEditor.subscribe((s) => s.camera, () => scheduleSave()),
    useEditor.subscribe((s) => s.boards, (boards, prev) => {
      // Mudanças de metadados (nome, descrição...) do quadro ativo.
      const id = getState().boardId;
      const a = boards.find((b) => b.id === id), b = prev.find((x) => x.id === id);
      if (a && b && (a.name !== b.name || a.description !== b.description || a.archived !== b.archived || a.settings !== b.settings)) scheduleSave();
    }),
  ];
  const onHide = () => {
    if (!hasPendingChanges()) return;
    // Síncrono: garante o diário de tudo que ainda não foi confirmado no IndexedDB.
    const id = getState().boardId;
    const board = snapshotCurrentBoard();
    if (board && (isDirty(id) || timer)) writeJournal(board, latestRev.get(id) ?? ++revision);
    for (const f of failed.values()) if (f.board.id !== id) writeJournal(f.board, f.rev);
    void flushSave();
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') onHide(); };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    unsubs.forEach((u) => u());
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Atualiza o indicador de salvamento (após trocar de quadro). */
export function syncSaveState() {
  refreshSaveState();
}

/** Grava o quadro atual até não restarem alterações dele (edições durante a própria gravação). */
export async function flushCurrentBoard(): Promise<void> {
  const id = getState().boardId;
  for (let i = 0; i < 5; i++) {
    await flushSave();
    // Falhou: o snapshot fica guardado (diário + nova tentativa espaçada); não insiste aqui.
    if (!id || !isDirty(id) || failed.has(id)) return;
  }
}
