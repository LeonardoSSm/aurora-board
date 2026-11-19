/**
 * Controlador de interação do canvas (máquina de estados de ponteiro).
 *
 * Toda coordenada é convertida para o espaço do mundo antes de qualquer cálculo,
 * então desenho, seleção e transformações são consistentes em qualquer zoom.
 */
import type { AuroraElement, Binding, FreedrawElement, LinearElement, LinkKind, ShapeElement } from '../core/schema';
import { isBindable, isLinear, acceptsBoundText } from '../core/schema';
import {
  boxContains,
  boxesIntersect,
  dist,
  elementCenter,
  getCommonBounds,
  getElementAtPoint,
  getElementBounds,
  hitTest,
  linearSegmentMidpoint,
  nearestConnectionPoint,
  snap,
  type Box,
  type Vec,
} from '../core/geometry';
import { createFreedraw, createLinear, createShape, cloneElements, normalizeFreedraw, syncLinearBounds } from '../core/elements';
import { resolveLinear, unbindDeleted, updateBoundArrows } from '../core/bindings';
import { assignFrames, expandToGroups, selectableGroupId, withFrameChildren } from '../core/groups';
import { resizeMultiple, resizeSingle, rotateElements, type Handle } from '../core/transform';
import { fitShapeToText, fitTextElement } from '../core/text';
import { snapBox } from '../core/snapping';
import { connectionStyle } from '../core/connectionStyle';
import { getState, setState, selectedSet, useEditor } from '../store/editor';
import {
  abandonGesture,
  beginGesture,
  commit,
  createTextAt,
  endGesture,
  gestureBaseline,
  screenToWorld,
  setSelection,
  setTransient,
  startTextEdit,
  zoomAt,
} from '../store/actions';
import { toast } from '../store/ui';
import { hitHandle, linearHandles, transformHandles } from './handles';

export interface PointerInfo {
  screen: Vec;
  world: Vec;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  pointerType: string;
  pointerId: number;
  pressure: number;
}

type Gesture =
  | { type: 'pan'; start: Vec; camera: { x: number; y: number } }
  | { type: 'marquee'; start: Vec; base: string[] }
  | { type: 'move'; start: Vec; ids: Set<string>; started: boolean; alt: boolean; hitId: string; wasSelected: boolean; shift: boolean; targets?: Box[]; clickSelect?: string | null }
  | { type: 'resize'; handle: Handle; initials: AuroraElement[]; box: Box }
  | { type: 'rotate'; center: Vec; startAngle: number; initials: AuroraElement[] }
  | { type: 'create-shape'; id: string; start: Vec; moved: boolean }
  | { type: 'create-linear'; id: string; start: Vec; moved: boolean; connect: boolean }
  | { type: 'linear-point'; id: string; index: number }
  | { type: 'linear-insert'; id: string; segment: number; startScreen: Vec }
  | { type: 'freedraw'; id: string; origin: Vec }
  | { type: 'erase' }
  | { type: 'pinch'; startDist: number; startZoom: number; startCenter: Vec; camera: { x: number; y: number } };

let gesture: Gesture | null = null;
const touches = new Map<number, Vec>();
let spaceHeld = false;

export function setSpaceHeld(v: boolean) { spaceHeld = v; }
export function isSpaceHeld() { return spaceHeld; }
export function currentGesture() { return gesture; }

const tolerance = () => 6 / getState().camera.zoom;

export { connectionStyle };
const CONNECTION_COLORS = { visual: connectionStyle('visual'), context: connectionStyle('context'), data: connectionStyle('data'), execution: connectionStyle('execution') };

function snapPoint(p: Vec): Vec {
  const s = getState();
  const meta = s.boards.find((b) => b.id === s.boardId);
  if (!meta?.settings.snapToGrid) return p;
  const g = meta.settings.gridSize;
  return { x: snap(p.x, g), y: snap(p.y, g) };
}

/** Elemento sob o ponteiro, respeitando a seleção atual (área interna de selecionados conta). */
export function elementAt(world: Vec, filter?: (el: AuroraElement) => boolean): AuroraElement | null {
  const s = getState();
  return getElementAtPoint(s.elements, world, tolerance(), { selectedIds: selectedSet(s), filter });
}

