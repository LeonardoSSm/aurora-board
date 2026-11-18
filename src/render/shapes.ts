/**
 * Geração de caminhos SVG para cada elemento, em coordenadas LOCAIS.
 * Usado pela renderização em tela e pela exportação SVG/PNG (mesma fonte = mesmo resultado).
 */
import rough from 'roughjs';
import { getStroke } from 'perfect-freehand';
import type { Arrowhead, AuroraElement, ElementStyle, FreedrawElement, LinearElement } from '../core/schema';
import { getLinearRenderPoints, type Vec } from '../core/geometry';
import { bindingSides } from '../core/bindings';

export interface SvgPart {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  dash?: string;
}

const gen = rough.generator();
const cache = new Map<string, SvgPart[]>();

export function dashArray(style: ElementStyle): string | undefined {
  const w = style.strokeWidth;
  if (style.strokeStyle === 'dashed') return `${w * 4 + 4} ${w * 3 + 4}`;
  if (style.strokeStyle === 'dotted') return `${Math.max(1, w * 0.4)} ${w * 2.5 + 3}`;
  return undefined;
}

function roughOptions(el: AuroraElement, fill?: string) {
  const s = el.style;
  return {
    seed: el.seed % 2147483647 || 1,
    roughness: s.roughness,
    bowing: s.roughness ? 1 : 0,
    stroke: s.strokeColor,
    strokeWidth: s.strokeWidth,
    fill,
    fillStyle: s.fillStyle,
    fillWeight: Math.max(0.5, s.strokeWidth / 2),
    hachureGap: s.strokeWidth * 4 + 2,
    strokeLineDash: s.strokeStyle === 'solid' ? undefined : dashArray(s)?.split(' ').map(Number),
    disableMultiStroke: s.strokeStyle !== 'solid',
    preserveVertices: s.roughness < 1,
  };
}

function toParts(drawable: ReturnType<typeof gen.rectangle>): SvgPart[] {
  return gen.toPaths(drawable).map((p) => ({ d: p.d, stroke: p.stroke === 'none' ? undefined : p.stroke, strokeWidth: p.strokeWidth, fill: p.fill && p.fill !== 'none' ? p.fill : undefined }));
}

function roundedRectPath(w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

function ellipsePath(w: number, h: number): string {
  const rx = w / 2, ry = h / 2;
  return `M 0 ${ry} A ${rx} ${ry} 0 1 0 ${w} ${ry} A ${rx} ${ry} 0 1 0 0 ${ry} Z`;
}

function diamondPath(w: number, h: number): string {
  return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
}

export function cornerRadius(el: { width: number; height: number; style: ElementStyle }): number {
  return el.style.roundness === 'round' ? Math.min(16, Math.min(Math.abs(el.width), Math.abs(el.height)) / 4) : 0;
}

function closedShapeParts(el: AuroraElement, d: string): SvgPart[] {
  const s = el.style;
  const hasFill = s.backgroundColor !== 'transparent';
  const parts: SvgPart[] = [];
  if (s.roughness === 0) {
    if (hasFill) {
      if (s.fillStyle === 'solid') parts.push({ d, fill: s.backgroundColor });
      else parts.push(...toParts(gen.path(d, { ...roughOptions(el, s.backgroundColor), stroke: 'none', roughness: 0.4 })));
    }
    if (s.strokeWidth > 0) parts.push({ d, stroke: s.strokeColor, strokeWidth: s.strokeWidth, dash: dashArray(s) });
    return parts;
  }
  return toParts(gen.path(d, roughOptions(el, hasFill ? s.backgroundColor : undefined)));
}

function arrowheadParts(head: Arrowhead, tip: Vec, from: Vec, style: ElementStyle): SvgPart[] {
  if (head === 'none') return [];
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const size = Math.max(10, style.strokeWidth * 4 + 6);
  const color = style.strokeColor;
  if (head === 'arrow' || head === 'triangle') {
    const spread = head === 'arrow' ? 0.45 : 0.42;
    const a = { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) };
    const b = { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) };
    if (head === 'arrow') return [{ d: `M ${a.x} ${a.y} L ${tip.x} ${tip.y} L ${b.x} ${b.y}`, stroke: color, strokeWidth: style.strokeWidth }];
    return [{ d: `M ${a.x} ${a.y} L ${tip.x} ${tip.y} L ${b.x} ${b.y} Z`, stroke: color, strokeWidth: style.strokeWidth, fill: color }];
  }
  if (head === 'dot') {
    const r = Math.max(3, style.strokeWidth * 1.6);
    return [{ d: `M ${tip.x - r} ${tip.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`, fill: color }];
  }
  const nx = -Math.sin(angle), ny = Math.cos(angle), half = size * 0.6;
  return [{ d: `M ${tip.x + nx * half} ${tip.y + ny * half} L ${tip.x - nx * half} ${tip.y - ny * half}`, stroke: color, strokeWidth: style.strokeWidth }];
}

