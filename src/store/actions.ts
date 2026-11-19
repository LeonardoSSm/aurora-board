/** Comandos do editor: toda alteração do quadro passa por aqui (histórico + vínculos + autosave). */
import type { Asset, AuroraElement, Board, BoardMeta, ElementStyle, LinearElement, LinkKind, Workspace } from '../core/schema';
import { isLinear, isText, acceptsBoundText } from '../core/schema';
import {
  cloneElements,
  createBoard as makeBoard,
  createImage,
  createLinear,
  createText,
  createWidget,
  createWorkspace as makeWorkspace,
  syncLinearBounds,
  uid,
} from '../core/elements';
import { safeExternalUrl } from '../core/aiTiles';
import { resolveLinear, updateBoundArrows, unbindDeleted } from '../core/bindings';
import { assignFrames, expandToGroups, groupElements, reorder, ungroupElements, type ReorderOp } from '../core/groups';
import { emptyHistory, pushEntry, redoStep, undoStep } from '../core/history';
import { boxesIntersect, getCommonBounds, getElementBounds, type Box, type Vec } from '../core/geometry';
import { fitShapeToText, fitTextElement } from '../core/text';
import { getState, setState, selectedSet } from './editor';
import type { Tool } from './types';
import { confirmDialog, openDialog, toast } from './ui';
import { flushCurrentBoard, flushSave, forgetBoard, getAdapter, markLoaded, runExclusive, syncSaveState, withoutAutosave } from '../persistence/autosave';
import { migrateBoard } from '../persistence/migrations';
import { findWidgetPreset, getWidget } from '../widgets/registry';
import { WIDGET } from '../core/widgetIds';

/* ================================================================== */
/* Mutação com histórico                                               */
/* ================================================================== */

function changedIds(before: AuroraElement[], after: AuroraElement[]): Set<string> {
  const map = new Map(before.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const e of after) if (map.get(e.id) !== e) out.add(e.id);
  return out;
}

/** Propaga efeitos colaterais: setas ancoradas acompanham elementos alterados. */
export function settle(before: AuroraElement[], after: AuroraElement[]): AuroraElement[] {
  if (after === before) return after;
  const ids = changedIds(before, after);
  return ids.size ? updateBoundArrows(after, ids) : after;
}

export interface CommitOptions {
  coalesceKey?: string;
  selection?: string[];
}

export function commit(mutator: (els: AuroraElement[]) => AuroraElement[], opts: CommitOptions = {}) {
  const s = getState();
  const before = s.elements;
  const raw = mutator(before);
  if (raw === before) {
    if (opts.selection) setState({ selectedIds: opts.selection });
    return;
  }
  const after = settle(before, raw);
  const selectionAfter = opts.selection ?? s.selectedIds.filter((id) => after.some((e) => e.id === id));
  const stack = s.history[s.boardId] ?? emptyHistory();
  setState({
    elements: after,
    selectedIds: selectionAfter,
    history: {
      ...s.history,
      [s.boardId]: pushEntry(stack, { before, after, selectionBefore: s.selectedIds, selectionAfter, coalesceKey: opts.coalesceKey, at: Date.now() }),
    },
  });
}

let gesture: { elements: AuroraElement[]; selection: string[] } | null = null;

/** Inicia um gesto contínuo (arrastar, redimensionar...). Alterações intermediárias não entram no histórico. */
export function beginGesture() {
  const s = getState();
  gesture = { elements: s.elements, selection: s.selectedIds };
  setState({ interacting: true });
}

export function gestureBaseline(): AuroraElement[] | null {
  return gesture?.elements ?? null;
}

export function setTransient(elements: AuroraElement[]) {
  setState({ elements });
}

export function endGesture(cancel = false) {
  const g = gesture;
  gesture = null;
  if (!g) { setState({ interacting: false }); return; }
  const s = getState();
  if (cancel) {
    setState({ elements: g.elements, interacting: false, selectedIds: g.selection });
    return;
  }
  if (s.elements === g.elements) { setState({ interacting: false }); return; }
  const stack = s.history[s.boardId] ?? emptyHistory();
  setState({
    interacting: false,
    history: {
      ...s.history,
      [s.boardId]: pushEntry(stack, { before: g.elements, after: s.elements, selectionBefore: g.selection, selectionAfter: s.selectedIds, at: Date.now() }),
    },
  });
}

/** Esquece o gesto em andamento sem restaurar nada (ex.: o quadro foi trocado no meio). */
export function abandonGesture() {
  gesture = null;
  setState({ interacting: false });
}

