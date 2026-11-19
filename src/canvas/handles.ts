/** Posições de alças de transformação em coordenadas de TELA (tamanho constante em qualquer zoom). */
import type { AuroraElement, Camera, LinearElement } from '../core/schema';
import { isLinear, isRotatable } from '../core/schema';
import { elementCenter, getCommonBounds, getLinearAbsolutePoints, linearSegmentMidpoint, rotatePoint, type Box, type Vec } from '../core/geometry';
import type { Handle } from '../core/transform';

export const HANDLE_SIZE = 9;
const ROTATE_OFFSET = 26;
const PAD = 5;

export interface TransformHandle {
  kind: 'resize' | 'rotate';
  handle?: Handle;
  pos: Vec;
  angle: number;
}

export interface LinearHandle {
  /** point = vértice existente (arrastar move; Delete remove); mid = arrastar insere um novo ponto. */
  kind: 'point' | 'mid';
  index: number;
  pos: Vec;
}

export const toScreen = (p: Vec, cam: Camera): Vec => ({ x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y });

/** Retângulo de seleção (em tela): 4 cantos na ordem nw, ne, se, sw e o ângulo. */
export function selectionFrame(selected: AuroraElement[], cam: Camera): { corners: Vec[]; angle: number; box: Box } | null {
  if (!selected.length) return null;
  if (selected.length === 1 && !isLinear(selected[0])) {
    const el = selected[0];
    const c = elementCenter(el);
    const pad = PAD / cam.zoom;
    const local = [
      { x: el.x - pad, y: el.y - pad },
      { x: el.x + el.width + pad, y: el.y - pad },
      { x: el.x + el.width + pad, y: el.y + el.height + pad },
      { x: el.x - pad, y: el.y + el.height + pad },
    ];
    const corners = local.map((p) => toScreen(rotatePoint(p, c, el.angle), cam));
    return { corners, angle: el.angle, box: { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height } };
  }
  const box = getCommonBounds(selected)!;
  const pad = PAD / cam.zoom;
  const corners = [
    { x: box.minX - pad, y: box.minY - pad },
    { x: box.maxX + pad, y: box.minY - pad },
    { x: box.maxX + pad, y: box.maxY + pad },
    { x: box.minX - pad, y: box.maxY + pad },
  ].map((p) => toScreen(p, cam));
  return { corners, angle: 0, box };
}

export function transformHandles(selected: AuroraElement[], cam: Camera): TransformHandle[] {
  if (!selected.length || selected.some((e) => e.locked)) return [];
  if (selected.length === 1 && isLinear(selected[0])) return [];
  const frame = selectionFrame(selected, cam);
  if (!frame) return [];
  const [nw, ne, se, sw] = frame.corners;
  const mid = (a: Vec, b: Vec) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const out: TransformHandle[] = [
    { kind: 'resize', handle: 'nw', pos: nw, angle: frame.angle },
    { kind: 'resize', handle: 'ne', pos: ne, angle: frame.angle },
    { kind: 'resize', handle: 'se', pos: se, angle: frame.angle },
    { kind: 'resize', handle: 'sw', pos: sw, angle: frame.angle },
  ];
  const width = Math.hypot(ne.x - nw.x, ne.y - nw.y), height = Math.hypot(sw.x - nw.x, sw.y - nw.y);
  const single = selected.length === 1;
  // Texto (como no Excalidraw): só alças laterais esquerda/direita — a altura vem do conteúdo.
  const isText = single && selected[0].type === 'text';
  if (single && !isText && width > 36) {
    out.push({ kind: 'resize', handle: 'n', pos: mid(nw, ne), angle: frame.angle });
    out.push({ kind: 'resize', handle: 's', pos: mid(sw, se), angle: frame.angle });
  }
  if (single && (isText || height > 36)) {
    out.push({ kind: 'resize', handle: 'e', pos: mid(ne, se), angle: frame.angle });
    out.push({ kind: 'resize', handle: 'w', pos: mid(nw, sw), angle: frame.angle });
  }
  const canRotate = single ? isRotatable(selected[0]) : selected.every((e) => isRotatable(e) || isLinear(e));
  if (canRotate) {
    const top = mid(nw, ne);
    const up = { x: Math.sin(frame.angle), y: -Math.cos(frame.angle) };
    out.push({ kind: 'rotate', pos: { x: top.x + up.x * ROTATE_OFFSET, y: top.y + up.y * ROTATE_OFFSET }, angle: frame.angle });
  }
  return out;
}

export function linearHandles(el: LinearElement, cam: Camera): LinearHandle[] {
  if (el.locked) return [];
  const pts = getLinearAbsolutePoints(el);
  // Cotovelo: a rota é calculada, só as pontas são editáveis.
  const indices = el.path === 'elbow' ? [0, pts.length - 1] : pts.map((_, i) => i);
  const out: LinearHandle[] = indices.map((i) => ({ kind: 'point' as const, index: i, pos: toScreen(pts[i], cam) }));
  if (el.path !== 'elbow') {
    for (let i = 0; i < pts.length - 1; i++) {
      const pos = toScreen(linearSegmentMidpoint(el, i), cam);
      const a = toScreen(pts[i], cam), b = toScreen(pts[i + 1], cam);
      // Segmentos muito curtos na tela não ganham alça de inserção (evita sobreposição).
      if (Math.hypot(a.x - b.x, a.y - b.y) > 36) out.push({ kind: 'mid', index: i, pos });
    }
  }
  return out;
}

/** Alça mais próxima dentro do raio (prioriza pontos existentes sobre pontos médios). */
export function hitHandle<T extends { pos: Vec; kind?: string }>(handles: T[], screen: Vec, radius = HANDLE_SIZE): T | null {
  let best: T | null = null, bestD = radius;
  for (const h of handles) {
    const d = Math.hypot(h.pos.x - screen.x, h.pos.y - screen.y) - (h.kind === 'point' ? 2 : 0);
    if (d <= bestD) { best = h; bestD = d; }
  }
  return best;
}
