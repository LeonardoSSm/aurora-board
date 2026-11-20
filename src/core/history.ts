/**
 * Histórico de desfazer/refazer baseado em snapshots imutáveis.
 *
 * Como os elementos são tratados como imutáveis (cada alteração cria um novo objeto),
 * um snapshot é apenas um array de referências — custo O(n) ponteiros, sem cópia profunda.
 */
import type { AuroraElement } from './schema';
import type { SpatialCheckpoint } from './checkpoints';

export interface HistoryEntry {
  before: AuroraElement[];
  after: AuroraElement[];
  selectionBefore: string[];
  selectionAfter: string[];
  /** Checkpoints antes/depois (só em entradas que os alteram; elementos ficam iguais). */
  checkpointsBefore?: SpatialCheckpoint[];
  checkpointsAfter?: SpatialCheckpoint[];
  /** Chave para agrupar alterações consecutivas (ex.: digitação em um widget). */
  coalesceKey?: string;
  at: number;
}

export interface HistoryStack {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export const MAX_HISTORY = 200;
const COALESCE_MS = 1200;

export function emptyHistory(): HistoryStack {
  return { undo: [], redo: [] };
}

export function pushEntry(stack: HistoryStack, entry: HistoryEntry): HistoryStack {
  if (entry.before === entry.after && entry.checkpointsBefore === entry.checkpointsAfter) return stack;
  const last = stack.undo[stack.undo.length - 1];
  if (last && entry.coalesceKey && last.coalesceKey === entry.coalesceKey && entry.at - last.at < COALESCE_MS) {
    const merged: HistoryEntry = { ...last, after: entry.after, selectionAfter: entry.selectionAfter, at: entry.at };
    return { undo: [...stack.undo.slice(0, -1), merged], redo: [] };
  }
  const undo = [...stack.undo, entry];
  if (undo.length > MAX_HISTORY) undo.splice(0, undo.length - MAX_HISTORY);
  return { undo, redo: [] };
}

export function undoStep(stack: HistoryStack): { stack: HistoryStack; entry: HistoryEntry } | null {
  const entry = stack.undo[stack.undo.length - 1];
  if (!entry) return null;
  return { stack: { undo: stack.undo.slice(0, -1), redo: [...stack.redo, entry] }, entry };
}

export function redoStep(stack: HistoryStack): { stack: HistoryStack; entry: HistoryEntry } | null {
  const entry = stack.redo[stack.redo.length - 1];
  if (!entry) return null;
  return { stack: { undo: [...stack.undo, entry], redo: stack.redo.slice(0, -1) }, entry };
}

/**
 * Elementos acrescentados POR FORA do histórico (ex.: captura rápida gravada direto num quadro fechado) passam a
 * existir em todos os retratos `before`/`after`: desfazer/refazer edições anteriores não os apaga. Retratos
 * compartilhados entre entradas continuam compartilhados (sem duplicar memória à toa).
 */
export function rebaseHistoryWith(stack: HistoryStack, added: AuroraElement[]): HistoryStack {
  if (!added.length || (!stack.undo.length && !stack.redo.length)) return stack;
  const memo = new Map<AuroraElement[], AuroraElement[]>();
  const fix = (snap: AuroraElement[]) => {
    let out = memo.get(snap);
    if (!out) {
      const have = new Set(snap.map((e) => e.id));
      const missing = added.filter((e) => !have.has(e.id));
      out = missing.length ? [...snap, ...missing] : snap;
      memo.set(snap, out);
    }
    return out;
  };
  const entry = (e: HistoryEntry): HistoryEntry => ({ ...e, before: fix(e.before), after: fix(e.after) });
  return { undo: stack.undo.map(entry), redo: stack.redo.map(entry) };
}
