/**
 * Ações de checkpoints. Criar, editar, excluir, duplicar, mover e reordenar entram no MESMO histórico
 * de desfazer/refazer do quadro (a entrada guarda os checkpoints antes/depois; os elementos não mudam).
 * Navegar NÃO entra no histórico (mover a câmera nunca foi desfazível).
 */
import { createCheckpoint, patchCheckpoint, type CheckpointPatch, type SpatialCheckpoint } from '../core/checkpoints';
import { cameraCenter } from '../core/camera';
import { emptyHistory, pushEntry } from '../core/history';
import { uid } from '../core/elements';
import type { Vec } from '../core/geometry';
import { getState, setState } from './editor';
import { cameraTarget, panToWorldPoint } from './cameraMotion';
import { updateBoardMeta } from './actions';
import { toast } from './ui';

function commitCheckpoints(next: SpatialCheckpoint[]) {
  const s = getState();
  if (next === s.checkpoints) return;
  const stack = s.history[s.boardId] ?? emptyHistory();
  setState({
    checkpoints: next,
    history: {
      ...s.history,
      [s.boardId]: pushEntry(stack, { before: s.elements, after: s.elements, selectionBefore: s.selectedIds, selectionAfter: s.selectedIds, checkpointsBefore: s.checkpoints, checkpointsAfter: next, at: Date.now() }),
    },
  });
}

/** Centro da área visível, em coordenadas do mundo. */
export function viewCenterWorld(): Vec {
  const s = getState();
  return cameraCenter(s.camera, s.viewport);
}

export function addCheckpoint(fields: Omit<CheckpointPatch, 'x' | 'y'> & { name: string; x: number; y: number }): string | null {
  const name = fields.name.trim();
  if (!name) return null;
  try {
    const cp = createCheckpoint({ ...fields, name }, uid('cp_'));
    commitCheckpoints([...getState().checkpoints, cp]);
    return cp.id;
  } catch {
    return null;
  }
}

/** Devolve false (sem alterar nada) se a edição deixar o checkpoint inválido. */
export function updateCheckpoint(id: string, patch: CheckpointPatch): boolean {
  const s = getState();
  const cur = s.checkpoints.find((c) => c.id === id);
  if (!cur) return false;
  const next = patchCheckpoint(cur, patch);
  if (!next) return false;
  commitCheckpoints(s.checkpoints.map((c) => (c.id === id ? next : c)));
  return true;
}

export function deleteCheckpoint(id: string) {
  const s = getState();
  if (!s.checkpoints.some((c) => c.id === id)) return;
  commitCheckpoints(s.checkpoints.filter((c) => c.id !== id));
  if (s.checkpointEditor?.mode === 'edit' && s.checkpointEditor.id === id) setState({ checkpointEditor: null });
}

export function duplicateCheckpoint(id: string): string | null {
  const s = getState();
  const cur = s.checkpoints.find((c) => c.id === id);
  if (!cur) return null;
  const copy = createCheckpoint({ ...cur, name: `${cur.name} (cópia)`.slice(0, 60) }, uid('cp_'));
  const i = s.checkpoints.indexOf(cur);
  commitCheckpoints([...s.checkpoints.slice(0, i + 1), copy, ...s.checkpoints.slice(i + 1)]);
  return copy.id;
}

/** “Mover destino”: o checkpoint passa a apontar para o centro da visão atual. */
export function moveCheckpointToView(id: string) {
  const c = viewCenterWorld();
  return updateCheckpoint(id, { x: c.x, y: c.y });
}

export function reorderCheckpoint(id: string, delta: -1 | 1) {
  const list = [...getState().checkpoints];
  const i = list.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  commitCheckpoints(list);
}

/** Centraliza o checkpoint (zoom atual por padrão; o memorizado se “restaurar zoom” estiver ligado). */
export function navigateToCheckpoint(id: string) {
  const s = getState();
  const cp = s.checkpoints.find((c) => c.id === id);
  if (!cp) return;
  const zoom = cp.restoreZoom && cp.savedZoom ? cp.savedZoom : cameraTarget().zoom;
  if (s.compact) setState({ locationsOpen: false });
  const boardId = s.boardId;
  panToWorldPoint({ x: cp.x, y: cp.y }, {
    zoom,
    onDone: () => { if (getState().boardId === boardId) setState({ checkpointFlash: { id, at: Date.now() } }); },
  });
}

export function openCheckpointCreate(world?: Vec) {
  const s = getState();
  const p = world ?? viewCenterWorld();
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { toast('Posição inválida.', 'error'); return; }
  setState({ checkpointEditor: { mode: 'create', x: p.x, y: p.y, zoom: s.camera.zoom }, contextMenu: null });
}

export function openCheckpointEdit(id: string) {
  setState({ checkpointEditor: { mode: 'edit', id }, contextMenu: null });
}

export function setCheckpointIndicators(show: boolean) {
  const s = getState();
  const b = s.boards.find((x) => x.id === s.boardId);
  if (b) void updateBoardMeta(b.id, { settings: { ...b.settings, showCheckpointIndicators: show } });
}
