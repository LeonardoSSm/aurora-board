/** Exportação do quadro (ou seleção) para SVG e PNG. Usa os mesmos caminhos da renderização em tela. */
import kalamUrl from '@fontsource/kalam/files/kalam-latin-400-normal.woff2?url';
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import loraUrl from '@fontsource/lora/files/lora-latin-400-normal.woff2?url';
import type { AuroraElement, ElementStyle, FontFamily } from '../core/schema';
import { isLinear } from '../core/schema';
import { FONT_FAMILIES, LINE_HEIGHT } from '../core/elements';
import { getCommonBounds } from '../core/geometry';
import { boundTextBox, measureLine, wrapText } from '../core/text';
import { elementParts, linearLocalPoints } from './shapes';
import { summarizeElement, getWidget } from '../widgets/registry';
import { getAsset } from '../store/actions';

const FONT_URLS: Record<FontFamily, { url: string; family: string }> = {
  hand: { url: kalamUrl, family: 'Kalam' },
  sans: { url: interUrl, family: 'Inter Variable' },
  mono: { url: monoUrl, family: 'JetBrains Mono' },
  serif: { url: loraUrl, family: 'Lora' },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function fontFaceCSS(families: Set<FontFamily>): Promise<string> {
  const rules: string[] = [];
  for (const f of families) {
    try {
      const buf = await (await fetch(FONT_URLS[f].url)).arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      rules.push(`@font-face{font-family:"${FONT_URLS[f].family}";src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");}`);
    } catch {
      /* fonte indisponível: o SVG usa fallback */
    }
  }
  return rules.join('');
}

function textLines(lines: string[], x: number, y: number, width: number, style: ElementStyle, color?: string, fontSize = style.fontSize): string {
  const anchor = style.textAlign === 'center' ? 'middle' : style.textAlign === 'right' ? 'end' : 'start';
  const tx = style.textAlign === 'center' ? x + width / 2 : style.textAlign === 'right' ? x + width : x;
  const lh = fontSize * LINE_HEIGHT;
  return `<text font-family='${esc(FONT_FAMILIES[style.fontFamily].css)}' font-size="${fontSize}" fill="${esc(color ?? (style.textColor || style.strokeColor))}" text-anchor="${anchor}">${lines
    .map((l, i) => `<tspan x="${tx}" y="${y + i * lh + fontSize * 0.95}" xml:space="preserve">${esc(l)}</tspan>`)
    .join('')}</text>`;
}

function partsSVG(el: AuroraElement): string {
  return elementParts(el)
    // Todos os atributos escapados (S1-SEC-007): cores vêm do quadro e podem ter sido manipuladas num backup.
    .map((p) => `<path d="${esc(String(p.d))}" fill="${esc(p.fill ?? 'none')}" stroke="${esc(p.stroke ?? 'none')}"${p.strokeWidth ? ` stroke-width="${Number(p.strokeWidth) || 0}"` : ''}${p.dash ? ` stroke-dasharray="${esc(String(p.dash))}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
}

async function elementSVG(el: AuroraElement): Promise<string> {
  const op = el.style.opacity / 100;
  if (isLinear(el)) {
    let label = '';
    if (el.text) {
      const pts = linearLocalPoints(el);
      const mid = pts[Math.floor(pts.length / 2)];
      const prev = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
      const m = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { x: (mid.x + prev.x) / 2, y: (mid.y + prev.y) / 2 };
      const fs = Math.max(12, el.style.fontSize * 0.8);
      const w = Math.max(...el.text.split('\n').map((l) => measureLine(l, { ...el.style, fontSize: fs })));
      label = `<rect x="${m.x - w / 2 - 4}" y="${m.y - fs * 0.7}" width="${w + 8}" height="${fs * 1.4}" fill="#0c1420" rx="4"/>` + textLines([el.text], m.x - w / 2, m.y - fs * 0.65, w, { ...el.style, textAlign: 'left' }, undefined, fs);
    }
    return `<g transform="translate(${el.x} ${el.y})" opacity="${op}">${partsSVG(el)}${label}</g>`;
  }
  const rot = el.angle ? ` rotate(${(el.angle * 180) / Math.PI} ${el.width / 2} ${el.height / 2})` : '';
  let inner = '';
  if (el.type === 'image') {
    const a = await getAsset(el.assetId);
    inner = a ? `<image href="${esc(a.dataURL)}" width="${el.width}" height="${el.height}" preserveAspectRatio="none"/>` : `<rect width="${el.width}" height="${el.height}" fill="#182436"/>`;
  } else if (el.type === 'text') {
    const lines = el.autoSize ? el.text.split('\n') : wrapText(el.text, el.style, el.width - 4);
    inner = textLines(lines, 2, 0, el.width - 4, el.style);
  } else if (el.type === 'widget' && getWidget(el.widgetType)?.exportSVG) {
    // Widget com exportação fiel (ex.: AI Tile com logo): mesmo layout da tela.
    const p = getWidget(el.widgetType)!;
    try {
      inner = await p.exportSVG!(p.sanitize(el.data), el);
    } catch {
      inner = `<rect width="${el.width}" height="${el.height}" rx="12" fill="#182436" stroke="#2e405a"/>`;
    }
  } else if (el.type === 'widget') {
    const p = getWidget(el.widgetType);
    const body = wrapText(summarizeElement(el).slice(0, 1200), { fontFamily: 'sans', fontSize: 12 }, el.width - 24).slice(0, Math.max(1, Math.floor((el.height - 56) / 16)));
    inner =
      `<rect width="${el.width}" height="${el.height}" rx="12" fill="#182436" stroke="#2e405a"/>` +
      `<rect width="${el.width}" height="3" fill="${esc(p?.accent ?? '#8fa6c8')}"/>` +
      textLines([p?.name.toUpperCase() ?? 'WIDGET'], 12, 10, el.width - 24, { ...el.style, fontFamily: 'sans', textAlign: 'left' }, p?.accent ?? '#8fa6c8', 9) +
      textLines([el.title], 12, 22, el.width - 24, { ...el.style, fontFamily: 'sans', textAlign: 'left' }, '#edf3fc', 13) +
      textLines(body, 12, 48, el.width - 24, { ...el.style, fontFamily: 'sans', textAlign: 'left' }, '#c5d3e6', 12);
  } else {
    inner = partsSVG(el);
    if (el.type === 'frame') inner += textLines([el.text || 'Frame'], 0, -22, el.width, { ...el.style, fontFamily: 'sans', textAlign: 'left' }, '#8ea3bf', 13);
    else if (el.text) {
      const box = boundTextBox(el);
      const lines = wrapText(el.text, el.style, box.width);
      const h = lines.length * el.style.fontSize * LINE_HEIGHT;
      const y = el.style.verticalAlign === 'top' ? box.y : el.style.verticalAlign === 'bottom' ? box.y + box.height - h : box.y + (box.height - h) / 2;
      inner += textLines(lines, box.x, y, box.width, el.style);
    }
  }
  return `<g transform="translate(${el.x} ${el.y})${rot}" opacity="${op}">${inner}</g>`;
}

export async function exportSVG(elements: AuroraElement[], opts: { background: boolean; padding?: number } = { background: true }): Promise<{ svg: string; width: number; height: number }> {
  const box = getCommonBounds(elements);
  if (!box) throw new Error('Nada para exportar.');
  const pad = opts.padding ?? 32;
  const x = box.minX - pad - 30, y = box.minY - pad - 30;
  const width = Math.ceil(box.maxX - box.minX + (pad + 30) * 2), height = Math.ceil(box.maxY - box.minY + (pad + 30) * 2);
  const families = new Set<FontFamily>(elements.map((e) => e.style.fontFamily));
  families.add('sans');
  const css = await fontFaceCSS(families);
  const body = (await Promise.all(elements.map(elementSVG))).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"><defs><style>${css}</style></defs>${opts.background ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#0c1420"/>` : ''}${body}</svg>`;
  return { svg, width, height };
}

export async function exportPNG(elements: AuroraElement[], opts: { background: boolean; scale?: number } = { background: true }): Promise<Blob> {
  const { svg, width, height } = await exportSVG(elements, opts);
  const scale = Math.min(opts.scale ?? 2, Math.sqrt(16_000_000 / (width * height)) || 1);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('Falha ao rasterizar SVG.')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar PNG (imagens externas podem bloquear a exportação).'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