/** Remove um ponto de uma linha/seta (mínimo de 2 pontos). */
export function removeLinearPoint(id: string, index: number): boolean {
  const el = getState().elements.find((e) => e.id === id);
  if (!el || !isLinear(el) || el.points.length <= 2 || index < 0 || index >= el.points.length) return false;
  const abs = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py })).filter((_, i) => i !== index);
  const o = abs[0];
  const patch: Partial<LinearElement> = {
    x: o.x,
    y: o.y,
    points: abs.map((q) => [q.x - o.x, q.y - o.y] as [number, number]),
    // Remover uma ponta desfaz o vínculo daquela ponta.
    ...(index === 0 ? { startBinding: null } : {}),
    ...(index === el.points.length - 1 ? { endBinding: null } : {}),
  };
  updateElements(new Set([id]), (e) => syncLinearBounds({ ...(e as LinearElement), ...patch }));
  setState({ selectedPointIndex: null });
  return true;
}

export function canUndo() { return (getState().history[getState().boardId]?.undo.length ?? 0) > 0; }
export function canRedo() { return (getState().history[getState().boardId]?.redo.length ?? 0) > 0; }

export function undo() {
  const s = getState();
  if (s.editingTextId) return;
  const r = undoStep(s.history[s.boardId] ?? emptyHistory());
  if (!r) return;
  const ids = new Set(r.entry.before.map((e) => e.id));
  setState({ elements: r.entry.before, selectedIds: r.entry.selectionBefore.filter((id) => ids.has(id)), history: { ...s.history, [s.boardId]: r.stack } });
}

export function redo() {
  const s = getState();
  if (s.editingTextId) return;
  const r = redoStep(s.history[s.boardId] ?? emptyHistory());
  if (!r) return;
  const ids = new Set(r.entry.after.map((e) => e.id));
  setState({ elements: r.entry.after, selectedIds: r.entry.selectionAfter.filter((id) => ids.has(id)), history: { ...s.history, [s.boardId]: r.stack } });
}

/* ================================================================== */
/* Seleção                                                             */
/* ================================================================== */

export function setSelection(ids: Iterable<string>, expandGroups = true) {
  const s = getState();
  const set = expandGroups ? expandToGroups(s.elements, ids, s.editingGroupId) : new Set(ids);
  setState({ selectedIds: [...set], contextMenu: null });
}

export function clearSelection() {
  const s = getState();
  if (s.selectedIds.length || s.editingGroupId) setState({ selectedIds: [], editingGroupId: null });
}

export function selectAll() {
  const s = getState();
  setState({ selectedIds: s.elements.map((e) => e.id), editingGroupId: null });
}

export function selectedElements(): AuroraElement[] {
  const s = getState();
  const set = new Set(s.selectedIds);
  return s.elements.filter((e) => set.has(e.id));
}

/* ================================================================== */
/* Câmera                                                              */
/* ================================================================== */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function screenToWorld(p: Vec, cam = getState().camera): Vec {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
}

export function worldToScreen(p: Vec, cam = getState().camera): Vec {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y };
}

export function zoomAt(nextZoom: number, anchor?: Vec) {
  const s = getState();
  const cam = s.camera;
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const a = anchor ?? { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  setState({ camera: { zoom: z, x: a.x - ((a.x - cam.x) * z) / cam.zoom, y: a.y - ((a.y - cam.y) * z) / cam.zoom } });
}

export function zoomBy(factor: number, anchor?: Vec) {
  zoomAt(getState().camera.zoom * factor, anchor);
}

export function zoomStep(direction: 1 | -1) {
  const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
  const z = getState().camera.zoom;
  const next = direction > 0 ? steps.find((v) => v > z + 0.001) ?? MAX_ZOOM : [...steps].reverse().find((v) => v < z - 0.001) ?? MIN_ZOOM;
  zoomAt(next);
}

export function panBy(dx: number, dy: number) {
  const c = getState().camera;
  setState({ camera: { ...c, x: c.x + dx, y: c.y + dy } });
}

export function zoomToBox(box: Box, maxZoom = 1, padding = 80) {
  const { viewport } = getState();
  const w = Math.max(box.maxX - box.minX, 1), h = Math.max(box.maxY - box.minY, 1);
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((viewport.width - padding * 2) / w, (viewport.height - padding * 2) / h)));
  setState({ camera: { zoom, x: Math.round(viewport.width / 2 - ((box.minX + box.maxX) / 2) * zoom), y: Math.round(viewport.height / 2 - ((box.minY + box.maxY) / 2) * zoom) } });
}

export function zoomToFit() {
  const box = getCommonBounds(getState().elements);
  if (!box) { resetCamera(); return; }
  zoomToBox(box, 1);
}

export function zoomToSelection() {
  const box = getCommonBounds(selectedElements());
  if (!box) { zoomToFit(); return; }
  zoomToBox(box, 2);
}

/** Seleciona e enquadra um elemento (ex.: “Abrir assistente” de um AI Tile). */
export function focusElement(id: string) {
  const el = getState().elements.find((e) => e.id === id);
  if (!el) return false;
  setSelection([id], false);
  zoomToBox(getCommonBounds([el])!, 1.25);
  return true;
}

