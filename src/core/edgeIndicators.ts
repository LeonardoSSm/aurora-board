/**
 * Indicadores de checkpoints fora da tela. Puro: recebe só câmera, área útil e checkpoints
 * (nunca percorre os elementos do quadro).
 *
 * Para cada checkpoint fora da área visível: vetor do centro da área útil até o ponto na tela,
 * projetado até a interseção com o retângulo seguro (direção real, inclusive diagonais).
 * Histerese evita alternar entre “dentro” e “fora” quando o ponto está na borda.
 * Indicadores próximos no mesmo lado viram um grupo (expandido em lista).
 */
import type { Vec } from './geometry';

export interface Rect { left: number; top: number; right: number; bottom: number }
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Interseção do raio centro → ponto com a borda do retângulo (centro dentro do retângulo). */
export function projectToRect(center: Vec, point: Vec, r: Rect): { x: number; y: number; side: Side } {
  const dx = point.x - center.x, dy = point.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: r.top, side: 'top' };
  const tx = dx > 0 ? (r.right - center.x) / dx : dx < 0 ? (r.left - center.x) / dx : Infinity;
  const ty = dy > 0 ? (r.bottom - center.y) / dy : dy < 0 ? (r.top - center.y) / dy : Infinity;
  const t = Math.min(tx, ty);
  const x = center.x + dx * t, y = center.y + dy * t;
  const side: Side = tx <= ty ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  return { x: Math.min(r.right, Math.max(r.left, x)), y: Math.min(r.bottom, Math.max(r.top, y)), side };
}

export const inset = (r: Rect, d: number): Rect => ({ left: r.left + d, top: r.top + d, right: r.right - d, bottom: r.bottom - d });
export const contains = (r: Rect, p: Vec) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/** Direção em palavras (8 setores), para nomes acessíveis. */
export function directionName(angleRad: number): string {
  const names = ['à direita', 'abaixo à direita', 'abaixo', 'abaixo à esquerda', 'à esquerda', 'acima à esquerda', 'acima', 'acima à direita'];
  const k = Math.round(((angleRad / (Math.PI / 4)) % 8 + 8) % 8) % 8;
  return names[k];
}

export interface IndicatorInput { id: string; screen: Vec }
export interface InsideMarker { id: string; x: number; y: number }
export interface EdgeIndicator {
  /** Ids do grupo (1 = indicador simples). */
  ids: string[];
  x: number;
  y: number;
  side: Side;
  /** Ângulo (rad) do centro até o destino — do primeiro membro. */
  angle: number;
}

export interface LayoutOptions {
  /** Margem da histerese (px). */
  hysteresis?: number;
  /** Distância mínima entre indicadores no mesmo lado (lados esquerdo/direito e topo/base). */
  gapVertical?: number;
  gapHorizontal?: number;
  /** Folga para o chip inteiro caber (metade da altura / metade da largura). */
  halfHeight?: number;
  halfWidth?: number;
}

/**
 * @param visible área em que o checkpoint conta como “dentro” (o canvas visível)
 * @param safe    retângulo seguro onde os indicadores de borda são desenhados (sem barras e controles)
 * @param prevInside ids que estavam dentro no quadro anterior (histerese)
 */
export function layoutIndicators(items: IndicatorInput[], visible: Rect, safe: Rect, prevInside: ReadonlySet<string>, o: LayoutOptions = {}): { inside: InsideMarker[]; edges: EdgeIndicator[] } {
  const h = o.hysteresis ?? 12;
  const gapV = o.gapVertical ?? 30, gapH = o.gapHorizontal ?? 120;
  const halfH = o.halfHeight ?? 14, halfW = o.halfWidth ?? 60;
  const center = { x: (safe.left + safe.right) / 2, y: (safe.top + safe.bottom) / 2 };
  const inside: InsideMarker[] = [];
  const bySide: Record<Side, { id: string; pos: number; angle: number }[]> = { left: [], right: [], top: [], bottom: [] };
  for (const it of items) {
    if (!Number.isFinite(it.screen.x) || !Number.isFinite(it.screen.y)) continue;
    const isIn = prevInside.has(it.id) ? contains(inset(visible, -h), it.screen) : contains(inset(visible, h), it.screen);
    if (isIn) { inside.push({ id: it.id, x: it.screen.x, y: it.screen.y }); continue; }
    const p = projectToRect(center, it.screen, safe);
    const angle = Math.atan2(it.screen.y - center.y, it.screen.x - center.x);
    bySide[p.side].push({ id: it.id, pos: p.side === 'left' || p.side === 'right' ? p.y : p.x, angle });
  }
  const edges: EdgeIndicator[] = [];
  for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
    const vertical = side === 'left' || side === 'right';
    const gap = vertical ? gapV : gapH;
    const lo = vertical ? safe.top + halfH : safe.left + halfW, hi = vertical ? safe.bottom - halfH : safe.right - halfW;
    const list = bySide[side].sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id));
    let group: typeof list = [];
    const flush = () => {
      if (!group.length) return;
      const mean = group.reduce((s, g) => s + g.pos, 0) / group.length;
      const pos = hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, mean));
      const fixed = side === 'left' ? safe.left : side === 'right' ? safe.right : side === 'top' ? safe.top : safe.bottom;
      edges.push({ ids: group.map((g) => g.id), x: vertical ? fixed : pos, y: vertical ? pos : fixed, side, angle: group[0].angle });
      group = [];
    };
    for (const item of list) {
      // Compara com a posição já limitada do grupo (vários indicadores presos no canto também agrupam).
      const clamp = (v: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
      if (group.length && clamp(item.pos) - clamp(group[group.length - 1].pos) < gap) group.push(item);
      else { flush(); group.push(item); }
    }
    flush();
  }
  return { inside, edges };
}
