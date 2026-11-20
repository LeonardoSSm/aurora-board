/**
 * Codificador mínimo de GIF para testes (ciclo 6). Gera GIFs sintéticos — conteúdo e licença deste projeto
 * (equivalente a CC0), sem imagens de terceiros. Usado nos testes unitários e E2E.
 */

export interface GifFrame { pixels: number[]; delayCs: number }
export interface GifSpec {
  width: number;
  height: number;
  /** Paleta global [r,g,b][] com 2^n cores (n ≥ 1). */
  palette: [number, number, number][];
  frames: GifFrame[];
  /** undefined = sem extensão NETSCAPE (toca uma vez); 0 = infinito; N = repetições. */
  loop?: number;
}

function lzw(indices: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<string, number>();
  let next = eoi + 1;
  const reset = () => { dict = new Map(); for (let i = 0; i < clear; i++) dict.set(String(i), i); next = eoi + 1; codeSize = minCodeSize + 1; };
  const out: number[] = [];
  let acc = 0, bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) { out.push(acc & 0xff); acc >>= 8; bits -= 8; }
  };
  reset();
  emit(clear);
  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i]);
    const wk = `${w},${k}`;
    if (dict.has(wk)) { w = wk; continue; }
    emit(dict.get(w)!);
    if (next < 4096) {
      dict.set(wk, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else { emit(clear); reset(); }
    w = k;
  }
  emit(dict.get(w)!);
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);
  return out;
}

export function encodeGif(spec: GifSpec): Uint8Array {
  const bytes: number[] = [];
  const push16 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const depth = Math.max(1, Math.ceil(Math.log2(spec.palette.length)));
  bytes.push(...'GIF89a'.split('').map((c) => c.charCodeAt(0)));
  push16(spec.width); push16(spec.height);
  bytes.push(0x80 | ((depth - 1) << 4) | (depth - 1), 0, 0);
  for (let i = 0; i < 1 << depth; i++) bytes.push(...(spec.palette[i] ?? [0, 0, 0]));
  if (spec.loop !== undefined) {
    bytes.push(0x21, 0xff, 0x0b, ...'NETSCAPE2.0'.split('').map((c) => c.charCodeAt(0)), 0x03, 0x01);
    push16(spec.loop);
    bytes.push(0x00);
  }
  const minCode = Math.max(2, depth);
  for (const f of spec.frames) {
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    push16(f.delayCs);
    bytes.push(0x00, 0x00);
    bytes.push(0x2c); push16(0); push16(0); push16(spec.width); push16(spec.height); bytes.push(0x00);
    bytes.push(minCode);
    const data = lzw(f.pixels, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

const PALETTE: [number, number, number][] = [[255, 0, 0], [0, 0, 255], [0, 200, 0], [255, 255, 255]];
const solid = (w: number, h: number, idx: number) => Array.from({ length: w * h }, () => idx);

/** Vermelho ↔ azul, 64×64, 200 ms por quadro. 'once' = sem extensão de repetição (toca uma vez). */
export function loopingGif(loop: number | 'once' = 0, size = 64): Uint8Array {
  return encodeGif({ width: size, height: size, palette: PALETTE, loop: loop === 'once' ? undefined : loop, frames: [{ pixels: solid(size, size, 0), delayCs: 20 }, { pixels: solid(size, size, 1), delayCs: 20 }] });
}

export function staticGif(size = 32): Uint8Array {
  return encodeGif({ width: size, height: size, palette: PALETTE, frames: [{ pixels: solid(size, size, 2), delayCs: 0 }] });
}

export const toBase64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
