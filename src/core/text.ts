/** Medição e quebra de texto (canvas quando disponível; aproximação em ambientes sem DOM). */
import type { ElementStyle, TextElement } from './schema';
import { FONT_FAMILIES, LINE_HEIGHT } from './elements';

let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;

function getCtx() {
  if (ctx !== undefined) return ctx;
  try {
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
    else ctx = null;
  } catch {
    ctx = null;
  }
  return ctx;
}

export function fontString(style: Pick<ElementStyle, 'fontFamily' | 'fontSize'>): string {
  return `${style.fontSize}px ${FONT_FAMILIES[style.fontFamily].css}`;
}

export function measureLine(text: string, style: Pick<ElementStyle, 'fontFamily' | 'fontSize'>): number {
  const c = getCtx();
  if (!c) return text.length * style.fontSize * (style.fontFamily === 'mono' ? 0.6 : 0.55);
  c.font = fontString(style);
  return c.measureText(text).width;
}

/** Quebra o texto em linhas que caibam em `maxWidth` (respeita quebras manuais). */
export function wrapText(text: string, style: Pick<ElementStyle, 'fontFamily' | 'fontSize'>, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) { out.push(para); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measureLine(candidate.trimEnd(), style) <= maxWidth || !line) {
        if (!line && measureLine(word, style) > maxWidth && word.trim()) {
          // Palavra maior que a largura: quebra por caracteres.
          let chunk = '';
          for (const ch of word) {
            if (measureLine(chunk + ch, style) > maxWidth && chunk) { out.push(chunk); chunk = ch; } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function measureTextBlock(text: string, style: Pick<ElementStyle, 'fontFamily' | 'fontSize'>, maxWidth = Infinity) {
  const lines = wrapText(text || ' ', style, maxWidth);
  const width = Math.max(...lines.map((l) => measureLine(l, style)), style.fontSize * 0.5);
  return { lines, width, height: lines.length * style.fontSize * LINE_HEIGHT };
}

/** Ajusta dimensões de um elemento de texto ao conteúdo. */
export function fitTextElement(el: TextElement): TextElement {
  const pad = 2;
  if (el.autoSize) {
    const m = measureTextBlock(el.text, el.style);
    return { ...el, width: Math.ceil(m.width) + pad * 2, height: Math.ceil(m.height) };
  }
  const m = measureTextBlock(el.text, el.style, el.width - pad * 2);
  return { ...el, height: Math.ceil(m.height) };
}

export const TEXT_PADDING = 8;

/** Caixa interna onde o texto de uma forma é desenhado (coordenadas locais ao elemento). */
export function boundTextBox(el: { type: string; width: number; height: number }) {
  const w = el.width, h = el.height, p = TEXT_PADDING;
  if (el.type === 'ellipse') {
    const ix = (w * (1 - Math.SQRT1_2)) / 2, iy = (h * (1 - Math.SQRT1_2)) / 2;
    return { x: ix + p / 2, y: iy + p / 2, width: Math.max(4, w - 2 * ix - p), height: Math.max(4, h - 2 * iy - p) };
  }
  if (el.type === 'diamond') {
    return { x: w / 4 + p / 2, y: h / 4 + p / 2, width: Math.max(4, w / 2 - p), height: Math.max(4, h / 2 - p) };
  }
  if (el.type === 'sticky') return { x: p + 6, y: p + 6, width: Math.max(4, w - 2 * p - 12), height: Math.max(4, h - 2 * p - 12) };
  return { x: p, y: p, width: Math.max(4, w - 2 * p), height: Math.max(4, h - 2 * p) };
}

/** Largura total da forma para que a caixa de texto interna tenha `boxWidth`. */
function shapeWidthForBox(type: string, boxWidth: number): number {
  const p = TEXT_PADDING;
  if (type === 'ellipse') return (boxWidth + p) / Math.SQRT1_2;
  if (type === 'diamond') return (boxWidth + p) * 2;
  if (type === 'sticky') return boxWidth + 2 * p + 12;
  return boxWidth + 2 * p;
}

/**
 * Ajusta a forma ao texto interno: cresce em altura para caber as linhas e — com `growWidth` —
 * alarga (mantendo o centro) quando uma palavra sozinha não cabe, evitando quebrar no meio da palavra.
 * No redimensionamento manual usa-se `growWidth: false` para respeitar a largura escolhida.
 */
export function fitShapeToText<T extends { type: string; x?: number; width: number; height: number; y: number; text: string; style: ElementStyle }>(el: T, opts: { growWidth?: boolean } = {}): T {
  if (!el.text) return el;
  if (opts.growWidth !== false) {
    const longest = Math.max(0, ...el.text.split(/\s+/).filter(Boolean).map((w) => measureLine(w, el.style)));
    const box0 = boundTextBox(el);
    if (longest > box0.width) {
      const w = Math.ceil(shapeWidthForBox(el.type, longest + 2));
      el = { ...el, width: w, ...(typeof el.x === 'number' ? { x: el.x - (w - el.width) / 2 } : {}) };
    }
  }
  const box = boundTextBox(el);
  const needed = measureTextBlock(el.text, el.style, box.width).height;
  if (needed <= box.height + 0.5) return el;
  const p = TEXT_PADDING;
  let h: number;
  if (el.type === 'ellipse') h = (needed + p) / Math.SQRT1_2;
  else if (el.type === 'diamond') h = (needed + p) * 2;
  else if (el.type === 'sticky') h = needed + 2 * p + 12;
  else h = needed + 2 * p;
  return { ...el, height: Math.ceil(h) };
}