/** Pontos renderizados de uma linha/seta em coordenadas locais (relativas a el.x, el.y). */
export function linearLocalPoints(el: LinearElement): Vec[] {
  return getLinearRenderPoints(el, bindingSides(el)).map((p) => ({ x: p.x - el.x, y: p.y - el.y }));
}

function linearParts(el: LinearElement): SvgPart[] {
  const pts = linearLocalPoints(el);
  if (pts.length < 2) return [];
  const s = el.style;
  const parts: SvgPart[] = [];
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  if (s.roughness === 0 || el.path === 'elbow') {
    parts.push({ d, stroke: s.strokeColor, strokeWidth: s.strokeWidth, dash: dashArray(s) });
  } else if (el.path === 'curved' && el.points.length > 2) {
    // Traço à mão passando pelos pontos originais (roughjs interpola a curva).
    parts.push(...toParts(gen.curve(el.points.map(([x, y]) => [x, y] as [number, number]), roughOptions(el))));
  } else {
    parts.push(...toParts(gen.linearPath(pts.map((p) => [p.x, p.y] as [number, number]), roughOptions(el))));
  }
  // Direção das pontas: um ponto a ~10px da extremidade (estável em curvas amostradas).
  const back = (fromEnd: boolean) => {
    const tip = fromEnd ? pts[pts.length - 1] : pts[0];
    for (let k = 1; k < pts.length; k++) {
      const q = fromEnd ? pts[pts.length - 1 - k] : pts[k];
      if (Math.hypot(q.x - tip.x, q.y - tip.y) >= 10) return q;
    }
    return fromEnd ? pts[pts.length - 2] : pts[1];
  };
  const last = pts[pts.length - 1], prev = back(true);
  const first = pts[0], second = back(false);
  parts.push(...arrowheadParts(el.endArrowhead, last, prev, s));
  parts.push(...arrowheadParts(el.startArrowhead, first, second, s));
  return parts;
}

export function freedrawOutline(el: FreedrawElement): string {
  const stroke = getStroke(
    el.points.map(([x, y, p]) => [x, y, p]),
    { size: el.style.strokeWidth * 2.2 + 2, thinning: 0.6, smoothing: 0.55, streamline: 0.45, simulatePressure: el.simulatePressure, last: true },
  );
  if (!stroke.length) return '';
  const d = stroke.reduce<string[]>((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(`${x0.toFixed(2)},${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)},${((y0 + y1) / 2).toFixed(2)}`);
    return acc;
  }, ['M', `${stroke[0][0].toFixed(2)},${stroke[0][1].toFixed(2)}`, 'Q']);
  return d.join(' ') + ' Z';
}

function cacheKey(el: AuroraElement): string {
  const base = `${el.type}|${el.width.toFixed(2)}|${el.height.toFixed(2)}|${el.seed}|${JSON.stringify(el.style)}`;
  if (el.type === 'line' || el.type === 'arrow') {
    return `${base}|${JSON.stringify(el.points)}|${el.path}|${el.bend}|${el.startArrowhead}|${el.endArrowhead}|${el.startBinding?.fixedPoint ?? ''}|${el.endBinding?.fixedPoint ?? ''}`;
  }
  if (el.type === 'freedraw') return `${base}|${el.points.length}|${el.points[el.points.length - 1]?.join(',')}|${el.version}`;
  return base;
}

/** Partes SVG de um elemento (memoizado por forma/estilo; mover não recalcula). */
export function elementParts(el: AuroraElement): SvgPart[] {
  if (el.type === 'text' || el.type === 'image' || el.type === 'widget') return [];
  const key = cacheKey(el);
  const hit = cache.get(key);
  if (hit) return hit;
  let parts: SvgPart[] = [];
  const w = Math.max(1, el.width), h = Math.max(1, el.height);
  switch (el.type) {
    case 'rectangle':
    case 'frame':
      parts = closedShapeParts(el, roundedRectPath(w, h, el.type === 'frame' ? 8 : cornerRadius(el)));
      break;
    case 'sticky':
      parts = [{ d: roundedRectPath(w, h, 4), fill: el.style.backgroundColor }];
      break;
    case 'ellipse':
      parts = closedShapeParts(el, ellipsePath(w, h));
      break;
    case 'diamond':
      parts = closedShapeParts(el, diamondPath(w, h));
      break;
    case 'line':
    case 'arrow':
      parts = linearParts(el);
      break;
    case 'freedraw':
      parts = [{ d: freedrawOutline(el), fill: el.style.strokeColor }];
      break;
  }
  if (cache.size > 3000) cache.clear();
  cache.set(key, parts);
  return parts;
}