/** Abre o painel de propriedades nas configurações do widget (duplo clique / “Editar”). */
export function openWidgetInspector(id: string, section?: string) {
  const s = getState();
  setSelection([id], false);
  setState({ propertiesOpen: true, ...(s.compact ? { libraryOpen: false } : {}), inspectorFocus: { id, section, nonce: Date.now() } });
}

/** Abre um link externo em nova aba, só se for https válido. */
export function openExternalUrl(url: string) {
  const safe = safeExternalUrl(url);
  if (!safe) { toast('Link inválido: use um endereço https://', 'warning'); return false; }
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}

export function resetZoom() {
  zoomAt(1);
}

export function resetCamera() {
  const { viewport } = getState();
  // Pixel inteiro: linhas de 1px nítidas e coordenadas exatas do mouse.
  setState({ camera: { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2), zoom: 1 } });
}

export function viewportCenterWorld(): Vec {
  const { viewport } = getState();
  return screenToWorld({ x: viewport.width / 2, y: viewport.height / 2 });
}

/* ================================================================== */
/* Ferramentas e estilo                                                */
/* ================================================================== */

/** Confirma o editor de texto aberto (o blur do textarea grava o conteúdo). */
export function flushTextEditor() {
  if (typeof document === 'undefined') return;
  const el = document.activeElement as HTMLElement | null;
  if (el?.dataset?.testid === 'text-editor') el.blur();
  if (getState().editingTextId) setState({ editingTextId: null });
}

export function setTool(tool: Tool) {
  flushTextEditor();
  const s = getState();
  if (tool === 'image') {
    void pickImages();
    return;
  }
  // Como no Excalidraw: escolher uma ferramenta de desenho limpa a seleção,
  // e o painel passa a mostrar o estilo que será usado no próximo elemento.
  const keep = tool === 'select' || tool === 'hand';
  setState({ tool, contextMenu: null, bindingHint: null, eraserPending: [], hoverId: null, selectedIds: keep ? s.selectedIds : [], editingGroupId: keep ? s.editingGroupId : null });
}

export function setConnectionKind(kind: LinkKind) {
  setState({ connectionKind: kind });
}

function applyStylePatch(el: AuroraElement, patch: Partial<ElementStyle>): AuroraElement {
  const next = { ...el, style: { ...el.style, ...patch }, version: el.version + 1, updatedAt: Date.now() } as AuroraElement;
  if (isText(next)) return fitTextElement(next);
  if (next.text && acceptsBoundText(next) && !isLinear(next)) return fitShapeToText(next);
  return next;
}

export function updateStyle(patch: Partial<ElementStyle>) {
  const s = getState();
  setState({ currentStyle: { ...s.currentStyle, ...patch } });
  const ids = selectedSet(s);
  if (!ids.size) return;
  commit((els) => els.map((el) => (ids.has(el.id) && !el.locked ? applyStylePatch(el, patch) : el)));
}

export function updateElements(ids: Set<string>, fn: (el: AuroraElement) => AuroraElement, coalesceKey?: string) {
  commit((els) => {
    let changed = false;
    const out = els.map((el) => {
      if (!ids.has(el.id)) return el;
      const n = fn(el);
      if (n !== el) changed = true;
      return n === el ? el : ({ ...n, version: el.version + 1, updatedAt: Date.now() } as AuroraElement);
    });
    return changed ? out : els;
  }, { coalesceKey });
}

export function updateElement(id: string, patch: Partial<AuroraElement>, coalesceKey?: string) {
  updateElements(new Set([id]), (el) => ({ ...el, ...patch }) as AuroraElement, coalesceKey);
}

/* ================================================================== */
/* Edição de texto                                                     */
/* ================================================================== */

let pendingTextCreation: { id: string; before: AuroraElement[]; selection: string[] } | null = null;

export function startTextEdit(id: string) {
  const el = getState().elements.find((e) => e.id === id);
  if (!el || el.locked) return;
  if (!(isText(el) || acceptsBoundText(el) || el.type === 'frame')) return;
  setState({ editingTextId: id, selectedIds: [id], tool: 'select' });
}

/** Cria um texto independente no ponto (sem entrar no histórico até ser confirmado). */
export function createTextAt(world: Vec) {
  const s = getState();
  const style = { ...s.currentStyle, textAlign: 'left' as const, verticalAlign: 'top' as const };
  const el = fitTextElement(createText(world.x, world.y - (style.fontSize * 1.3) / 2, '', style));
  pendingTextCreation = { id: el.id, before: s.elements, selection: s.selectedIds };
  setState({ elements: [...s.elements, el], selectedIds: [el.id], editingTextId: el.id, tool: s.toolLocked ? s.tool : 'select' });
  return el;
}

