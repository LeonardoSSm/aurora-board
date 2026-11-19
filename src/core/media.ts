/**
 * Classificação de mídias e documentos por CONTEÚDO (ciclo S1).
 *
 * Nada aqui confia no nome, na extensão, no MIME declarado ou no MIME do cabeçalho de um data URL: todos vêm do
 * usuário ou de um backup de terceiros. A decisão de como exibir um arquivo é tomada pelos bytes.
 *
 * Política de exibição (ver docs/SECURITY.md › Documentos e mídias):
 * - imagens raster (PNG, JPEG, GIF, WebP, BMP, AVIF) e SVG → `<img>` (contexto de imagem: sem scripts, sem rede);
 * - texto → `<pre>` como texto (nunca HTML interpretado);
 * - PDF e qualquer outro formato → sem prévia embutida, apenas download;
 * - download SEMPRE como `application/octet-stream`: abrir o link numa aba nunca renderiza conteúdo ativo
 *   (HTML, SVG, XML) com a origem do app.
 */

export type SniffedKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'pdf' | 'svg' | 'text' | 'binary' | 'empty';

export const RASTER_MIME: Record<'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/** Bytes parecem texto (UTF-8/ASCII sem NUL e com poucos caracteres de controle)? Olha só o início. */
function looksTextual(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl <= n * 0.02;
}

/** Tipo real pelos primeiros bytes. */
export function sniffBytes(b: Uint8Array): SniffedKind {
  if (!b.length) return 'empty';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM' && b.length > 26) return 'bmp';
  if (ascii(b, 4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(b, 8, 12))) return 'avif';
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (looksTextual(b)) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase();
    // SVG: documento XML cuja raiz é <svg>. Comentários/doctype/processamento antes da raiz são permitidos.
    const body = head.replace(/^(<\?xml[^>]*>|<!--[\s\S]*?-->|<!doctype[^>]*>|\s)+/g, '');
    if (body.startsWith('<svg')) return 'svg';
    return 'text';
  }
  return 'binary';
}

export interface ParsedDataURL { mime: string; bytes: Uint8Array }

