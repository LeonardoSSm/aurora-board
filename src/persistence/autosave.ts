/**
 * Salvamento automático + diário de recuperação.
 *
 * - Toda alteração agenda um salvamento no IndexedDB (debounce de 400 ms).
 * - Antes de cada gravação, o quadro é escrito de forma síncrona num "diário" no localStorage.
 *   Se o navegador fechar antes do IndexedDB confirmar, o diário é recuperado na próxima abertura.
 * - O diário só é limpo depois que a gravação no IndexedDB for confirmada.
 */
import type { AuroraElement, Board } from '../core/schema';
import { SCHEMA_VERSION } from '../core/schema';
import { getState, setState, useEditor } from '../store/editor';
import type { PersistenceAdapter } from './adapter';

export const JOURNAL_KEY = 'aurora-board-journal';
const DEBOUNCE_MS = 400;

let adapter: PersistenceAdapter | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let suppressed = 0;
let lastSavedElements: AuroraElement[] | null = null;
let lastSavedCamera: unknown = null;
let inflight: Promise<void> = Promise.resolve();

export function setAdapter(a: PersistenceAdapter) { adapter = a; }
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

export function markLoaded(elements: AuroraElement[], camera: unknown) {
  lastSavedElements = elements;
  lastSavedCamera = camera;
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

interface Journal { boardId: string; board: Board; at: number }

export function writeJournal(board: Board): boolean {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify({ boardId: board.id, board, at: Date.now() } satisfies Journal));
    return true;
  } catch {
    return false;
  }
}

export function readJournal(): Journal | null {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Journal;
    return j && j.board && typeof j.boardId === 'string' ? j : null;
  } catch {
    return null;
  }
}

export function clearJournal() {
  try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignore */ }
}

export function scheduleSave() {
  if (suppressed || getState().status !== 'ready') return;
  if (getState().saveState !== 'pending') setState({ saveState: 'pending' });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSave(), DEBOUNCE_MS);
}

export function hasPendingChanges() {
  return timer !== null || getState().saveState === 'pending' || getState().saveState === 'saving';
}

export async function flushSave(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const board = snapshotCurrentBoard();
  if (!board || !adapter) return;
  if (board.elements === lastSavedElements && board.camera === lastSavedCamera && getState().saveState === 'saved') return;
  const journaled = writeJournal(board);
  setState({ saveState: 'saving' });
  const a = adapter;
  inflight = inflight.then(async () => {
    try {
      await a.saveBoard(board);
      lastSavedElements = board.elements;
      lastSavedCamera = board.camera;
      const s = getState();
      setState({
        saveState: timer ? 'pending' : 'saved',
        lastSavedAt: Date.now(),
        boards: s.boards.map((b) => (b.id === board.id ? { ...b, updatedAt: board.updatedAt } : b)),
      });
      if (journaled) clearJournal();
    } catch (err) {
      console.error('Falha ao salvar', err);
      setState({ saveState: 'error' });
    }
  });
  return inflight;
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
    const board = snapshotCurrentBoard();
    if (board) writeJournal(board);
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