/** Alvo de ancoragem sob o ponteiro (para setas/conexões). */
export function bindingTargetAt(world: Vec, excludeId?: string): Binding | null {
  const s = getState();
  const z = s.camera.zoom;
  const el = getElementAtPoint(s.elements, world, 10 / z, {
    filter: (e) => e.id !== excludeId && isBindable(e),
    selectedIds: new Set(s.elements.filter((e) => isBindable(e)).map((e) => e.id)),
  });
  if (!el) return null;
  return { elementId: el.id, fixedPoint: nearestConnectionPoint(el, world, 14 / z) };
}

/* ------------------------------------------------------------------ */

export function pointerDown(p: PointerInfo) {
  const s = getState();
  if (s.contextMenu) setState({ contextMenu: null });

  if (p.pointerType === 'touch') {
    touches.set(p.pointerId, p.screen);
    if (touches.size === 2) {
      if (gesture && gesture.type !== 'pan') endGesture(true);
      const [a, b] = [...touches.values()];
      gesture = { type: 'pinch', startDist: dist(a, b), startZoom: s.camera.zoom, startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, camera: { x: s.camera.x, y: s.camera.y } };
      return;
    }
  }

  if (p.button === 1 || spaceHeld || s.tool === 'hand') {
    gesture = { type: 'pan', start: p.screen, camera: { x: s.camera.x, y: s.camera.y } };
    return;
  }
  if (p.button !== 0) return;

  const world = p.world;
  switch (s.tool) {
    case 'select':
      return selectDown(p);
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
    case 'frame':
    case 'sticky': {
      beginGesture();
      const start = snapPoint(world);
      const el = createShape(s.tool, start.x, start.y, 1, 1, s.tool === 'sticky' || s.tool === 'frame' ? {} : s.currentStyle);
      setTransient(s.tool === 'frame' ? [el, ...s.elements] : [...s.elements, el]);
      setState({ selectedIds: [el.id] });
      gesture = { type: 'create-shape', id: el.id, start, moved: false };
      return;
    }
    case 'line':
    case 'arrow':
    case 'connect': {
      if (draft) { draftClick(p); return; }
      const connect = s.tool === 'connect';
      const binding = bindingTargetAt(world);
      if (connect && !binding) {
        toast('Conexão: comece sobre um elemento e solte sobre outro.', 'info');
        return;
      }
      beginGesture();
      const kind: LinkKind = connect ? s.connectionKind : 'visual';
      const style = connect
        ? { ...s.currentStyle, strokeColor: CONNECTION_COLORS[kind].stroke, strokeStyle: CONNECTION_COLORS[kind].dash, roughness: 0, strokeWidth: 2 }
        : s.currentStyle;
      const start = binding ? world : snapPoint(world);
      const el = createLinear(s.tool === 'line' ? 'line' : 'arrow', start.x, start.y, [[0, 0], [0, 0]], style, kind);
      el.startBinding = binding;
      // Setas usam o tipo de traçado escolhido (padrão: curva, como no Excalidraw); linhas são poligonais.
      el.path = s.tool === 'line' ? 'straight' : s.currentArrowPath;
      setTransient([...s.elements, el]);
      setState({ selectedIds: [el.id] });
      gesture = { type: 'create-linear', id: el.id, start, moved: false, connect };
      return;
    }
    case 'freedraw': {
      beginGesture();
      const el = createFreedraw(world.x, world.y, s.currentStyle);
      el.simulatePressure = p.pointerType !== 'pen';
      el.points = [[0, 0, p.pointerType === 'pen' ? p.pressure : 0.5]];
      setTransient([...s.elements, el]);
      gesture = { type: 'freedraw', id: el.id, origin: world };
      return;
    }
    case 'text': {
      const hit = elementAt(world);
      if (hit && (hit.type === 'text' || (acceptsBoundText(hit) && !isLinear(hit)))) startTextEdit(hit.id);
      else createTextAt(world);
      return;
    }
    case 'eraser': {
      gesture = { type: 'erase' };
      eraseAt(world);
      return;
    }
    default:
      return;
  }
}