/** Decodifica um data URL (base64 ou percent-encoded). Lança erro claro se malformado. */
export function parseDataURL(dataURL: string): ParsedDataURL {
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) throw new Error('Arquivo corrompido (data URL inválido).');
  const comma = dataURL.indexOf(',');
  if (comma < 0) throw new Error('Arquivo corrompido (data URL sem conteúdo).');
  const meta = dataURL.slice(5, comma);
  const body = dataURL.slice(comma + 1);
  const parts = meta.split(';');
  const mime = (parts[0] || 'text/plain').trim().toLowerCase();
  const isB64 = parts.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
  let bytes: Uint8Array;
  try {
    if (isB64) {
      const bin = atob(body.replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
  } catch {
    throw new Error('Arquivo corrompido (conteúdo do data URL ilegível).');
  }
  return { mime, bytes };
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ini|yaml|yml|toml|xml|html?|css|js|ts|tsx|jsx|py|sql|sh)$/i;

export type PreviewKind = 'image' | 'text' | 'none';

export interface MediaVerdict {
  /** Tipo real detectado pelos bytes. */
  sniffed: SniffedKind;
  /** Como exibir dentro do app. */
  preview: PreviewKind;
  /** MIME seguro para a prévia (`<img>`), derivado do conteúdo — nunca do metadado. */
  previewMime: string;
  /** Metadados declarados divergem do conteúdo real (exibido como aviso). */
  mismatch: boolean;
  /** Mensagem para o usuário quando não há prévia. */
  note: string;
}

/** Decide a exibição de um documento a partir dos bytes; nome/MIME só ajudam a escolher entre "texto" e "nada". */
export function classifyDocument(bytes: Uint8Array, declaredMime: string, name: string): MediaVerdict {
  const sniffed = sniffBytes(bytes);
  const declared = (declaredMime || '').toLowerCase();
  const raster = (RASTER_MIME as Record<string, string>)[sniffed];
  if (raster) {
    return { sniffed, preview: 'image', previewMime: raster, mismatch: !!declared && !declared.startsWith('image/'), note: '' };
  }
  if (sniffed === 'svg') {
    // SVG só é exibido como imagem (<img>): scripts, eventos e recursos externos não rodam nesse contexto.
    const declaredSvg = declared === 'image/svg+xml' || /\.svg$/i.test(name);
    return declaredSvg
      ? { sniffed, preview: 'image', previewMime: 'image/svg+xml', mismatch: false, note: '' }
      : { sniffed, preview: 'text', previewMime: 'text/plain', mismatch: true, note: '' };
  }
  if (sniffed === 'pdf') {
    return { sniffed, preview: 'none', previewMime: '', mismatch: !!declared && declared !== 'application/pdf', note: 'Prévia de PDF desativada por segurança. Baixe o arquivo para abrir.' };
  }
  if (sniffed === 'text') {
    const declaredText = declared.startsWith('text/') || declared === 'application/json' || declared === 'application/xml' || TEXT_EXT.test(name);
    // Texto é sempre mostrado como texto; se o metadado alegava outro formato (ex.: PDF), avisa.
    return { sniffed, preview: 'text', previewMime: 'text/plain', mismatch: !declaredText, note: '' };
  }
  if (sniffed === 'empty') return { sniffed, preview: 'none', previewMime: '', mismatch: false, note: 'Arquivo vazio.' };
  return { sniffed, preview: 'none', previewMime: '', mismatch: false, note: 'Sem prévia para este formato. Baixe o arquivo para abrir.' };
}

/* ------------------------------------------------------------------ */
/* Imagens: tipo e dimensões pelo cabeçalho (sem decodificar)          */
/* ------------------------------------------------------------------ */

/** Limites contra "bombas de descompressão": arquivo pequeno que vira gigabytes ao decodificar. */
export const IMAGE_LIMITS = { maxPixels: 100_000_000, maxSide: 30_000 } as const;

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const i32le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/** Largura × altura lidas do cabeçalho (PNG, GIF, JPEG, WebP, BMP). `null` se desconhecido/truncado. */
export function imageDimensions(b: Uint8Array, kind: SniffedKind = sniffBytes(b)): { width: number; height: number } | null {
  try {
    switch (kind) {
      case 'png': return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
      case 'gif': return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
      case 'bmp': return b.length >= 26 ? { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) } : null;
      case 'webp': {
        const chunk = ascii(b, 12, 16);
        if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (chunk === 'VP8L' && b.length >= 25) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) }; }
        if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        return null;
      }
      case 'jpeg': {
        let o = 2;
        while (o + 9 < b.length) {
          if (b[o] !== 0xff) { o++; continue; }
          const m = b[o + 1];
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
          const len = u16be(b, o + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(b, o + 7), height: u16be(b, o + 5) };
          if (len < 2) return null;
          o += 2 + len;
        }
        return null;
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

export type ImageVerdict =
  | { ok: true; kind: SniffedKind; width: number | null; height: number | null }
  | { ok: false; reason: string };

/** Decide se bytes podem ser exibidos como imagem (formato real + dimensões dentro do limite). */
export function checkImageBytes(head: Uint8Array): ImageVerdict {
  const kind = sniffBytes(head);
  if (!(kind in RASTER_MIME) && kind !== 'svg') return { ok: false, reason: 'O arquivo não é uma imagem válida.' };
  const dim = imageDimensions(head, kind);
  if (dim && (dim.width > IMAGE_LIMITS.maxSide || dim.height > IMAGE_LIMITS.maxSide || dim.width * dim.height > IMAGE_LIMITS.maxPixels)) {
    return { ok: false, reason: `Imagem grande demais para exibir com segurança (${dim.width.toLocaleString('pt-BR')} × ${dim.height.toLocaleString('pt-BR')} px).` };
  }
  return { ok: true, kind, width: dim?.width ?? null, height: dim?.height ?? null };
}

/** Primeiros bytes de um data URL sem decodificá-lo inteiro (cabeçalhos de imagem ficam no início). */
export function dataURLHead(dataURL: string, maxBytes = 256 * 1024): Uint8Array {
  const comma = dataURL.indexOf(',');
  if (!dataURL.startsWith('data:') || comma < 0) return new Uint8Array();
  const isB64 = /;base64$/i.test(dataURL.slice(0, comma));
  if (!isB64) {
    try { return new TextEncoder().encode(decodeURIComponent(dataURL.slice(comma + 1, comma + 1 + maxBytes * 3))).subarray(0, maxBytes); } catch { return new Uint8Array(); }
  }
  const chars = Math.ceil(maxBytes / 3) * 4;
  const slice = dataURL.slice(comma + 1, comma + 1 + chars).replace(/[^A-Za-z0-9+/]/g, '');
  try {
    const bin = atob(slice.slice(0, slice.length - (slice.length % 4)));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

/** Blob para download: tipo neutro, o navegador nunca renderiza o conteúdo na origem do app. */
export function downloadableBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
}

/** Nome de arquivo seguro para o atributo `download` (sem caminhos, controles ou nomes vazios). */
export function safeDownloadName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 180);
  return clean || 'arquivo';
}
