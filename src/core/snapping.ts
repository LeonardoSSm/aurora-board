/** Encaixe em objetos: alinha bordas e centros da seleção com os de outros elementos. */
import type { Box } from './geometry';

export interface Guide { x1: number; y1: number; x2: number; y2: number }

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

const xs = (b: Box) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
const ys = (b: Box) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];

/**
 * Dado o retângulo da seleção já deslocado (`moving`), retorna a correção (dx, dy) para encaixar
 * no alinhamento mais próximo dentro de `threshold`, e as linhas-guia a desenhar.
 */
export function snapBox(moving: Box, others: Box[], threshold: number): SnapResult {
  let bestX: { d: number; value: number } | null = null;
  let bestY: { d: number; value: number } | null = null;
  const mx = xs(moving), my = ys(moving);
  for (const o of others) {
    for (const a of mx) for (const b of xs(o)) {
      const d = b - a;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, value: b };
    }
    for (const a of my) for (const b of ys(o)) {
      const d = b - a;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, value: b };
    }
  }
  const dx = bestX?.d ?? 0, dy = bestY?.d ?? 0;
  const snapped: Box = { minX: moving.minX + dx, maxX: moving.maxX + dx, minY: moving.minY + dy, maxY: moving.maxY + dy };
  const guides: Guide[] = [];
  const eps = 0.5;
  if (bestX) {
    const line = bestX.value;
    const hits = others.filter((o) => xs(o).some((v) => Math.abs(v - line) < eps));
    const minY = Math.min(snapped.minY, ...hits.map((h) => h.minY));
    const maxY = Math.max(snapped.maxY, ...hits.map((h) => h.maxY));
    guides.push({ x1: line, y1: minY, x2: line, y2: maxY });
  }
  if (bestY) {
    const line = bestY.value;
    const hits = others.filter((o) => ys(o).some((v) => Math.abs(v - line) < eps));
    const minX = Math.min(snapped.minX, ...hits.map((h) => h.minX));
    const maxX = Math.max(snapped.maxX, ...hits.map((h) => h.maxX));
    guides.push({ x1: minX, y1: line, x2: maxX, y2: line });
  }
  return { dx, dy, guides };
}