function selectDown(p: PointerInfo) {
  const s = getState();
  const selected = s.elements.filter((e) => s.selectedIds.includes(e.id));

  // 1) Alças de setas selecionadas
  if (selected.length === 1 && isLinear(selected[0])) {
    const h = hitHandle(linearHandles(selected[0], s.camera), p.screen, 10);
    if (h) {
      beginGesture();
      if (h.kind === 'point') {
        setState({ selectedPointIndex: h.index });
        gesture = { type: 'linear-point', id: selected[0].id, index: h.index };
      } else {
        gesture = { type: 'linear-insert', id: selected[0].id, segment: h.index, startScreen: p.screen };
      }
      return;
    }
  }
  // 2) Alças de redimensionar/rotacionar
  const th = hitHandle(transformHandles(selected, s.camera), p.screen, 9);
  if (th) {
    beginGesture();
    const box = getCommonBounds(selected)!;
    if (th.kind === 'rotate') {
      const center = selected.length === 1 ? elementCenter(selected[0]) : { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      gesture = { type: 'rotate', center, startAngle: Math.atan2(p.world.y - center.y, p.world.x - center.x), initials: selected };
    } else {
      gesture = { type: 'resize', handle: th.handle!, initials: selected, box };
    }
    return;
  }
  // 3) Dentro da caixa da seleção atual (como no Excalidraw): arrastar move a SELEÇÃO, mesmo que outro
  //    elemento esteja por cima; um clique sem arrastar seleciona o elemento de cima.
  const hit = elementAt(p.world);
  if (!p.shift && !p.ctrl && selected.length && !selected.every((e) => e.type === 'frame') && insideSelection(selected, p.world) && (!hit || !s.selectedIds.includes(hit.id))) {
    const ids = withFrameChildren(s.elements, new Set(s.selectedIds));
    gesture = { type: 'move', start: p.world, ids, started: false, alt: p.alt, hitId: selected[0].id, wasSelected: true, shift: false, clickSelect: hit?.id ?? null };
    return;
  }
  // 4) Elementos
  if (hit) {
    const already = s.selectedIds.includes(hit.id);
    if (s.editingGroupId && !hit.groupIds.includes(s.editingGroupId)) setState({ editingGroupId: null });
    if (p.shift || p.ctrl) {
      const group = expandToGroups(getState().elements, [hit.id], getState().editingGroupId);
      const cur = new Set(s.selectedIds);
      const remove = [...group].every((id) => cur.has(id));
      for (const id of group) remove ? cur.delete(id) : cur.add(id);
      setState({ selectedIds: [...cur] });
      if (remove) return;
    } else if (!already) {
      setSelection([hit.id]);
    }
    const ids = withFrameChildren(getState().elements, new Set(getState().selectedIds));
    gesture = { type: 'move', start: p.world, ids, started: false, alt: p.alt, hitId: hit.id, wasSelected: already, shift: p.shift || p.ctrl };
    return;
  }
  // 5) Fundo: seleção por área
  if (!p.shift) setState({ selectedIds: [], editingGroupId: null });
  gesture = { type: 'marquee', start: p.world, base: p.shift ? s.selectedIds : [] };
}

/* ------------------------------------------------------------------ */

export function pointerMove(p: PointerInfo) {
  const s = getState();
  if (p.pointerType === 'touch' && touches.has(p.pointerId)) touches.set(p.pointerId, p.screen);
  const g = gesture;
  if (!g) {
    if (draft) {
      const el = s.elements.find((e) => e.id === draft!.id) as LinearElement | undefined;
      if (el) setTransient(s.elements.map((e) => (e.id === el.id ? moveLinearPoint(el, el.points.length - 1, p) : e)));
      return;
    }
    updateHover(p);
    return;
  }
  switch (g.type) {
    case 'pinch': {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()];
      const d = dist(a, b), center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setState({ camera: { ...s.camera, x: g.camera.x + center.x - g.startCenter.x, y: g.camera.y + center.y - g.startCenter.y } });
      zoomAt(g.startZoom * (d / Math.max(g.startDist, 1)), center);
      return;
    }
    case 'pan':
      setState({ camera: { ...s.camera, x: g.camera.x + p.screen.x - g.start.x, y: g.camera.y + p.screen.y - g.start.y } });
      return;
    case 'marquee': {
      const box: Box = { minX: Math.min(g.start.x, p.world.x), minY: Math.min(g.start.y, p.world.y), maxX: Math.max(g.start.x, p.world.x), maxY: Math.max(g.start.y, p.world.y) };
      const inside = s.elements.filter((e) => boxContains(box, getElementBounds(e))).map((e) => e.id);
      const expanded = expandToGroups(s.elements, inside, s.editingGroupId);
      // Grupos só entram se completamente contidos.
      const full = [...expanded].filter((id) => {
        const el = s.elements.find((e) => e.id === id)!;
        const gid = selectableGroupId(el, s.editingGroupId);
        return !gid || s.elements.filter((e) => e.groupIds.includes(gid)).every((m) => inside.includes(m.id));
      });
      setState({ marquee: box, selectedIds: [...new Set([...g.base, ...full])] });
      return;
    }
    case 'move':
      return moveSelection(g, p);
    case 'resize': {
      const baseline = gestureBaseline();
      if (!baseline) return;
      const pt = snapPoint(p.world);
      let changed: AuroraElement[];
      if (g.initials.length === 1) {
        const el = g.initials[0];
        const keepAspect = el.type === 'image' ? !p.shift : p.shift;
        let r = resizeSingle(el, g.handle, pt, { keepAspect, fromCenter: p.alt });
        // Como no Excalidraw: a forma não encolhe abaixo da altura do texto (que se requebra na nova largura).
        // Texto independente: altura sempre vem do conteúdo (requebra na nova largura / nova fonte).
        if (r.type === 'text') r = fitTextElement(r);
        else if (r.text && acceptsBoundText(r) && !isLinear(r)) {
          const fitted = fitShapeToText(r, { growWidth: false });
          if (fitted.height !== r.height && g.handle.includes('n')) fitted.y = r.y + r.height - fitted.height;
          r = fitted;
        }
        changed = [r];
      } else {
        changed = resizeMultiple(g.initials, g.box, g.handle, pt);
      }
      applyChanged(baseline, changed);
      return;
    }
    case 'rotate': {
      const baseline = gestureBaseline();
      if (!baseline) return;
      let delta = Math.atan2(p.world.y - g.center.y, p.world.x - g.center.x) - g.startAngle;
      if (p.shift) {
        const step = Math.PI / 12;
        const base = g.initials.length === 1 ? g.initials[0].angle : 0;
        delta = Math.round((base + delta) / step) * step - base;
      }
      applyChanged(baseline, rotateElements(g.initials, g.center, delta));
      return;
    }
    case 'create-shape': {
      const el = s.elements.find((e) => e.id === g.id) as ShapeElement | undefined;
      if (!el) return;
      const cur = snapPoint(p.world);
      let w = cur.x - g.start.x, h = cur.y - g.start.y;
      if (Math.abs(w) + Math.abs(h) > 4 / s.camera.zoom) g.moved = true;
      if (p.shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      let x = w < 0 ? g.start.x + w : g.start.x, y = h < 0 ? g.start.y + h : g.start.y;
      if (p.alt) { x = g.start.x - Math.abs(w); y = g.start.y - Math.abs(h); w *= 2; h *= 2; }
      setTransient(s.elements.map((e) => (e.id === g.id ? { ...el, x, y, width: Math.max(1, Math.abs(w)), height: Math.max(1, Math.abs(h)) } : e)));
      return;
    }
    case 'create-linear': {
      const el = s.elements.find((e) => e.id === g.id) as LinearElement | undefined;
      if (!el) return;
      if (dist(g.start, p.world) > 4 / s.camera.zoom) g.moved = true;
      setTransient(s.elements.map((e) => (e.id === g.id ? moveLinearPoint(el, el.points.length - 1, p) : e)));
      return;
    }
    case 'linear-point': {
      const el = s.elements.find((e) => e.id === g.id) as LinearElement | undefined;
      if (!el) return;
      setTransient(s.elements.map((e) => (e.id === g.id ? moveLinearPoint(el, g.index, p) : e)));
      return;
    }
    case 'linear-insert': {
      const el = s.elements.find((e) => e.id === g.id) as LinearElement | undefined;
      if (!el || dist(g.startScreen, p.screen) < 3) return;
      // Insere o novo ponto no segmento e passa a arrastá-lo.
      const pts = [...el.points];
      const mid = linearSegmentMidpoint(el, g.segment);
      pts.splice(g.segment + 1, 0, [mid.x - el.x, mid.y - el.y]);
      const withPoint: LinearElement = { ...el, points: pts, bend: 0, path: el.path === 'straight' ? 'straight' : 'curved' };
      gesture = { type: 'linear-point', id: el.id, index: g.segment + 1 };
      setState({ selectedPointIndex: g.segment + 1 });
      setTransient(s.elements.map((e) => (e.id === g.id ? moveLinearPoint(withPoint, g.segment + 1, p) : e)));
      return;
    }
    case 'freedraw': {
      const el = s.elements.find((e) => e.id === g.id) as FreedrawElement | undefined;
      if (!el) return;
      const pt: [number, number, number] = [p.world.x - g.origin.x, p.world.y - g.origin.y, p.pointerType === 'pen' ? p.pressure : 0.5];
      const lastPt = el.points[el.points.length - 1];
      if (lastPt && Math.hypot(pt[0] - lastPt[0], pt[1] - lastPt[1]) < 0.8 / s.camera.zoom) return;
      setTransient(s.elements.map((e) => (e.id === g.id ? { ...el, points: [...el.points, pt], version: el.version + 1 } : e)));
      return;
    }
    case 'erase':
      eraseAt(p.world);
      return;
  }
}

/**
 * Move o ponto `index` de uma linha/seta para o ponteiro.
 * Pontas (primeiro/último ponto) se ancoram em formas; pontos internos são livres.
 * Shift: ângulos de 15° em relação ao ponto vizinho.
 */
function moveLinearPoint(el: LinearElement, index: number, p: PointerInfo): LinearElement {
  const s = getState();
  const last = el.points.length - 1;
  const isEnd = index === last, isStart = index === 0;
  let target: Binding | null = null;
  if (isStart || isEnd) {
    target = bindingTargetAt(p.world, el.id);
    const other = isEnd ? el.startBinding : el.endBinding;
    // Não ancora as duas pontas no mesmo elemento (exceto em pontos fixos diferentes).
    if (target && other?.elementId === target.elementId && !target.fixedPoint && el.points.length === 2) target = null;
  }
  let pt = target ? p.world : snapPoint(p.world);
  const abs = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  const neighbor = abs[isStart ? 1 : index - 1];
  if (p.shift && !target && neighbor) {
    const ang = Math.atan2(pt.y - neighbor.y, pt.x - neighbor.x);
    const snapAng = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    const len = dist(neighbor, pt);
    pt = { x: neighbor.x + Math.cos(snapAng) * len, y: neighbor.y + Math.sin(snapAng) * len };
  }
  abs[index] = pt;
  const origin = abs[0];
  let next: LinearElement = syncLinearBounds({
    ...el,
    x: origin.x,
    y: origin.y,
    points: abs.map((q) => [q.x - origin.x, q.y - origin.y] as [number, number]),
    ...(isStart ? { startBinding: target } : {}),
    ...(isEnd ? { endBinding: target } : {}),
  });
  next = resolveLinear(next, new Map(s.elements.map((e) => [e.id, e])));
  if (isStart || isEnd) setState({ bindingHint: target });
  return next;
}

/* ------------------------- Seta multiponto ------------------------- */

let draft: { id: string; connect: boolean } | null = null;
let draftFinishedAt = 0;

export function isDrafting() { return draft !== null; }

function draftClick(p: PointerInfo) {
  const s = getState();
  const el = s.elements.find((e) => e.id === draft!.id) as LinearElement | undefined;
  if (!el) { abortDraft(); return; }
  const pts = el.points;
  const fixed = pts[pts.length - 2];
  const lf = { x: (el.x + fixed[0]) * s.camera.zoom + s.camera.x, y: (el.y + fixed[1]) * s.camera.zoom + s.camera.y };
  // Clicar no último ponto finaliza; clicar sobre uma forma ancora e finaliza; cotovelo só tem 2 pontos.
  if (Math.hypot(lf.x - p.screen.x, lf.y - p.screen.y) < 10) { finishDraft(); return; }
  const placed = moveLinearPoint(el, pts.length - 1, p);
  if (placed.endBinding || el.path === 'elbow') {
    setTransient(s.elements.map((e) => (e.id === el.id ? placed : e)));
    finishDraft(true);
    return;
  }
  const lastPt = placed.points[placed.points.length - 1];
  setTransient(s.elements.map((e) => (e.id === el.id ? { ...placed, points: [...placed.points, [lastPt[0], lastPt[1]] as [number, number]] } : e)));
}

/**
 * Finaliza a seta multiponto (Enter, Esc, clique no último ponto, troca de ferramenta).
 * A prévia sob o cursor é descartada, a não ser que `keepLast` (clique que posicionou a ponta final).
 */
export function finishDraft(keepLast = false) {
  const d = draft;
  if (!d) return;
  draft = null;
  draftFinishedAt = performance.now();
  setState({ linearDraftId: null, bindingHint: null });
  const s = getState();
  const el = s.elements.find((e) => e.id === d.id) as LinearElement | undefined;
  if (!el) { abandonGesture(); return; }
  let points = el.points, endBinding = el.endBinding;
  if (!keepLast) { points = points.slice(0, -1); endBinding = null; }
  const tail = points[points.length - 1];
  if (points.length < 2 || (points.length === 2 && Math.hypot(tail[0], tail[1]) < 2)) { endGesture(true); return; }
  if (d.connect && (!el.startBinding || !endBinding)) {
    endGesture(true);
    toast('Conexão cancelada: termine sobre outro elemento.', 'warning');
    return;
  }
  const next = resolveLinear(syncLinearBounds({ ...el, points, endBinding }), new Map(s.elements.map((e) => [e.id, e])));
  setTransient(s.elements.map((e) => (e.id === el.id ? next : e)));
  endGesture();
  finishCreation(el.id, false);
}

/** Descarta a seta em criação (ex.: Ctrl+Z durante o rascunho). */
export function abortDraft() {
  if (!draft) return;
  draft = null;
  setState({ linearDraftId: null, bindingHint: null });
  endGesture(true);
}

// Trocar de ferramenta finaliza a seta em criação.
useEditor.subscribe((st) => st.tool, (tool) => { if (draft && tool !== 'arrow' && tool !== 'line' && tool !== 'connect') finishDraft(); });
// Mudar a seleção limpa o ponto selecionado.
useEditor.subscribe((st) => st.selectedIds, () => { if (getState().selectedPointIndex !== null) setState({ selectedPointIndex: null }); });

/** O ponto está dentro da caixa da seleção (rotacionada para um único elemento)? Frames não contam. */
function insideSelection(selected: AuroraElement[], world: Vec): boolean {
  const own = selected.filter((e) => e.type !== 'frame');
  if (!own.length) return false;
  if (own.length === 1) return hitTest(own[0], world, tolerance(), true);
  const b = getCommonBounds(own)!;
  return world.x >= b.minX && world.x <= b.maxX && world.y >= b.minY && world.y <= b.maxY;
}

function applyChanged(baseline: AuroraElement[], changed: AuroraElement[]) {
  const map = new Map(changed.map((e) => [e.id, e]));
  const next = baseline.map((e) => map.get(e.id) ?? e);
  setTransient(updateBoundArrows(next, new Set(map.keys())));
}

function moveSelection(g: Extract<Gesture, { type: 'move' }>, p: PointerInfo) {
  const s = getState();
  if (!g.started) {
    if (dist(g.start, p.world) * s.camera.zoom < 3) return;
    const locked = s.elements.filter((e) => g.ids.has(e.id) && e.locked);
    if (locked.length === g.ids.size) return;
    for (const l of locked) g.ids.delete(l.id);
    g.started = true;
    beginGesture();
    if (g.alt) {
      // Alt+arrastar duplica a seleção e move a cópia.
      const sel = s.elements.filter((e) => g.ids.has(e.id));
      const copies = cloneElements(sel, { x: 0, y: 0 });
      setTransient([...s.elements, ...copies]);
      g.ids = new Set(copies.map((c) => c.id));
      setState({ selectedIds: copies.map((c) => c.id) });
    }
  }
  const baseline = getState().interacting ? gestureBaselineWithCopies(g) : null;
  if (!baseline) return;
  let dx = p.world.x - g.start.x, dy = p.world.y - g.start.y;
  const meta = s.boards.find((b) => b.id === s.boardId);
  if (meta?.settings.snapToGrid) {
    const moving = baseline.filter((e) => g.ids.has(e.id));
    const box = getCommonBounds(moving);
    if (box) {
      const gs = meta.settings.gridSize;
      dx = snap(box.minX + dx, gs) - box.minX;
      dy = snap(box.minY + dy, gs) - box.minY;
    }
  }
  let lockX = false, lockY = false;
  if (p.shift && !g.shift) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; lockY = true; } else { dx = 0; lockX = true; } }
  // Encaixe em objetos (Ctrl inverte a configuração durante o arrasto).
  const objectSnap = (meta?.settings.snapToObjects !== false) !== p.ctrl;
  if (objectSnap && !meta?.settings.snapToGrid) {
    const moving = baseline.filter((e) => g.ids.has(e.id) && !isLinear(e));
    const box = getCommonBounds(moving);
    if (box) {
      g.targets ??= snapTargets(baseline, g.ids);
      const r = snapBox({ minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy }, g.targets, 6 / s.camera.zoom);
      if (!lockX) dx += r.dx;
      if (!lockY) dy += r.dy;
      setState({ snapGuides: r.guides.filter((gd) => (gd.x1 === gd.x2 ? !lockX : !lockY)) });
    }
  } else if (s.snapGuides.length) setState({ snapGuides: [] });
  const next = baseline.map((e) => {
    if (!g.ids.has(e.id)) return e;
    let moved = { ...e, x: e.x + dx, y: e.y + dy } as AuroraElement;
    if (isLinear(moved)) {
      // Seta arrastada sozinha se solta dos elementos que não se movem junto.
      const sb = moved.startBinding && !g.ids.has(moved.startBinding.elementId) ? null : moved.startBinding;
      const eb = moved.endBinding && !g.ids.has(moved.endBinding.elementId) ? null : moved.endBinding;
      moved = { ...moved, startBinding: sb, endBinding: eb };
    }
    return moved;
  });
  setTransient(updateBoundArrows(next, g.ids));
}