export function commitTextEdit(id: string, text: string) {
  const s = getState();
  const pending = pendingTextCreation?.id === id ? pendingTextCreation : null;
  pendingTextCreation = null;
  const el = s.elements.find((e) => e.id === id);
  setState({ editingTextId: null });
  if (!el) return;
  if (pending) {
    // Criação de texto: entra no histórico como uma única operação.
    if (!text.trim()) {
      setState({ elements: pending.before, selectedIds: pending.selection });
      return;
    }
    const after = s.elements.map((e) => (e.id === id && isText(e) ? fitTextElement({ ...e, text }) : e));
    const stack = s.history[s.boardId] ?? emptyHistory();
    setState({
      elements: after,
      history: { ...s.history, [s.boardId]: pushEntry(stack, { before: pending.before, after, selectionBefore: pending.selection, selectionAfter: [id], at: Date.now() }) },
    });
    return;
  }
  if (el.text === text) return;
  if (isText(el) && !text.trim()) {
    commit((els) => unbindDeleted(els.filter((e) => e.id !== id), new Set([id])), { selection: [] });
    return;
  }
  commit((els) =>
    els.map((e) => {
      if (e.id !== id) return e;
      const n = { ...e, text, version: e.version + 1, updatedAt: Date.now() } as AuroraElement;
      if (isText(n)) return fitTextElement(n);
      if (!isLinear(n) && n.type !== 'frame') return fitShapeToText(n);
      return n;
    }),
  );
}

export function cancelTextEdit() {
  const s = getState();
  if (pendingTextCreation && pendingTextCreation.id === s.editingTextId) {
    const p = pendingTextCreation;
    pendingTextCreation = null;
    setState({ elements: p.before, selectedIds: p.selection, editingTextId: null });
    return;
  }
  setState({ editingTextId: null });
}

/* ================================================================== */
/* Operações sobre a seleção                                           */
/* ================================================================== */

export function addElements(newEls: AuroraElement[], select = true) {
  if (!newEls.length) return;
  const frames = newEls.filter((e) => e.type === 'frame');
  const others = newEls.filter((e) => e.type !== 'frame');
  commit(
    (els) => assignFrames([...frames, ...els, ...others], new Set(others.map((e) => e.id))),
    select ? { selection: newEls.map((e) => e.id) } : {},
  );
}

export function deleteSelected() {
  const s = getState();
  const ids = new Set(s.selectedIds.filter((id) => !s.elements.find((e) => e.id === id)?.locked));
  if (!ids.size) {
    if (s.selectedIds.length) toast('Elementos bloqueados não podem ser excluídos. Desbloqueie primeiro.', 'warning');
    return;
  }
  commit(
    (els) => unbindDeleted(els.filter((e) => !ids.has(e.id)), ids).map((e) => (e.frameId && ids.has(e.frameId) ? { ...e, frameId: null } : e)),
    { selection: [] },
  );
}

export function duplicateSelected(offset = { x: 24, y: 24 }) {
  const sel = selectedElements();
  if (!sel.length) return;
  const copies = cloneElements(sel, offset);
  commit((els) => [...els, ...copies], { selection: copies.map((c) => c.id) });
}

export function groupSelection() {
  const s = getState();
  const ids = selectedSet(s);
  if (ids.size < 2) { toast('Selecione pelo menos dois elementos para agrupar.', 'warning'); return; }
  const r = groupElements(s.elements, ids, s.editingGroupId);
  commit(() => r.elements);
  toast('Grupo criado (Ctrl+Shift+G desagrupa).', 'success');
}

export function ungroupSelection() {
  const s = getState();
  const ids = selectedSet(s);
  const next = ungroupElements(s.elements, ids, s.editingGroupId);
  if (next === s.elements) { toast('A seleção não contém grupos.', 'info'); return; }
  commit(() => next);
}

export function reorderSelection(op: ReorderOp) {
  const s = getState();
  commit((els) => reorder(els, selectedSet(s), op));
}

export function toggleLockSelection() {
  const sel = selectedElements();
  if (!sel.length) return;
  const lock = sel.some((e) => !e.locked);
  updateElements(new Set(sel.map((e) => e.id)), (el) => ({ ...el, locked: lock }));
  toast(lock ? 'Bloqueado: não pode ser movido nem editado.' : 'Desbloqueado.', 'info');
}

export function nudgeSelection(dx: number, dy: number) {
  const s = getState();
  const ids = selectedSet(s);
  if (!ids.size) return;
  updateElements(ids, (el) => (el.locked ? el : ({ ...el, x: el.x + dx, y: el.y + dy } as AuroraElement)), 'nudge');
}

