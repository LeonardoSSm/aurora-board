/** Ciclo 6 — GIFs animados: leitura, repetição, primeiro quadro, decisão de exibição, persistência e exportação. */
import { describe, expect, it } from 'vitest';
import { firstFrameGif, inspectGif, withInfiniteLoop, GIF_LIMITS, describeLoop, dataURLBytes, bytesToDataURL, type GifInfo } from '../../src/core/gif';
import { decideDisplay, imageAnimationOf, sanitizeAnimationPrefs, DEFAULT_IMAGE_ANIMATION } from '../../src/core/animation';
import { encodeGif, loopingGif, staticGif } from '../fixtures/gifEncoder';
import { gifDisplay, staticImageURL } from '../../src/canvas/gifDisplay';
import { normalizeElement } from '../../src/persistence/migrations';
import { buildExport, parseImport } from '../../src/persistence/exportImport';
import { createBoard } from '../../src/core/elements';
import { checkImageBytes } from '../../src/core/media';

const info = (b: Uint8Array) => { const r = inspectGif(b); if (!r.ok) throw new Error(r.reason); return r as GifInfo; };

describe('inspectGif', () => {
  it('lê quadros, duração e repetição declarada', () => {
    const inf = info(loopingGif(0));
    expect(inf).toMatchObject({ width: 64, height: 64, frames: 2, durationMs: 400, animated: true, loop: { kind: 'infinite' }, tooHeavy: false });
    expect(info(loopingGif('once')).loop).toEqual({ kind: 'once' });
    expect(info(loopingGif(2)).loop).toEqual({ kind: 'count', repeats: 2 });
    expect(info(staticGif())).toMatchObject({ frames: 1, animated: false });
    expect(describeLoop({ kind: 'once' })).toBe('toca uma vez');
  });
  it('atraso 0/1 cs conta como 100 ms (como os navegadores)', () => {
    const g = encodeGif({ width: 2, height: 2, palette: [[0, 0, 0], [255, 255, 255]], loop: 0, frames: [{ pixels: [0, 0, 0, 0], delayCs: 0 }, { pixels: [1, 1, 1, 1], delayCs: 1 }] });
    expect(info(g).durationMs).toBe(200);
  });
  it('arquivos truncados ou corrompidos nunca lançam nem leem fora do buffer', () => {
    const g = loopingGif(0);
    for (let n = 0; n < g.length; n++) expect(() => inspectGif(g.subarray(0, n))).not.toThrow();
    let seed = 1;
    for (let i = 0; i < 2000; i++) {
      const c = g.slice();
      for (let k = 0; k < 4; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; c[6 + (seed % (c.length - 6))] = seed >> 16; }
      const r = inspectGif(c);
      if (r.ok) { expect(() => withInfiniteLoop(c, r)).not.toThrow(); expect(() => firstFrameGif(c, r)).not.toThrow(); }
    }
    expect(inspectGif(new Uint8Array([0x47, 0x49, 0x46]))).toMatchObject({ ok: false });
    expect(inspectGif(new TextEncoder().encode('GIF89a' + 'x'.repeat(20)))).toMatchObject({ ok: false });
  });
  it('GIF pesado demais (pixels × quadros) fica marcado para não animar', () => {
    const g = loopingGif(0, 4);
    const big = g.slice();
    big[6] = 0x20; big[7] = 0x4e; big[8] = 0x20; big[9] = 0x4e; // tela lógica 20 000 × 20 000
    const r = info(big);
    expect(r.width * r.height * r.frames).toBeGreaterThan(GIF_LIMITS.maxAnimatedPixels);
    expect(r.tooHeavy).toBe(true);
  });
});

describe('repetição contínua e primeiro quadro (sem alterar o original)', () => {
  it('GIF que toca uma vez ganha a extensão de repetição infinita; quadros intactos', () => {
    const once = loopingGif('once');
    const copy = once.slice();
    const out = withInfiniteLoop(once, info(once));
    expect(once).toEqual(copy); // original intacto
    const r = info(out);
    expect(r.loop).toEqual({ kind: 'infinite' });
    expect(r.frames).toBe(2);
    expect(r.durationMs).toBe(400);
    expect(out.length).toBe(once.length + 19);
    expect([...out.subarray(info(once).headerEnd + 19)]).toEqual([...once.subarray(info(once).headerEnd)]);
  });
  it('contador finito vira infinito; infinito não muda (mesma referência)', () => {
    const three = loopingGif(2);
    expect(info(withInfiniteLoop(three, info(three))).loop).toEqual({ kind: 'infinite' });
    const inf = loopingGif(0);
    expect(withInfiniteLoop(inf, info(inf))).toBe(inf);
  });
  it('primeiro quadro: GIF válido de 1 quadro', () => {
    const g = loopingGif(0);
    const f = info(firstFrameGif(g, info(g)));
    expect(f).toMatchObject({ frames: 1, animated: false, width: 64, height: 64 });
    expect(checkImageBytes(firstFrameGif(g, info(g)))).toMatchObject({ ok: true, kind: 'gif' });
  });
});