/** Limites dos elementos visíveis que servem de referência para o encaixe. */
function snapTargets(baseline: AuroraElement[], moving: Set<string>): Box[] {
  const s = getState();
  const cam = s.camera, m = 100 / cam.zoom;
  const view: Box = { minX: -cam.x / cam.zoom - m, minY: -cam.y / cam.zoom - m, maxX: (s.viewport.width - cam.x) / cam.zoom + m, maxY: (s.viewport.height - cam.y) / cam.zoom + m };
  const out: Box[] = [];
  for (const e of baseline) {
    if (moving.has(e.id) || isLinear(e) || e.type === 'freedraw') continue;
    const b = getElementBounds(e);
    if (boxesIntersect(b, view)) out.push(b);
    if (out.length >= 500) break;
  }
  return out;
}

/** Baseline do gesto incluindo cópias criadas por Alt+arrastar. */
function gestureBaselineWithCopies(g: Extract<Gesture, { type: 'move' }>): AuroraElement[] | null {
  const base = gestureBaseline();
  if (!base) return null;
  if (!g.alt) return base;
  // As cópias não estão no baseline: usa posições originais delas (offset 0) do estado inicial do arrasto.
  const cur = getState().elements;
  const baseIds = new Set(base.map((e) => e.id));
  const extra = cur.filter((e) => !baseIds.has(e.id));
  if (!copyOrigins.size) for (const e of extra) copyOrigins.set(e.id, e);
  return [...base, ...extra.map((e) => copyOrigins.get(e.id) ?? e)];
}
const copyOrigins = new Map<string, AuroraElement>();