export function alignSelection(mode: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom') {
  const sel = selectedElements();
  const box = getCommonBounds(sel);
  if (!box || sel.length < 2) return;
  updateElements(new Set(sel.map((e) => e.id)), (el) => {
    if (el.locked) return el;
    const b = getCommonBounds([el])!;
    let dx = 0, dy = 0;
    if (mode === 'left') dx = box.minX - b.minX;
    if (mode === 'right') dx = box.maxX - b.maxX;
    if (mode === 'center-x') dx = (box.minX + box.maxX) / 2 - (b.minX + b.maxX) / 2;
    if (mode === 'top') dy = box.minY - b.minY;
    if (mode === 'bottom') dy = box.maxY - b.maxY;
    if (mode === 'center-y') dy = (box.minY + box.maxY) / 2 - (b.minY + b.maxY) / 2;
    return { ...el, x: el.x + dx, y: el.y + dy } as AuroraElement;
  });
}

/* ================================================================== */
/* Fluxograma (Ctrl+seta) e navegação (Alt+seta)                       */
/* ================================================================== */

export type Direction = 'up' | 'down' | 'left' | 'right';
const FLOW_SHAPES = ['rectangle', 'ellipse', 'diamond', 'sticky'];
const SIDE_POINT: Record<Direction, [number, number]> = { right: [1, 0.5], left: [0, 0.5], down: [0.5, 1], up: [0.5, 0] };
const OPPOSITE: Record<Direction, Direction> = { right: 'left', left: 'right', up: 'down', down: 'up' };

/**
 * Cria um novo nó (cópia do estilo/tamanho da forma selecionada) na direção indicada,
 * já conectado por uma seta. Se o lugar estiver ocupado, desloca na perpendicular.
 */
export function createFlowchartNode(dir: Direction): boolean {
  const sel = selectedElements();
  if (sel.length !== 1 || !FLOW_SHAPES.includes(sel[0].type) || sel[0].locked) return false;
  const src = sel[0];
  const gap = 90;
  const els = getState().elements;
  const baseX = src.x + (dir === 'right' ? src.width + gap : dir === 'left' ? -(src.width + gap) : 0);
  const baseY = src.y + (dir === 'down' ? src.height + gap : dir === 'up' ? -(src.height + gap) : 0);
  const occupied = (x: number, y: number) =>
    els.some((e) => e.id !== src.id && !isLinear(e) && boxesIntersect({ minX: x, minY: y, maxX: x + src.width, maxY: y + src.height }, getElementBounds(e)));
  let x = baseX, y = baseY;
  for (let i = 1; occupied(x, y) && i < 24; i++) {
    const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
    if (dir === 'left' || dir === 'right') y = baseY + step * (src.height + 40);
    else x = baseX + step * (src.width + 40);
  }
  const node = { ...structuredClone(src), id: uid(), x, y, text: '', angle: 0, groupIds: [], frameId: null, seed: Math.floor(Math.random() * 2 ** 31), version: 1, updatedAt: Date.now() } as AuroraElement;
  const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { ...src.style, backgroundColor: 'transparent', strokeColor: src.type === 'sticky' ? '#8fa6c8' : src.style.strokeColor, strokeStyle: 'solid' });
  arrow.startBinding = { elementId: src.id, fixedPoint: SIDE_POINT[dir] };
  arrow.endBinding = { elementId: node.id, fixedPoint: SIDE_POINT[OPPOSITE[dir]] };
  // Cotovelo: continua ortogonal e legível quando os nós forem reposicionados.
  arrow.path = 'elbow';
  const byId = new Map([...els, node].map((e) => [e.id, e]));
  commit((cur) => [...cur, node, resolveLinear(arrow, byId)], { selection: [node.id] });
  return true;
}

/** Seleciona o elemento conectado (por seta) mais próximo na direção indicada. */
export function navigateConnected(dir: Direction): boolean {
  const sel = selectedElements();
  if (sel.length !== 1) return false;
  const src = sel[0];
  const els = getState().elements;
  const c = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
  let best: AuroraElement | null = null, bestScore = Infinity;
  for (const e of els) {
    if (!isLinear(e) || !e.startBinding || !e.endBinding) continue;
    const other = e.startBinding.elementId === src.id ? e.endBinding.elementId : e.endBinding.elementId === src.id ? e.startBinding.elementId : null;
    const o = other ? els.find((x) => x.id === other) : undefined;
    if (!o) continue;
    const dx = o.x + o.width / 2 - c.x, dy = o.y + o.height / 2 - c.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'right' || dir === 'left' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = o; }
  }
  if (!best) return false;
  setState({ selectedIds: [best.id] });
  return true;
}

/* ================================================================== */
/* Copiar / colar estilo                                               */
/* ================================================================== */

let copiedStyle: ElementStyle | null = null;

