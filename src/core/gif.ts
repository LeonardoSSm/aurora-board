/**
 * GIF animado (ciclo 6): leitura da estrutura (sem decodificar pixels), repetição e primeiro quadro.
 *
 * - `inspectGif`: quadros, duração, repetição declarada (extensão NETSCAPE2.0), dimensões — com checagem de
 *   limites em todos os acessos. Arquivo malformado → `{ ok: false }`, nunca exceção nem leitura fora do buffer.
 * - `withInfiniteLoop`: cópia que repete para sempre (só para EXIBIR; o arquivo original é o que fica salvo).
 * - `firstFrameGif`: cópia com só o primeiro quadro (prévia estática determinística para movimento reduzido,
 *   pausa e exportação PNG/SVG).
 *
 * Repetição no GIF: sem a extensão NETSCAPE2.0 o navegador toca UMA vez; com contador 0, para sempre; com
 * contador N, os navegadores tocam N repetições além da primeira (o valor é exibido como está no arquivo).
 */

export const GIF_LIMITS = {
  /** Quadros lidos antes de desistir (estrutura). */
  maxFrames: 10_000,
  /** Pixels decodificados somados (largura × altura × quadros): acima disso o GIF fica estático. */
  maxAnimatedPixels: 400_000_000,
};

export type GifLoop = { kind: 'once' } | { kind: 'infinite' } | { kind: 'count'; repeats: number };

export interface GifInfo {
  ok: true;
  width: number;
  height: number;
  frames: number;
  /** Duração de um ciclo em ms (atrasos 0/1 cs contados como 100 ms, como os navegadores). */
  durationMs: number;
  loop: GifLoop;
  animated: boolean;
  /** Pesado demais para animar com segurança (fica estático). */
  tooHeavy: boolean;
  /** Fim do cabeçalho + tabela de cores global (onde a extensão de repetição é inserida). */
  headerEnd: number;
  /** Posição do contador de repetição dentro da extensão NETSCAPE2.0, se houver. */
  loopCountOffset: number | null;
  /** Fim do primeiro quadro (descritor + dados), para a prévia estática. */
  firstFrameEnd: number;
}

export type GifResult = GifInfo | { ok: false; reason: string };

const ascii = (b: Uint8Array, at: number, n: number) => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

export function isGif(b: Uint8Array): boolean {
  const sig = ascii(b, 0, 6);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

/** Pula sub-blocos (tamanho + dados) até o terminador 0. Retorna a posição depois do terminador ou -1. */
function skipSubBlocks(b: Uint8Array, p: number): number {
  for (let guard = 0; guard < 10_000_000; guard++) {
    if (p >= b.length) return -1;
    const n = b[p];
    if (n === 0) return p + 1;
    p += 1 + n;
  }
  return -1;
}

export function inspectGif(b: Uint8Array): GifResult {
  if (!isGif(b)) return { ok: false, reason: 'Não é um GIF.' };
  if (b.length < 13) return { ok: false, reason: 'GIF truncado.' };
  const width = u16(b, 6), height = u16(b, 8);
  const packed = b[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));
  if (p > b.length) return { ok: false, reason: 'GIF truncado (tabela de cores).' };
  const headerEnd = p;
  let frames = 0, durationCs = 0, pendingDelay: number | null = null;
  let loop: GifLoop = { kind: 'once' };
  let loopCountOffset: number | null = null;
  let firstFrameEnd = -1;
  let trailer = false;
  while (p < b.length) {
    const tag = b[p];
    if (tag === 0x3b) { trailer = true; break; }
    if (tag === 0x21) {
      if (p + 2 > b.length) return { ok: false, reason: 'GIF truncado (extensão).' };
      const label = b[p + 1];
      if (label === 0xf9 && p + 8 <= b.length && b[p + 2] === 4) pendingDelay = u16(b, p + 4);
      if (label === 0xff && b[p + 2] === 11) {
        const id = ascii(b, p + 3, 11);
        if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && p + 19 <= b.length && b[p + 14] === 3 && b[p + 15] === 1) {
          const count = u16(b, p + 16);
          loopCountOffset = p + 16;
          loop = count === 0 ? { kind: 'infinite' } : { kind: 'count', repeats: count };
        }
      }
      const next = skipSubBlocks(b, p + 2);
      if (next < 0) return { ok: false, reason: 'GIF truncado (extensão).' };
      p = next;
      continue;
    }
    if (tag === 0x2c) {
      if (p + 10 > b.length) return { ok: false, reason: 'GIF truncado (quadro).' };
      const lp = b[p + 9];
      p += 10;
      if (lp & 0x80) p += 3 * (1 << ((lp & 0x07) + 1));
      if (p + 1 > b.length) return { ok: false, reason: 'GIF truncado (quadro).' };
      const next = skipSubBlocks(b, p + 1); // +1: tamanho mínimo do código LZW
      if (next < 0) return { ok: false, reason: 'GIF truncado (dados do quadro).' };
      p = next;
      frames++;
      if (frames === 1) firstFrameEnd = p;
      const d = pendingDelay ?? 0;
      durationCs += d <= 1 ? 10 : d;
      pendingDelay = null;
      if (frames > GIF_LIMITS.maxFrames) return { ok: false, reason: `GIF com mais de ${GIF_LIMITS.maxFrames} quadros.` };
      continue;
    }
    return { ok: false, reason: 'GIF malformado (bloco desconhecido).' };
  }
  if (!frames) return { ok: false, reason: 'GIF sem quadros.' };
  // Sem trailer: navegadores toleram (arquivo cortado no fim); a estrutura lida até aqui é válida.
  void trailer;
  const animated = frames > 1;
  return {
    ok: true, width, height, frames, durationMs: durationCs * 10, loop, animated,
    tooHeavy: animated && width * height * frames > GIF_LIMITS.maxAnimatedPixels,
    headerEnd, loopCountOffset, firstFrameEnd,
  };
}