describe('decisão de exibição', () => {
  const anim = { animated: true, tooHeavy: false };
  const a = (playback: 'auto' | 'play' | 'pause', loop: 'infinite' | 'original' = 'infinite') => ({ playback, loop });
  it.each([
    [a('auto'), 'system', false, { mode: 'animate', loop: 'infinite' }],
    [a('auto'), 'system', true, { mode: 'static', reason: 'reduced-motion' }],
    [a('auto'), 'always', true, { mode: 'animate', loop: 'infinite' }],
    [a('auto'), 'never', false, { mode: 'static', reason: 'never' }],
    [a('play', 'original'), 'never', true, { mode: 'animate', loop: 'original' }],
    [a('pause'), 'always', false, { mode: 'static', reason: 'paused' }],
  ] as const)('%o / %s / reduzido=%s', (an, mode, reduced, expected) => {
    expect(decideDisplay(anim, an, { mode }, reduced)).toEqual(expected);
  });
  it('pesado demais é sempre estático; imagem parada não decide nada', () => {
    expect(decideDisplay({ animated: true, tooHeavy: true }, a('play'), { mode: 'always' }, false)).toEqual({ mode: 'static', reason: 'heavy' });
    expect(decideDisplay({ animated: false, tooHeavy: false }, a('auto'), { mode: 'always' }, false)).toBeNull();
  });
  it('preferências e campos inválidos voltam ao padrão', () => {
    expect(sanitizeAnimationPrefs({ mode: 'x' })).toEqual({ mode: 'system' });
    expect(imageAnimationOf({ playback: 'rápido', loop: 7 })).toEqual(DEFAULT_IMAGE_ANIMATION);
  });
});

describe('exibição, persistência e exportação', () => {
  it('variantes de exibição estáveis por arquivo; estático para exportação', () => {
    const url = bytesToDataURL(loopingGif('once'));
    const g1 = gifDisplay('asset_teste_1', url)!;
    expect(gifDisplay('asset_teste_1', url)).toBe(g1); // mesma URL a cada montagem (sem reinício visível)
    expect(g1.original).toBe(url);
    expect(info(dataURLBytes(g1.infinite)!).loop).toEqual({ kind: 'infinite' });
    expect(info(dataURLBytes(g1.firstFrame)!).frames).toBe(1);
    expect(staticImageURL('asset_teste_1', url)).toBe(g1.firstFrame);
    // Formato pelos bytes: GIF com tipo declarado errado continua reconhecido; PNG não é GIF.
    expect(gifDisplay('asset_teste_2', bytesToDataURL(loopingGif(0), 'application/octet-stream'))?.info.ok).toBe(true);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    expect(gifDisplay('asset_teste_3', png)).toBeNull();
    expect(staticImageURL('asset_teste_3', png)).toBe(png);
  });
  it('elemento com e sem animação; valor inválido não derruba a imagem', () => {
    const base = { type: 'image', id: 'img1', x: 0, y: 0, width: 64, height: 64, assetId: 'a1' };
    expect(normalizeElement(base).element).toMatchObject({ type: 'image', assetId: 'a1' });
    expect(normalizeElement({ ...base, animation: { playback: 'pause', loop: 'original' } }).element).toMatchObject({ animation: { playback: 'pause', loop: 'original' } });
    expect(normalizeElement({ ...base, animation: { playback: 'explodir' } }).element).toMatchObject({ type: 'image', animation: { playback: 'auto', loop: 'infinite' } });
  });
  it('backup JSON preserva o GIF original byte a byte e a escolha de animação', () => {
    const bytes = loopingGif('once');
    const dataURL = bytesToDataURL(bytes);
    const board = createBoard('ws', 'GIFs', '');
    board.elements = [normalizeElement({ type: 'image', id: 'img1', x: 0, y: 0, width: 64, height: 64, assetId: 'asset_gif', animation: { playback: 'play', loop: 'original' } }).element!];
    const json = buildExport([board], [{ id: 'asset_gif', name: 'laco.gif', mimeType: 'image/gif', size: bytes.length, dataURL, createdAt: 0 }]);
    const r = parseImport(json, 'ws');
    expect(r.assets[0].dataURL).toBe(dataURL);
    expect(dataURLBytes(r.assets[0].dataURL)).toEqual(bytes);
    expect(r.boards[0].elements[0]).toMatchObject({ animation: { playback: 'play', loop: 'original' } });
  });
});