export function copyStyle() {
  const el = selectedElements()[0];
  if (!el) return;
  copiedStyle = { ...el.style };
  toast('Estilo copiado (Ctrl+Alt+V para aplicar).', 'info', 1600);
}

export function pasteStyle() {
  if (!copiedStyle || !getState().selectedIds.length) return;
  updateStyle(copiedStyle);
}

/* ================================================================== */
/* Área de transferência                                               */
/* ================================================================== */

export const CLIPBOARD_TYPE = 'aurora-board/clipboard';
let internalClipboard: string | null = null;
let pasteCount = 0;

export function serializeSelection(): string | null {
  const sel = selectedElements();
  if (!sel.length) return null;
  return JSON.stringify({ type: CLIPBOARD_TYPE, version: 1, elements: sel });
}

export function copySelection(e?: ClipboardEvent): boolean {
  const text = serializeSelection();
  if (!text) return false;
  internalClipboard = text;
  pasteCount = 0;
  if (e?.clipboardData) {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  } else {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }
  toast(`${selectedElements().length} elemento(s) copiado(s).`, 'info', 1600);
  return true;
}

export function cutSelection(e?: ClipboardEvent) {
  if (copySelection(e)) deleteSelected();
}

export async function pasteContent(text: string | null, files: File[], at: Vec | null) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    await insertImageFiles(images, at ?? viewportCenterWorld());
    return;
  }
  const raw = text ?? internalClipboard;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.type === CLIPBOARD_TYPE && Array.isArray(parsed.elements)) {
      const els = parsed.elements as AuroraElement[];
      const box = getCommonBounds(els)!;
      pasteCount++;
      const offset = at
        ? { x: at.x - (box.minX + box.maxX) / 2, y: at.y - (box.minY + box.maxY) / 2 }
        : { x: 24 * pasteCount, y: 24 * pasteCount };
      const copies = cloneElements(els, offset);
      commit((cur) => [...cur, ...copies], { selection: copies.map((c) => c.id) });
      return;
    }
  } catch {
    /* texto comum */
  }
  const trimmed = raw.trim();
  if (!trimmed) return;
  const pos = at ?? viewportCenterWorld();
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    addWidget(WIDGET.link, pos, { url: trimmed });
    return;
  }
  const style = { ...getState().currentStyle, textAlign: 'left' as const };
  const t = fitTextElement(createText(pos.x, pos.y, trimmed, style));
  addElements([t]);
}

/* ================================================================== */
/* Assets (imagens e documentos)                                       */
/* ================================================================== */