const NETSCAPE_INFINITE = new Uint8Array([0x21, 0xff, 0x0b, ...'NETSCAPE2.0'.split('').map((c) => c.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00]);

/** Cópia que repete para sempre (para exibição). Sem mudança quando já é infinito ou não é animado. */
export function withInfiniteLoop(b: Uint8Array, info: GifInfo): Uint8Array {
  if (!info.animated || info.loop.kind === 'infinite') return b;
  if (info.loopCountOffset !== null) {
    const out = b.slice();
    out[info.loopCountOffset] = 0;
    out[info.loopCountOffset + 1] = 0;
    return out;
  }
  const out = new Uint8Array(b.length + NETSCAPE_INFINITE.length);
  out.set(b.subarray(0, info.headerEnd), 0);
  out.set(NETSCAPE_INFINITE, info.headerEnd);
  out.set(b.subarray(info.headerEnd), info.headerEnd + NETSCAPE_INFINITE.length);
  return out;
}

/** Cópia só com o primeiro quadro (extensões antes dele preservadas, repetição removida). */
export function firstFrameGif(b: Uint8Array, info: GifInfo): Uint8Array {
  if (!info.animated) return b;
  const head = b.subarray(0, info.firstFrameEnd);
  const out = new Uint8Array(head.length + 1);
  out.set(head, 0);
  out[head.length] = 0x3b;
  // Neutraliza a extensão de repetição (irrelevante com 1 quadro, mas evita ambiguidade).
  if (info.loopCountOffset !== null && info.loopCountOffset < head.length) { out[info.loopCountOffset] = 1; out[info.loopCountOffset + 1] = 0; }
  return out;
}

export function describeLoop(loop: GifLoop): string {
  if (loop.kind === 'infinite') return 'repete para sempre';
  if (loop.kind === 'once') return 'toca uma vez';
  return `repete ${loop.repeats} vez(es)`;
}

/** Bytes de um data URL base64 (inteiro). */
export function dataURLBytes(dataURL: string): Uint8Array | null {
  const comma = dataURL.indexOf(',');
  if (!dataURL.startsWith('data:') || comma < 0 || !/;base64$/i.test(dataURL.slice(0, comma))) return null;
  try {
    const bin = atob(dataURL.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToDataURL(b: Uint8Array, mime = 'image/gif'): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}
