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