function eraseAt(world: Vec) {
  const s = getState();
  const hit = getElementAtPoint(s.elements, world, 8 / s.camera.zoom, { filter: (e) => !e.locked && !s.eraserPending.includes(e.id), selectedIds: new Set(s.elements.map((e) => e.id)) });
  if (!hit) return;
  const group = expandToGroups(s.elements, [hit.id], null);
  setState({ eraserPending: [...new Set([...s.eraserPending, ...group])] });
}

function updateHover(p: PointerInfo) {
  const s = getState();
  if (s.tool === 'line' || s.tool === 'arrow' || s.tool === 'connect') {
    const t = bindingTargetAt(p.world);
    if (t?.elementId !== s.bindingHint?.elementId || t?.fixedPoint !== s.bindingHint?.fixedPoint) setState({ bindingHint: t });
    return;
  }
  if (s.tool !== 'select') return;
  const hit = elementAt(p.world);
  const id = hit?.id ?? null;
  if (id !== s.hoverId) setState({ hoverId: id });
}

/* ------------------------------------------------------------------ */

export function pointerUp(p: PointerInfo) {
  if (p.pointerType === 'touch') touches.delete(p.pointerId);
  const g = gesture;
  gesture = null;
  copyOrigins.clear();
  if (getState().snapGuides.length) setState({ snapGuides: [] });
  const s = getState();
  if (!g) return;
  switch (g.type) {
    case 'pinch':
    case 'pan':
      return;
    case 'marquee':
      setState({ marquee: null });
      return;
    case 'move': {
      if (!g.started) {
        // Clique sem arrastar dentro da caixa da seleção: seleciona o elemento de cima (ou limpa, no vazio).
        if (g.clickSelect !== undefined) {
          if (g.clickSelect) setSelection([g.clickSelect]);
          else setState({ selectedIds: [], editingGroupId: null });
          return;
        }
        // Clique simples num item de uma seleção múltipla seleciona só ele (ou seu grupo).
        if (g.wasSelected && !g.shift && s.selectedIds.length > 1) {
          const group = expandToGroups(s.elements, [g.hitId], s.editingGroupId);
          if (group.size < s.selectedIds.length) setSelection([g.hitId]);
        }
        return;
      }
      setTransient(assignFrames(getState().elements, g.ids));
      endGesture();
      return;
    }
    case 'resize':
    case 'rotate':
    case 'linear-insert':
      endGesture();
      return;
    case 'linear-point':
      setState({ bindingHint: null });
      endGesture();
      return;
    case 'create-shape': {
      const el = s.elements.find((e) => e.id === g.id) as ShapeElement | undefined;
      if (el && !g.moved) {
        const size = el.type === 'sticky' ? { w: 200, h: 200 } : el.type === 'frame' ? { w: 480, h: 320 } : { w: 160, h: 100 };
        setTransient(s.elements.map((e) => (e.id === g.id ? { ...el, x: g.start.x - size.w / 2, y: g.start.y - size.h / 2, width: size.w, height: size.h } : e)));
      }
      const all = getState().elements;
      setTransient(el?.type === 'frame' ? assignFrames(all) : assignFrames(all, new Set([g.id])));
      endGesture();
      finishCreation(g.id, el?.type === 'sticky');
      return;
    }
    case 'create-linear': {
      setState({ bindingHint: null });
      const el = getState().elements.find((e) => e.id === g.id) as LinearElement | undefined;
      if (!el) { endGesture(true); return; }
      if (!g.moved) {
        // Clique sem arrastar: modo multiponto (cada clique adiciona um ponto, como no Excalidraw).
        draft = { id: el.id, connect: g.connect };
        setState({ linearDraftId: el.id });
        return;
      }
      if (g.connect && (!el.endBinding || !el.startBinding)) {
        endGesture(true);
        toast('Conexão cancelada: solte a ponta sobre outro elemento.', 'warning');
        return;
      }
      if (g.connect && el.startBinding?.elementId === el.endBinding?.elementId) {
        endGesture(true);
        toast('Conexão cancelada: origem e destino são o mesmo elemento.', 'warning');
        return;
      }
      endGesture();
      finishCreation(g.id, false);
      return;
    }
    case 'freedraw': {
      const el = s.elements.find((e) => e.id === g.id) as FreedrawElement | undefined;
      if (el) setTransient(s.elements.map((e) => (e.id === g.id ? normalizeFreedraw(el) : e)));
      endGesture();
      return;
    }
    case 'erase': {
      const ids = new Set(s.eraserPending);
      setState({ eraserPending: [] });
      if (ids.size) commit((els) => unbindDeleted(els.filter((e) => !ids.has(e.id)), ids), { selection: [] });
      return;
    }
  }
}

