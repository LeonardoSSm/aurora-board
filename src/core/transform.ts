/** Transformações: redimensionar e rotacionar elementos (puras). */
import type { AuroraElement, FreedrawElement, LinearElement } from './schema';
import { isLinear, isRotatable } from './schema';
import { elementCenter, rotatePoint, type Box, type Vec } from './geometry';
import { syncLinearBounds } from './elements';

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_SIZE = 4;

export interface ResizeOptions {
  keepAspect: boolean;
  fromCenter: boolean;
}

/**
 * Redimensiona um único elemento (com rotação) arrastando uma alça.
 * Mantém a borda oposta fixa no espaço do mundo.
 */
export function resizeSingle(initial: AuroraElement, handle: Handle, pointer: Vec, opts: ResizeOptions): AuroraElement {
  const c = elementCenter(initial);
  const lp = rotatePoint(pointer, c, -initial.angle);
  let left = initial.x, right = initial.x + initial.width, top = initial.y, bottom = initial.y + initial.height;
  if (handle.includes('w')) left = lp.x;
  if (handle.includes('e')) right = lp.x;
  if (handle.includes('n')) top = lp.y;
  if (handle.includes('s')) bottom = lp.y;
  if (opts.fromCenter) {
    if (handle.includes('w')) right = 2 * c.x - left;
    if (handle.includes('e')) left = 2 * c.x - right;
    if (handle.includes('n')) bottom = 2 * c.y - top;
    if (handle.includes('s')) top = 2 * c.y - bottom;
  }
  let flipX = false, flipY = false;
  if (right < left) { [left, right] = [right, left]; flipX = true; }
  if (bottom < top) { [top, bottom] = [bottom, top]; flipY = true; }
  let w = Math.max(MIN_SIZE, right - left), h = Math.max(MIN_SIZE, bottom - top);
  const corner = handle.length === 2;
  if (opts.keepAspect && initial.width > 0 && initial.height > 0) {
    const ratio = initial.width / initial.height;
    if (corner) {
      if (w / h > ratio) h = w / ratio; else w = h * ratio;
    } else if (handle === 'e' || handle === 'w') h = w / ratio;
    else w = h * ratio;
    // Reposiciona mantendo o canto/borda oposta.
    if (handle.includes('w') !== flipX) left = right - w; else right = left + w;
    if (handle.includes('n') !== flipY) top = bottom - h; else bottom = top + h;
    if (!corner) {
      if (handle === 'e' || handle === 'w') { const cy = (initial.y + initial.y + initial.height) / 2; top = cy - h / 2; }
      else { const cx = (initial.x + initial.x + initial.width) / 2; left = cx - w / 2; }
    }
  }
  const newCenterLocal = { x: left + w / 2, y: top + h / 2 };
  const newCenter = rotatePoint(newCenterLocal, c, initial.angle);
  const nx = newCenter.x - w / 2, ny = newCenter.y - h / 2;

  if (initial.type === 'freedraw') {
    const sx = (flipX ? -1 : 1) * (w / Math.max(initial.width, 1e-6));
    const sy = (flipY ? -1 : 1) * (h / Math.max(initial.height, 1e-6));
    const pts = initial.points.map(([px, py, pr]) => [
      sx < 0 ? w + px * sx : px * sx,
      sy < 0 ? h + py * sy : py * sy,
      pr,
    ] as [number, number, number]);
    return { ...initial, x: nx, y: ny, width: w, height: h, points: pts } as FreedrawElement;
  }
  if (initial.type === 'text') {
    const scale = corner ? h / Math.max(initial.height, 1e-6) : 1;
    if (corner) {
      return {
        ...initial,
        x: nx, y: ny, width: w, height: h,
        style: { ...initial.style, fontSize: Math.max(6, Math.round(initial.style.fontSize * scale * 10) / 10) },
      };
    }
    return { ...initial, x: nx, y: ny, width: w, autoSize: false };
  }
  return { ...initial, x: nx, y: ny, width: w, height: h };
}

