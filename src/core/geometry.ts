/** Geometria pura: limites, rotação, hit-test e ancoragem de conexões. */
import type { AuroraElement, LinearElement, Point } from './schema';
import { isLinear } from './schema';

export interface Vec { x: number; y: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export const vec = (x: number, y: number): Vec => ({ x, y });
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function rotatePoint(p: Vec, c: Vec, angle: number): Vec {
  if (!angle) return { x: p.x, y: p.y };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function elementCenter(el: AuroraElement): Vec {
  if (isLinear(el)) {
    const b = getElementBounds(el);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/** Converte ponto do mundo para o espaço local (não rotacionado) do elemento. */
export function toLocal(el: AuroraElement, p: Vec): Vec {
  return rotatePoint(p, elementCenter(el), -el.angle);
}

export function getLinearAbsolutePoints(el: LinearElement): Vec[] {
  return el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
}

/** Lado de saída de uma âncora (para roteamento ortogonal). */
export type Side = 'left' | 'right' | 'top' | 'bottom';

const SIDE_DIR: Record<Side, Vec> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const isHorizontal = (side: Side) => side === 'left' || side === 'right';

function dedupe(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    // remove pontos colineares
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) out.pop();
    out.push(p);
  }
  return out;
}

export function elbowRoute(s: Vec, e: Vec, startSide?: Side | null, endSide?: Side | null): Vec[] {
  if (startSide || endSide) {
    // Sai e entra perpendicular ao lado ancorado, com um pequeno "toco".
    const STUB = 24;
    const s1 = startSide ? { x: s.x + SIDE_DIR[startSide].x * STUB, y: s.y + SIDE_DIR[startSide].y * STUB } : s;
    const e1 = endSide ? { x: e.x + SIDE_DIR[endSide].x * STUB, y: e.y + SIDE_DIR[endSide].y * STUB } : e;
    const sh = startSide ? isHorizontal(startSide) : !isHorizontal(endSide!);
    const eh = endSide ? isHorizontal(endSide) : sh;
    let mid: Vec[];
    // "Para longe": a saída aponta no sentido oposto ao destino → desvia pela perpendicular.
    const awayH = (startSide === 'right' && e1.x < s1.x) || (startSide === 'left' && e1.x > s1.x);
    const awayV = (startSide === 'bottom' && e1.y < s1.y) || (startSide === 'top' && e1.y > s1.y);
    if (sh && eh) {
      if (awayH) { const my = (s1.y + e1.y) / 2; mid = [{ x: s1.x, y: my }, { x: e1.x, y: my }]; }
      else { const mx = (s1.x + e1.x) / 2; mid = [{ x: mx, y: s1.y }, { x: mx, y: e1.y }]; }
    } else if (!sh && !eh) {
      if (awayV) { const mx = (s1.x + e1.x) / 2; mid = [{ x: mx, y: s1.y }, { x: mx, y: e1.y }]; }
      else { const my = (s1.y + e1.y) / 2; mid = [{ x: s1.x, y: my }, { x: e1.x, y: my }]; }
    }
    else if (sh) mid = [{ x: e1.x, y: s1.y }];
    else mid = [{ x: s1.x, y: e1.y }];
    return dedupe([s, s1, ...mid, e1, e]);
  }
  const horizontalFirst = startSide
    ? startSide === 'left' || startSide === 'right'
    : endSide
      ? endSide === 'left' || endSide === 'right'
      : Math.abs(e.x - s.x) >= Math.abs(e.y - s.y);
  if (horizontalFirst) {
    const mx = (s.x + e.x) / 2;
    return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  const my = (s.y + e.y) / 2;
  return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
}

/** Ponto de controle da curva quadrática para setas curvas. */
export function curveControl(s: Vec, e: Vec, bend: number): Vec {
  const mx = (s.x + e.x) / 2, my = (s.y + e.y) / 2;
  const len = Math.hypot(e.x - s.x, e.y - s.y) || 1;
  const nx = -(e.y - s.y) / len, ny = (e.x - s.x) / len;
  // Curva quadrática passa pelo ponto médio + bend quando o controle está a 2*bend.
  return { x: mx + nx * bend * 2, y: my + ny * bend * 2 };
}

/** Ponto de uma spline Catmull-Rom (uniforme) no segmento p1→p2. */
export function catmullPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
}

/** Curva suave que passa por todos os pontos (setas "curvas" com vários pontos). */
export function catmullRom(pts: Vec[], steps = 16): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? pts[i + 1];
    for (let k = 1; k <= steps; k++) out.push(catmullPoint(p0, p1, p2, p3, k / steps));
  }
  return out;
}