function finishCreation(id: string, editText: boolean) {
  const s = getState();
  setState({ selectedIds: [id], tool: s.toolLocked ? s.tool : 'select' });
  if (editText) startTextEdit(id);
}

export function cancelGesture() {
  if (draft) { finishDraft(); return; }
  const g = gesture;
  gesture = null;
  copyOrigins.clear();
  setState({ marquee: null, bindingHint: null, eraserPending: [], snapGuides: [] });
  if (g && g.type !== 'pan' && g.type !== 'pinch' && g.type !== 'marquee' && g.type !== 'erase') endGesture(true);
}

export function pointerCancel(p: PointerInfo) {
  touches.delete(p.pointerId);
  cancelGesture();
}

/** Duplo clique: editar texto, entrar em grupo ou criar texto livre. */
export function doubleClick(world: Vec) {
  if (draft || performance.now() - draftFinishedAt < 500) return;
  const s = getState();
  if (s.tool !== 'select' && s.tool !== 'text') return;
  // No duplo clique, o interior de formas transparentes conta (escrever dentro da forma).
  const hit =
    elementAt(world) ??
    getElementAtPoint(s.elements, world, tolerance(), { selectedIds: new Set(s.elements.filter((e) => e.type !== 'frame').map((e) => e.id)) });
  if (!hit) {
    createTextAt(world);
    return;
  }
  if (hit.type === 'widget' || hit.type === 'image' || hit.type === 'freedraw') {
    const g = selectableGroupId(hit, s.editingGroupId);
    if (g) { setState({ editingGroupId: g }); setSelection([hit.id]); }
    return;
  }
  const g = selectableGroupId(hit, s.editingGroupId);
  if (g) {
    // Entra um nível: seleciona o subgrupo (ou o elemento) dentro do grupo em edição.
    setState({ editingGroupId: g });
    setSelection([hit.id]);
    return;
  }
  if (hit.locked) { toast('Elemento bloqueado.', 'info'); return; }
  startTextEdit(hit.id);
}

export function screenPointToWorld(screen: Vec) {
  return screenToWorld(screen);
}

/** Usado pelos testes e pela UI para checar se um ponto acerta o elemento. */
export { hitTest };