const assetCache = new Map<string, Asset>();
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function putAsset(blob: Blob, name = 'arquivo'): Promise<string> {
  if (blob.size > MAX_ASSET_BYTES) throw new Error(`Arquivo maior que ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
  const asset: Asset = { id: uid('a_'), mimeType: blob.type || 'application/octet-stream', dataURL: await readAsDataURL(blob), name, size: blob.size, createdAt: Date.now() };
  await getAdapter().putAsset(asset);
  assetCache.set(asset.id, asset);
  return asset.id;
}

export async function getAsset(id: string): Promise<Asset | null> {
  if (assetCache.has(id)) return assetCache.get(id)!;
  const a = await getAdapter().getAsset(id);
  if (a) assetCache.set(id, a);
  return a;
}

export function cachedAsset(id: string): Asset | undefined {
  return assetCache.get(id);
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 300, height: img.naturalHeight || 200 });
    img.onerror = () => resolve({ width: 300, height: 200 });
    img.src = src;
  });
}

export async function insertImageFiles(files: File[], at: Vec) {
  const created: AuroraElement[] = [];
  let offset = 0;
  for (const f of files) {
    try {
      const id = await putAsset(f, f.name);
      const asset = assetCache.get(id)!;
      const { width, height } = await imageSize(asset.dataURL);
      const scale = Math.min(1, 640 / width, 640 / height);
      const w = width * scale, h = height * scale;
      created.push(createImage(at.x - w / 2 + offset, at.y - h / 2 + offset, w, h, id));
      offset += 24;
    } catch (err) {
      toast(`Não foi possível inserir "${f.name}": ${(err as Error).message}`, 'error');
    }
  }
  if (created.length) {
    addElements(created);
    setState({ tool: 'select' });
  }
}

export function pickImages(at?: Vec) {
  return new Promise<void>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (files.length) await insertImageFiles(files, at ?? viewportCenterWorld());
      resolve();
    };
    input.click();
    setState({ tool: 'select' });
  });
}

/* ================================================================== */
/* Widgets                                                             */
/* ================================================================== */

export function addWidget(type: string, at?: Vec, dataPatch?: Record<string, unknown>, opts: { size?: { width: number; height: number }; title?: string; accent?: string } = {}) {
  const preset = findWidgetPreset(type);
  if (preset) return addWidget(preset.plugin.id, at, { ...(preset.preset.data as object), ...dataPatch }, { size: preset.preset.size, title: preset.preset.title ?? preset.preset.name, accent: preset.preset.accent, ...opts });
  const plugin = getWidget(type);
  if (!plugin) { toast(`Widget "${type}" não registrado.`, 'error'); return null; }
  if (plugin.status === 'planned') { toast(`${plugin.name} ainda não está disponível.`, 'warning'); return null; }
  const pos = at ?? viewportCenterWorld();
  const { width, height } = opts.size ?? plugin.defaultSize;
  const data = dataPatch ? plugin.sanitize({ ...(plugin.createData() as object), ...dataPatch }) : plugin.createData();
  const el = createWidget(plugin.id, plugin.version, opts.title ?? plugin.name, pos.x - width / 2, pos.y - height / 2, width, height, data);
  el.style.strokeColor = opts.accent ?? plugin.accent;
  addElements([el]);
  setState({ tool: 'select' });
  return el;
}

export function updateWidgetData(id: string, updater: (data: unknown) => unknown, coalesce = false) {
  commit(
    (els) => els.map((e) => (e.id === id && e.type === 'widget' ? { ...e, data: updater(e.data), version: e.version + 1, updatedAt: Date.now() } : e)),
    coalesce ? { coalesceKey: `widget:${id}` } : {},
  );
}

/* ================================================================== */
/* Quadros e workspaces                                                */
/* ================================================================== */

async function persistWorkspace(ws: Workspace) {
  await getAdapter().saveWorkspace(ws);
  const s = getState();
  setState({ workspaces: s.workspaces.map((w) => (w.id === ws.id ? ws : w)) });
}

function currentWorkspace(): Workspace {
  const s = getState();
  return s.workspaces.find((w) => w.id === s.workspaceId)!;
}

function orderBoards(metas: BoardMeta[], ws: Workspace): BoardMeta[] {
  const idx = new Map(ws.boardOrder.map((id, i) => [id, i]));
  return [...metas].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9) || a.createdAt - b.createdAt);
}

export async function refreshBoards() {
  const s = getState();
  const ws = currentWorkspace();
  const metas = await getAdapter().listBoards(s.workspaceId);
  setState({ boards: orderBoards(metas, ws) });
}

export async function openBoard(id: string) {
  const s = getState();
  if (s.boardId === id && s.status === 'ready') return;
  flushTextEditor();
  abandonGesture();
  await flushCurrentBoard();
  const raw = await getAdapter().loadBoard(id);
  if (!raw) { toast('Quadro não encontrado.', 'error'); return; }
  // Dados lidos do armazenamento passam pela mesma validação/reparo da importação.
  const { board, warnings } = migrateBoard(raw, raw.workspaceId);
  if (warnings.length) {
    console.warn('Quadro reparado ao abrir:', warnings);
    // Guarda o original (uma vez) antes que a próxima gravação substitua os dados reparados.
    const key = `backup-before-repair:${raw.id}`;
    if (!(await getAdapter().getSetting(key))) await getAdapter().setSetting(key, { savedAt: Date.now(), board: raw });
    toast(`${warnings.length} problema(s) de integridade corrigido(s) neste quadro. Detalhes no console.`, 'warning', 6000);
  }
  withoutAutosave(() =>
    setState({
      boardId: board.id,
      elements: board.elements,
      camera: board.camera,
      selectedIds: [],
      editingGroupId: null,
      editingTextId: null,
      contextMenu: null,
      tool: 'select',
    }),
  );
  markLoaded(board.elements, board.camera);
  syncSaveState();
  await getAdapter().setSetting(`lastBoard:${board.workspaceId}`, board.id);
}

export async function createBoard(name: string, description = '', open = true): Promise<Board> {
  const s = getState();
  const b = makeBoard(s.workspaceId, name || 'Novo quadro', description);
  b.camera = { x: Math.round(s.viewport.width / 2), y: Math.round(s.viewport.height / 2), zoom: 1 };
  await getAdapter().saveBoard(b);
  const ws = currentWorkspace();
  await persistWorkspace({ ...ws, boardOrder: [...ws.boardOrder, b.id], updatedAt: Date.now() });
  await refreshBoards();
  if (open) await openBoard(b.id);
  return b;
}

export async function updateBoardMeta(id: string, patch: Partial<Pick<BoardMeta, 'name' | 'description' | 'archived' | 'settings'>>) {
  const s = getState();
  setState({ boards: s.boards.map((b) => (b.id === id ? { ...b, ...patch, updatedAt: Date.now() } : b)) });
  if (id !== s.boardId) {
    // Na fila de gravações: nunca intercala com um snapshot antigo do mesmo quadro.
    await runExclusive(async () => {
      const board = await getAdapter().loadBoard(id);
      if (board) await getAdapter().saveBoard({ ...board, ...patch, updatedAt: Date.now() });
    });
  }
}

export async function duplicateBoard(id: string) {
  await flushSave();
  const board = await getAdapter().loadBoard(id);
  if (!board) return;
  const copy: Board = {
    ...structuredClone(board),
    id: uid('b_'),
    name: `${board.name} (cópia)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
  };
  await getAdapter().saveBoard(copy);
  const ws = currentWorkspace();
  const order = [...ws.boardOrder];
  order.splice(Math.max(0, order.indexOf(id)) + 1, 0, copy.id);
  await persistWorkspace({ ...ws, boardOrder: order });
  await refreshBoards();
  await openBoard(copy.id);
  toast('Quadro duplicado.', 'success');
}