/** Ponto no meio do segmento i (entre os pontos i e i+1), sobre a curva quando for curva. */
export function linearSegmentMidpoint(el: LinearElement, i: number): Vec {
  const pts = getLinearAbsolutePoints(el);
  const a = pts[i], b = pts[i + 1];
  if (el.path === 'curved' && pts.length > 2) return catmullPoint(pts[i - 1] ?? a, a, b, pts[i + 2] ?? b, 0.5);
  if (el.path === 'curved' && pts.length === 2 && el.bend) {
    const c = curveControl(a, b, el.bend);
    return { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y };
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Pontos efetivamente desenhados (curvas são amostradas), em coordenadas do mundo. */
export function getLinearRenderPoints(el: LinearElement, sides?: { start?: Side | null; end?: Side | null }): Vec[] {
  const pts = getLinearAbsolutePoints(el);
  if (pts.length < 2) return pts;
  const s = pts[0], e = pts[pts.length - 1];
  if (el.path === 'elbow') {
    const start = sides?.start ?? (el.startBinding?.fixedPoint ? sideOfFixedPoint(el.startBinding.fixedPoint) : null);
    const end = sides?.end ?? (el.endBinding?.fixedPoint ? sideOfFixedPoint(el.endBinding.fixedPoint) : null);
    return elbowRoute(s, e, start, end);
  }
  if (el.path === 'curved' && pts.length === 2 && el.bend) {
    const c = curveControl(s, e, el.bend);
    const out: Vec[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      out.push({ x: u * u * s.x + 2 * u * t * c.x + t * t * e.x, y: u * u * s.y + 2 * u * t * c.y + t * t * e.y });
    }
    return out;
  }
  if (el.path === 'curved' && pts.length > 2) return catmullRom(pts);
  return pts;
}

/** Limites alinhados aos eixos (AABB) em coordenadas do mundo, considerando rotação. */
export function getElementBounds(el: AuroraElement): Box {
  if (isLinear(el)) {
    const pts = getLinearRenderPoints(el);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }
  if (!el.angle) return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
  const c = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  const corners = [
    { x: el.x, y: el.y },
    { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height },
    { x: el.x, y: el.y + el.height },
  ].map((p) => rotatePoint(p, c, el.angle));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

export function getCommonBounds(elements: AuroraElement[]): Box | null {
  if (!elements.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const b = getElementBounds(el);
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boxContains(outer: Box, inner: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function distanceToPolyline(p: Vec, pts: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distanceToSegment(p, pts[i], pts[i + 1]));
  if (pts.length === 1) best = dist(p, pts[0]);
  return best;
}

function hasFill(el: AuroraElement) {
  return el.style.backgroundColor !== 'transparent' || !!el.text;
}

/**
 * Hit test de um elemento.
 * - Formas preenchidas, com texto, imagens e widgets: área interna conta.
 * - Formas transparentes: apenas perto do contorno (como no Excalidraw), exceto quando `insideCounts`.
 * - Frames: apenas borda e título, para permitir selecionar o que está dentro.
 */
export function hitTest(el: AuroraElement, p: Vec, tolerance: number, insideCounts = false): boolean {
  if (isLinear(el)) {
    return distanceToPolyline(p, getLinearRenderPoints(el)) <= tolerance + el.style.strokeWidth / 2;
  }
  if (el.type === 'freedraw') {
    const pts = el.points.map(([px, py]) => rotatePoint({ x: el.x + px, y: el.y + py }, elementCenter(el), el.angle));
    return distanceToPolyline(p, pts) <= tolerance + el.style.strokeWidth * 1.5;
  }
  const lp = toLocal(el, p);
  const x = lp.x - el.x, y = lp.y - el.y, w = el.width, h = el.height;
  // Título do frame fica ACIMA da caixa: precisa ser testado antes do descarte por "fora da caixa".
  if (el.type === 'frame' && y >= -28 && y <= 0 && x >= 0 && x <= Math.max(120, w * 0.6)) return true;
  const inBox = x >= -tolerance && x <= w + tolerance && y >= -tolerance && y <= h + tolerance;
  if (!inBox) return false;
  if (el.type === 'frame') {
    const nearEdge = x <= tolerance || x >= w - tolerance || y <= tolerance || y >= h - tolerance;
    return nearEdge || insideCounts;
  }
  if (el.type === 'text' || el.type === 'image' || el.type === 'widget' || el.type === 'sticky') return true;
  const filled = hasFill(el) || insideCounts;
  const cx = w / 2, cy = h / 2;
  if (el.type === 'ellipse') {
    const rx = Math.max(w / 2, 1), ry = Math.max(h / 2, 1);
    const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
    if (filled) return d <= 1 + tolerance / Math.min(rx, ry);
    return Math.abs(d - 1) * Math.min(rx, ry) <= tolerance;
  }
  if (el.type === 'diamond') {
    const d = Math.abs(x - cx) / Math.max(cx, 1) + Math.abs(y - cy) / Math.max(cy, 1);
    if (filled) return d <= 1 + tolerance / Math.min(cx, cy);
    const poly = [{ x: cx, y: 0 }, { x: w, y: cy }, { x: cx, y: h }, { x: 0, y: cy }, { x: cx, y: 0 }];
    return distanceToPolyline({ x, y }, poly) <= tolerance;
  }
  // rectangle
  if (filled) return true;
  const nearEdge = x <= tolerance || x >= w - tolerance || y <= tolerance || y >= h - tolerance;
  return nearEdge;
}

/** Retorna o elemento mais ao topo sob o ponto. */
export function getElementAtPoint(
  elements: AuroraElement[],
  p: Vec,
  tolerance: number,
  opts: { selectedIds?: Set<string>; filter?: (el: AuroraElement) => boolean } = {},
): AuroraElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (opts.filter && !opts.filter(el)) continue;
    if (hitTest(el, p, tolerance, opts.selectedIds?.has(el.id) ?? false)) return el;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Ancoragem (conexões)                                                */
/* ------------------------------------------------------------------ */

/** Pontos de conexão padrão (normalizados): topo, direita, base, esquerda. */
export const CONNECTION_POINTS: Point[] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
];

export function fixedPointToWorld(el: AuroraElement, fp: Point): Vec {
  // Pontos médios das bordas coincidem com o contorno em retângulos, elipses e losangos.
  const local = { x: el.x + fp[0] * el.width, y: el.y + fp[1] * el.height };
  return rotatePoint(local, elementCenter(el), el.angle);
}

export function sideOfFixedPoint(fp: Point): Side {
  const [fx, fy] = fp;
  const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
  const m = Math.min(dl, dr, dt, db);
  return m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom';
}

/**
 * Ponto na borda do elemento na direção de `towards` (a partir do centro), com folga `gap`.
 * Funciona para retângulos, elipses e losangos, considerando rotação.
 */
export function boundaryPointTowards(el: AuroraElement, towards: Vec, gap = 6): { point: Vec; side: Side } {
  const c = elementCenter(el);
  const t = toLocal(el, towards);
  let dx = t.x - c.x, dy = t.y - c.y;
  if (!dx && !dy) dy = -1;
  const hw = Math.max(el.width / 2, 0.5), hh = Math.max(el.height / 2, 0.5);
  let k: number;
  if (el.type === 'ellipse') k = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (el.type === 'diamond') k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  const len = Math.hypot(dx, dy);
  const bx = c.x + dx * k + (dx / len) * gap;
  const by = c.y + dy * k + (dy / len) * gap;
  const side: Side = Math.abs(dx) / hw >= Math.abs(dy) / hh ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  return { point: rotatePoint({ x: bx, y: by }, c, el.angle), side };
}

/** Encontra o ponto de conexão fixo mais próximo (se dentro do raio). */
export function nearestConnectionPoint(el: AuroraElement, p: Vec, radius: number): Point | null {
  let best: Point | null = null, bestD = radius;
  for (const fp of CONNECTION_POINTS) {
    const w = fixedPointToWorld(el, fp);
    const d = dist(w, p);
    if (d <= bestD) { best = fp; bestD = d; }
  }
  return best;
}

export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}