/** Escala um elemento em relação a uma âncora (para redimensionamento de seleção múltipla). */
export function scaleElement(el: AuroraElement, anchor: Vec, sx: number, sy: number): AuroraElement {
  if (isLinear(el) || el.type === 'freedraw') {
    const nx = anchor.x + (el.x - anchor.x) * sx;
    const ny = anchor.y + (el.y - anchor.y) * sy;
    if (isLinear(el)) {
      const pts = el.points.map(([px, py]) => [px * sx, py * sy] as [number, number]);
      return syncLinearBounds({ ...el, x: nx, y: ny, points: pts, bend: el.bend * Math.min(Math.abs(sx), Math.abs(sy)) } as LinearElement);
    }
    const pts = el.points.map(([px, py, pr]) => [px * sx, py * sy, pr] as [number, number, number]);
    return syncLinearBounds({ ...el, x: nx, y: ny, points: pts } as FreedrawElement);
  }
  const c = elementCenter(el);
  const nc = { x: anchor.x + (c.x - anchor.x) * sx, y: anchor.y + (c.y - anchor.y) * sy };
  const w = Math.max(MIN_SIZE, el.width * Math.abs(sx)), h = Math.max(MIN_SIZE, el.height * Math.abs(sy));
  const out = { ...el, x: nc.x - w / 2, y: nc.y - h / 2, width: w, height: h };
  if (el.type === 'text') out.style = { ...el.style, fontSize: Math.max(6, el.style.fontSize * Math.min(Math.abs(sx), Math.abs(sy))) };
  return out as AuroraElement;
}

/** Redimensiona uma seleção múltipla proporcionalmente a partir de uma alça de canto. */
export function resizeMultiple(initials: AuroraElement[], box: Box, handle: Handle, pointer: Vec): AuroraElement[] {
  const anchor = {
    x: handle.includes('w') ? box.maxX : handle.includes('e') ? box.minX : (box.minX + box.maxX) / 2,
    y: handle.includes('n') ? box.maxY : handle.includes('s') ? box.minY : (box.minY + box.maxY) / 2,
  };
  const bw = Math.max(box.maxX - box.minX, 1e-6), bh = Math.max(box.maxY - box.minY, 1e-6);
  const sxRaw = handle.includes('e') ? (pointer.x - box.minX) / bw : handle.includes('w') ? (box.maxX - pointer.x) / bw : 1;
  const syRaw = handle.includes('s') ? (pointer.y - box.minY) / bh : handle.includes('n') ? (box.maxY - pointer.y) / bh : 1;
  let s: number;
  if (handle.length === 2) s = Math.max(sxRaw, syRaw);
  else s = handle === 'e' || handle === 'w' ? sxRaw : syRaw;
  s = Math.max(0.05, s);
  return initials.map((el) => scaleElement(el, anchor, s, s));
}

/** Rotaciona elementos ao redor de um centro comum. */
export function rotateElements(initials: AuroraElement[], center: Vec, delta: number): AuroraElement[] {
  return initials.map((el) => {
    if (isLinear(el)) {
      const abs = el.points.map(([px, py]) => rotatePoint({ x: el.x + px, y: el.y + py }, center, delta));
      const o = abs[0];
      return syncLinearBounds({ ...el, x: o.x, y: o.y, points: abs.map((p) => [p.x - o.x, p.y - o.y] as [number, number]) });
    }
    const c = elementCenter(el);
    const nc = initials.length > 1 ? rotatePoint(c, center, delta) : c;
    const angle = isRotatable(el) ? el.angle + delta : el.angle;
    return { ...el, x: nc.x - el.width / 2, y: nc.y - el.height / 2, angle };
  });
}

export function handleCursor(handle: Handle, angle: number): string {
  const base: Record<Handle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const deg = (((base[handle] + (angle * 180) / Math.PI) % 360) + 360) % 360;
  const idx = Math.round(deg / 45) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][idx];
}
