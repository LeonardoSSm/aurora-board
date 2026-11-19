/**
 * Layout de cartão dos blocos financeiros (valor, mês, fórmula): uma lista de primitivas desenhada igual
 * na tela e na exportação PNG/SVG. Puro — mede texto com core/text.
 */
import { measureLine } from './text';
import type { TileNode } from './aiTiles';
import type { TileDisplayMode } from './valueTile';

export interface CardRow { label: string; value: string; color?: string; role?: string }

export interface CardModel {
  title: string;
  value: string;
  valueColor: string;
  /** Linha pequena sob o valor (tipo, papel, expressão…). */
  caption?: string;
  rows: CardRow[];
  accent: string;
  /** Aviso/erro exibido no rodapé. */
  status?: { text: string; color: string };
  /** Identificador do valor principal (testes/acessibilidade). */
  valueRole?: string;
}

export const CARD_BG = '#131d2c';
export const CARD_BORDER = '#2e405a';
export const CARD_FG = '#edf3fc';
export const CARD_MUTED = '#8ea3bf';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function fit(text: string, size: number, maxWidth: number): string {
  const style = { fontFamily: 'sans' as const, fontSize: size };
  if (measureLine(text, style) <= maxWidth) return text;
  // Começa de um prefixo que certamente cabe ≤ maxWidth (glifo mais estreito ≈ 0,15 em): o laço fica O(largura), não O(texto) (S1-SEC-018).
  let t = text.slice(0, Math.ceil(maxWidth / Math.max(1, style.fontSize * 0.15)) + 1);
  while (t.length > 1 && measureLine(t + '…', style) > maxWidth) t = t.slice(0, -1);
  return t.length > 0 ? t.trimEnd() + '…' : '';
}

/** Maior tamanho de fonte (até `max`) em que o texto cabe na largura. */
function fitSize(text: string, max: number, min: number, maxWidth: number, weight = 1.04): number {
  let size = max;
  while (size > min && measureLine(text, { fontFamily: 'sans', fontSize: size * weight }) > maxWidth) size -= 1;
  return size;
}

export function cardLayout(m: CardModel, width: number, height: number, mode: TileDisplayMode): TileNode[] {
  const w = Math.max(1, width), h = Math.max(1, height);
  const nodes: TileNode[] = [];
  const pad = clamp(Math.min(w, h) * 0.12, 6, 14);
  nodes.push({ kind: 'rect', x: 0.5, y: 0.5, w: w - 1, h: h - 1, rx: clamp(Math.min(w, h) * 0.16, 6, 12), fill: CARD_BG, stroke: CARD_BORDER, strokeWidth: 1 });
  nodes.push({ kind: 'rect', x: 0.5, y: 6, w: 3, h: Math.max(0, h - 12), rx: 1.5, fill: m.accent });
  const x0 = pad + 4, innerW = w - x0 - pad;

  if (mode === 'compact') {
    const size = fitSize(m.value, clamp(h * 0.42, 11, 30), 8, innerW);
    nodes.push({ kind: 'text', x: x0, y: h / 2 + size * 0.36, text: fit(m.value, size, innerW), size, weight: 700, color: m.valueColor, anchor: 'start', role: m.valueRole });
    if (m.status) nodes.push({ kind: 'dot', x: w - pad * 0.7, y: pad * 0.7, r: 3, fill: m.status.color });
    return nodes;
  }

  let y = pad;
  const titleSize = clamp(h * 0.11, 9, 12);
  if (m.title) {
    y += titleSize;
    nodes.push({ kind: 'text', x: x0, y, text: fit(m.title, titleSize, innerW), size: titleSize, weight: 600, color: CARD_MUTED, anchor: 'start', role: 'title' });
  }
  const valueMax = mode === 'normal' && !m.rows.length ? clamp(h * 0.34, 14, 30) : clamp(h * 0.16, 14, 26);
  const valueSize = fitSize(m.value, valueMax, 9, innerW);
  y += valueSize * 1.15 + 2;
  nodes.push({ kind: 'text', x: x0, y, text: fit(m.value, valueSize, innerW), size: valueSize, weight: 700, color: m.valueColor, anchor: 'start', role: m.valueRole });
  const small = clamp(h * 0.085, 9, 11.5);
  if (m.caption) {
    y += small * 1.45;
    if (y < h - pad + 1) nodes.push({ kind: 'text', x: x0, y, text: fit(m.caption, small, innerW), size: small, weight: 400, color: CARD_MUTED, anchor: 'start', role: 'caption' });
  }
  const statusH = m.status ? small * 1.6 : 0;
  const lh = small * 1.5;
  for (const r of m.rows) {
    if (y + lh > h - pad - statusH + 1) break;
    y += lh;
    const vw = measureLine(r.value, { fontFamily: 'sans', fontSize: small });
    nodes.push({ kind: 'text', x: x0, y, text: fit(r.label, small, Math.max(10, innerW - vw - 6)), size: small, weight: 400, color: CARD_MUTED, anchor: 'start' });
    nodes.push({ kind: 'text', x: w - pad, y, text: fit(r.value, small, innerW * 0.7), size: small, weight: 600, color: r.color ?? CARD_FG, anchor: 'end', role: r.role });
  }
  if (m.status) nodes.push({ kind: 'text', x: x0, y: h - pad, text: fit(m.status.text, small, innerW), size: small, weight: 500, color: m.status.color, anchor: 'start', role: 'status' });
  return nodes;
}
