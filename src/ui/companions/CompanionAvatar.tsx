/**
 * AI Companions (issue #13): personagem animado ligado a estados REAIS (requisição, hover, mini chat aberto).
 * Microanimações de standby são locais e raras (timer aleatório controlado), nunca chamam a API e param com a
 * aba oculta, preferência “Desligadas”, movimento reduzido (padrão “Sistema”) ou acima do limite de instâncias.
 * Toda a animação é CSS (transform/opacity) por atributos — o React não re-renderiza a cada quadro.
 */
import { useEffect, useRef, useState } from 'react';
import { effectiveMotion, MAX_ANIMATED, nextMicro, visualState, REPLYING_MS, type MicroAction, type RequestState } from '../../core/companion';
import { useEditor } from '../../store/editor';
import { CharacterSvg, FallbackAvatar, presetById } from '../../companions/presets';
import { useSystemReducedMotion } from '../NavigationPrefs';

/** Instâncias animando agora (limite global). */
const animating = new Set<symbol>();

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export function CompanionAvatar({ preset, name, req, hover, open, size = 'canvas' }: { preset: string; name: string; req: RequestState; hover: boolean; open: boolean; size?: 'canvas' | 'dock' }) {
  const prefs = useEditor((s) => s.companionPrefs);
  const reduced = useSystemReducedMotion();
  const visible = usePageVisible();
  const motion = effectiveMotion(prefs, reduced);
  const p = presetById(preset);
  const [now, setNow] = useState(() => Date.now());
  const [micro, setMicro] = useState<MicroAction | null>(null);
  const token = useRef(Symbol('companion'));
  const [slot, setSlot] = useState(false);

  // Reserva de vaga entre as instâncias animadas (o dock usa retrato estático para não disputar vagas).
  const wantsMotion = motion !== 'off' && visible && size === 'canvas' && !!p;
  useEffect(() => {
    const t = token.current;
    if (!wantsMotion) { animating.delete(t); setSlot(false); return; }
    if (animating.size < MAX_ANIMATED || animating.has(t)) { animating.add(t); setSlot(true); }
    else setSlot(false);
    return () => { animating.delete(t); };
  }, [wantsMotion]);

  // “Respondeu” dura um instante; reavalia quando acabar (sem laço contínuo).
  useEffect(() => {
    if (!req.repliedAt) return;
    const left = req.repliedAt + REPLYING_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 20);
    return () => clearTimeout(t);
  }, [req.repliedAt]);

  const state = visualState(req, { hover, open }, Math.max(now, Date.now() - 1));

  // Microanimações só em standby, com vaga, visível e preferência ligada.
  const animate = slot && motion !== 'off';
  const intensity = motion === 'off' ? 'discreet' : motion;
  useEffect(() => {
    if (!animate || state !== 'idle') { setMicro(null); return; }
    let last: MicroAction | null = null;
    let t: ReturnType<typeof setTimeout>;
    let clear: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const n = nextMicro(intensity, last, Math.random);
      t = setTimeout(() => {
        last = n.action;
        setMicro(n.action);
        clear = setTimeout(() => setMicro(null), 1600);
        schedule();
      }, n.delay);
    };
    schedule();
    return () => { clearTimeout(t); clearTimeout(clear); };
  }, [animate, state, intensity]);

  return (
    <div
      className="companion w-full h-full"
      data-testid="companion-avatar"
      data-state={state}
      data-micro={micro ?? undefined}
      data-motion={animate ? intensity : 'off'}
      data-animated={animate ? 'true' : 'false'}
    >
      {p ? <CharacterSvg preset={p} label={`${name} — ${state}`} /> : <FallbackAvatar name={name} />}
    </div>
  );
}

/** Testes/benchmark: quantas instâncias estão animando. */
export function animatingCount() { return animating.size; }
