/**
 * Política de animação de imagens (GIF) — ciclo 6.
 *
 * Decisão por imagem, nesta ordem:
 * 1. O bloco escolheu “Pausar” → estático (primeiro quadro). “Reproduzir” → anima, mesmo com movimento reduzido.
 * 2. “Automático” segue a preferência geral: “Sempre” anima; “Nunca” estático; “Sistema” anima, exceto quando o
 *    sistema pede movimento reduzido (prefers-reduced-motion).
 * 3. GIF pesado demais (pixels × quadros) fica estático com aviso, qualquer que seja a escolha.
 *
 * Pausar mostra o PRIMEIRO quadro (um `<img>` não permite congelar no quadro atual com precisão).
 */
import type { GifInfo } from './gif';

export type Playback = 'auto' | 'play' | 'pause';
export type LoopMode = 'infinite' | 'original';
export interface ImageAnimation { playback: Playback; loop: LoopMode }
export const DEFAULT_IMAGE_ANIMATION: ImageAnimation = { playback: 'auto', loop: 'infinite' };

export type AnimationMode = 'system' | 'always' | 'never';
export interface AnimationPrefs { mode: AnimationMode }
export const DEFAULT_ANIMATION_PREFS: AnimationPrefs = { mode: 'system' };

export function sanitizeAnimationPrefs(raw: unknown): AnimationPrefs {
  const m = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return { mode: m === 'always' || m === 'never' ? m : 'system' };
}

export function imageAnimationOf(raw: unknown): ImageAnimation {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    playback: o.playback === 'play' || o.playback === 'pause' ? o.playback : 'auto',
    loop: o.loop === 'original' ? 'original' : 'infinite',
  };
}

export type DisplayChoice =
  | { mode: 'animate'; loop: LoopMode }
  | { mode: 'static'; reason: 'paused' | 'reduced-motion' | 'never' | 'heavy' };

export function decideDisplay(info: Pick<GifInfo, 'animated' | 'tooHeavy'>, anim: ImageAnimation, prefs: AnimationPrefs, reducedMotion: boolean): DisplayChoice | null {
  if (!info.animated) return null; // imagem parada: nada a decidir
  if (info.tooHeavy) return { mode: 'static', reason: 'heavy' };
  if (anim.playback === 'pause') return { mode: 'static', reason: 'paused' };
  if (anim.playback === 'play') return { mode: 'animate', loop: anim.loop };
  if (prefs.mode === 'never') return { mode: 'static', reason: 'never' };
  if (prefs.mode === 'system' && reducedMotion) return { mode: 'static', reason: 'reduced-motion' };
  return { mode: 'animate', loop: anim.loop };
}

export const STATIC_REASON_LABEL: Record<Extract<DisplayChoice, { mode: 'static' }>['reason'], string> = {
  paused: 'GIF pausado',
  'reduced-motion': 'GIF parado (movimento reduzido)',
  never: 'GIF parado (animações desligadas)',
  heavy: 'GIF pesado demais para animar',
};
