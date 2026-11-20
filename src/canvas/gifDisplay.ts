/**
 * URLs de exibição de GIFs, ESTÁVEIS por arquivo (ciclo 6).
 *
 * O navegador compartilha o estado da animação entre `<img>` com a mesma URL: ao sair e voltar à tela (o canvas
 * desmonta o que está fora da vista) o GIF continua de onde estava. Por isso cada variante (original, repetição
 * contínua, primeiro quadro) é calculada UMA vez por arquivo e reutilizada — nunca recriada por montagem.
 * O arquivo salvo (asset) é sempre o original: as variantes existem só na memória.
 */
import { bytesToDataURL, dataURLBytes, firstFrameGif, inspectGif, isGif, withInfiniteLoop, type GifResult } from '../core/gif';
import { dataURLHead } from '../core/media';

export interface GifDisplay {
  info: GifResult;
  original: string;
  infinite: string;
  firstFrame: string;
}

const cache = new Map<string, GifDisplay | null>();
const MAX_ENTRIES = 300;

/** Variantes de exibição de um asset; null se não for GIF. Cache por id do asset (o conteúdo de um asset não muda). */
export function gifDisplay(assetId: string, dataURL: string): GifDisplay | null {
  if (cache.has(assetId)) return cache.get(assetId)!;
  let out: GifDisplay | null = null;
  // O formato vem dos bytes (o tipo declarado pode faltar ou mentir).
  if (isGif(dataURLHead(dataURL, 16))) {
    const bytes = dataURLBytes(dataURL);
    const info = bytes ? inspectGif(bytes) : ({ ok: false, reason: 'Arquivo ilegível.' } as const);
    if (bytes && info.ok) {
      out = {
        info,
        original: dataURL,
        infinite: info.animated && info.loop.kind !== 'infinite' ? bytesToDataURL(withInfiniteLoop(bytes, info)) : dataURL,
        firstFrame: info.animated ? bytesToDataURL(firstFrameGif(bytes, info)) : dataURL,
      };
    } else {
      // GIF que não conseguimos ler: o navegador decide (sem variantes).
      out = { info, original: dataURL, infinite: dataURL, firstFrame: dataURL };
    }
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(assetId, out);
  return out;
}

/** Primeiro quadro para exportação estática (PNG/SVG); o próprio data URL quando não é GIF animado. */
export function staticImageURL(assetId: string, dataURL: string): string {
  const g = gifDisplay(assetId, dataURL);
  return g && g.info.ok && g.info.animated ? g.firstFrame : dataURL;
}