export async function setBoardArchived(id: string, archived: boolean) {
  await updateBoardMeta(id, { archived });
  const s = getState();
  if (archived && id === s.boardId) {
    await flushSave();
    const next = s.boards.find((b) => !b.archived && b.id !== id);
    if (next) await openBoard(next.id);
    else await createBoard('Novo quadro');
  }
  toast(archived ? 'Quadro arquivado.' : 'Quadro restaurado.', 'success');
}

export async function deleteBoard(id: string) {
  const s = getState();
  const meta = s.boards.find((b) => b.id === id);
  if (!meta) return;
  const ok = await confirmDialog('Excluir quadro', `Excluir "${meta.name}" permanentemente? Esta ação não pode ser desfeita. Exporte um backup antes se quiser guardar uma cópia.`, 'Excluir', true);
  if (!ok) return;
  if (id === s.boardId) await flushSave();
  forgetBoard(id);
  await runExclusive(() => getAdapter().deleteBoard(id));
  const ws = currentWorkspace();
  await persistWorkspace({ ...ws, boardOrder: ws.boardOrder.filter((b) => b !== id) });
  const h = { ...getState().history };
  delete h[id];
  setState({ history: h });
  await refreshBoards();
  if (id === s.boardId) {
    const next = getState().boards.find((b) => !b.archived);
    if (next) await openBoard(next.id);
    else await createBoard('Novo quadro');
  }
  toast('Quadro excluído.', 'success');
}

export async function moveBoard(id: string, direction: -1 | 1) {
  const ws = currentWorkspace();
  const order = getState().boards.map((b) => b.id);
  const i = order.indexOf(id), j = i + direction;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await persistWorkspace({ ...ws, boardOrder: order });
  await refreshBoards();
}

export async function createWorkspace(name: string) {
  await flushSave();
  const ws = makeWorkspace(name || 'Novo workspace');
  await getAdapter().saveWorkspace(ws);
  setState({ workspaces: [...getState().workspaces, ws] });
  await switchWorkspace(ws.id);
}

export async function switchWorkspace(id: string) {
  await flushSave();
  setState({ workspaceId: id, boards: [], boardId: '' });
  await getAdapter().setSetting('lastWorkspace', id);
  await refreshBoards();
  const boards = getState().boards.filter((b) => !b.archived);
  const last = await getAdapter().getSetting<string>(`lastBoard:${id}`);
  const target = boards.find((b) => b.id === last) ?? boards[0];
  if (target) await openBoard(target.id);
  else await createBoard('Meu primeiro quadro');
}

export async function renameWorkspace(id: string, name: string) {
  const ws = getState().workspaces.find((w) => w.id === id);
  if (!ws || !name.trim()) return;
  await getAdapter().saveWorkspace({ ...ws, name: name.trim(), updatedAt: Date.now() });
  setState({ workspaces: getState().workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() } : w)) });
}

export async function deleteWorkspace(id: string) {
  const s = getState();
  if (s.workspaces.length <= 1) { toast('Mantenha pelo menos um workspace.', 'warning'); return; }
  const ws = s.workspaces.find((w) => w.id === id);
  const ok = await confirmDialog('Excluir workspace', `Excluir "${ws?.name}" e TODOS os seus quadros permanentemente? Esta ação não pode ser desfeita.`, 'Excluir tudo', true);
  if (!ok) return;
  await getAdapter().deleteWorkspace(id);
  const rest = s.workspaces.filter((w) => w.id !== id);
  setState({ workspaces: rest });
  if (id === s.workspaceId) await switchWorkspace(rest[0].id);
}

/* ================================================================== */
/* Utilidades usadas pelo canvas                                       */
/* ================================================================== */

export function findElement(id: string) {
  return getState().elements.find((e) => e.id === id);
}

export function enterGroup(groupId: string | null) {
  setState({ editingGroupId: groupId });
}

export async function showInfo(title: string, message: string) {
  await openDialog({ title, message, buttons: [{ label: 'Ok', value: 'ok', variant: 'primary' }] });
}
