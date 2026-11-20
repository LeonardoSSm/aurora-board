/** Controles de GIF animado (ciclo 6): por imagem no painel de propriedades e preferência geral. */
import type { AuroraElement } from '../core/schema';
import { useEditor } from '../store/editor';
import { cachedAsset, setAnimationPrefs, setImageAnimation } from '../store/actions';
import { gifDisplay } from '../canvas/gifDisplay';
import { describeLoop, type GifInfo } from '../core/gif';
import { imageAnimationOf, type AnimationMode, type LoopMode, type Playback } from '../core/animation';
import { Label, Segmented } from './primitives';

function gifInfoOf(el: AuroraElement): GifInfo | null {
  if (el.type !== 'image') return null;
  const a = cachedAsset(el.assetId);
  const g = a ? gifDisplay(el.assetId, a.dataURL) : null;
  return g && g.info.ok && g.info.animated ? g.info : null;
}

/** Aparece quando a seleção tem GIF animado. */
export function GifAnimationControls({ els }: { els: AuroraElement[] }) {
  const gifs = els.map((e) => ({ el: e, info: gifInfoOf(e) })).filter((x): x is { el: Extract<AuroraElement, { type: 'image' }>; info: GifInfo } => !!x.info && x.el.type === 'image');
  if (!gifs.length) return null;
  const ids = gifs.map((g) => g.el.id);
  const anims = gifs.map((g) => imageAnimationOf(g.el.animation));
  const same = <K extends 'playback' | 'loop'>(k: K) => (anims.every((a) => a[k] === anims[0][k]) ? anims[0][k] : undefined);
  const one = gifs.length === 1 ? gifs[0].info : null;
  return (
    <div data-testid="gif-controls">
      <Label>GIF animado{gifs.length > 1 ? ` (${gifs.length})` : ''}</Label>
      {one && (
        <div className="text-[11px] text-soft mb-1.5" data-testid="gif-info">
          {one.frames} quadros · ciclo de {(one.durationMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s · no arquivo: {describeLoop(one.loop)}{one.tooHeavy ? ' · pesado demais para animar (fica parado)' : ''}
        </div>
      )}
      <Segmented<Playback> label="Reprodução do GIF" value={same('playback') as Playback} onChange={(playback) => setImageAnimation(ids, { playback })} options={[{ value: 'auto', label: 'Automático', title: 'Segue a preferência geral (e o movimento reduzido do sistema)' }, { value: 'play', label: 'Reproduzir', title: 'Anima mesmo com movimento reduzido' }, { value: 'pause', label: 'Pausar', title: 'Mostra o primeiro quadro' }]} />
      <div className="mt-1.5">
        <Segmented<LoopMode> label="Repetição do GIF" value={same('loop') as LoopMode} onChange={(loop) => setImageAnimation(ids, { loop })} options={[{ value: 'infinite', label: 'Repetir sempre' }, { value: 'original', label: 'Como no arquivo' }]} />
      </div>
      <div className="text-[10px] text-soft mt-1">Pausar mostra o primeiro quadro. O arquivo original fica salvo sem alteração; PNG/SVG exportam o primeiro quadro e o backup JSON mantém o GIF animado.</div>
    </div>
  );
}

/** Preferência geral (todos os quadros). */
export function AnimationPreference() {
  const prefs = useEditor((s) => s.animationPrefs);
  return (
    <div className="mt-3" data-testid="animation-prefs">
      <Label>Animações (GIF)</Label>
      <Segmented<AnimationMode> label="Animações de GIF" value={prefs.mode} onChange={(mode) => void setAnimationPrefs({ mode })} options={[{ value: 'system', label: 'Sistema', title: 'Anima, exceto com movimento reduzido ativado no sistema' }, { value: 'always', label: 'Sempre' }, { value: 'never', label: 'Nunca' }]} />
      <div className="text-[10px] text-soft mt-1">“Sistema” respeita o movimento reduzido do sistema operacional. Cada GIF pode ser reproduzido ou pausado no painel dele.</div>
    </div>
  );
}
