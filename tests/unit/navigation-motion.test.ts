/** Issue #12: trajeto de voo, durações por velocidade, preferência de animação e continuidade da viagem. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cameraCenter, centerOn, DEFAULT_NAVIGATION_PREFS, flightPath, MIN_ZOOM, sanitizeNavigationPrefs, SPEED_PROFILE, toWorldPoint, travelPlan, type Camera,
} from '../../src/core/camera';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { __setCameraTestHooks, animateCameraTo, isCameraAnimating, motionEnabled, panToWorldPoint } from '../../src/store/cameraMotion';
import { navigateToCheckpoint } from '../../src/store/checkpointActions';
import { createCheckpoint } from '../../src/core/checkpoints';

const vp = { width: 1000, height: 600 };
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

function fakeClock() {
  let t = 0;
  let cb: (() => void) | null = null;
  const c = {
    now: () => t,
    raf: (f: () => void) => { cb = f; return 1; },
    caf: () => { cb = null; },
    step(ms: number) { t += ms; const f = cb; cb = null; f?.(); },
    run(ms: number, frame = 16) { for (let k = 0; k < ms; k += frame) c.step(frame); },
  };
  return c;
}

describe('trajeto de voo (van Wijk)', () => {
  const a: Camera = { x: 0, y: 0, zoom: 1 };
  const screens = (n: number) => centerOn({ x: 500 + n * 1000, y: 300 }, 1, vp); // n larguras de tela à direita

  it('começa e termina exatamente nas câmeras de origem e destino', () => {
    const b = centerOn({ x: 20000, y: -9000 }, 2, vp);
    const p = flightPath(a, b, vp);
    expect(p.at(0)).toEqual(a);
    expect(p.at(1)).toEqual(b);
    expect(p.at(1.5)).toEqual(b);
  });

  it('o centro anda sempre na reta até o destino, sem ultrapassar', () => {
    const b = centerOn({ x: 20000, y: -9000 }, 0.5, vp);
    const p = flightPath(a, b, vp);
    const c0 = cameraCenter(a, vp), c1 = cameraCenter(b, vp);
    const len = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    let prev = 0;
    for (let u = 0.05; u < 1; u += 0.05) {
      const c = cameraCenter(p.at(u), vp);
      const cross = (c.x - c0.x) * (c1.y - c0.y) - (c.y - c0.y) * (c1.x - c0.x);
      expect(Math.abs(cross) / len).toBeLessThan(1e-3);
      const along = Math.hypot(c.x - c0.x, c.y - c0.y);
      expect(along).toBeGreaterThanOrEqual(prev - 1e-6); // monotônico
      expect(along).toBeLessThanOrEqual(len + 1e-6);
      prev = along;
    }
  });

  it('afastamento discreto em viagens curtas e maior nas longas', () => {
    const peak = (n: number) => Math.min(...Array.from({ length: 101 }, (_, i) => flightPath(a, screens(n), vp).at(i / 100).zoom));
    expect(peak(1)).toBeGreaterThan(0.95);
    expect(peak(3)).toBeGreaterThan(0.7);
    expect(peak(12)).toBeLessThan(0.5);
    expect(peak(12)).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it('só zoom: centro parado e zoom em escala logarítmica', () => {
    const b = centerOn(cameraCenter(a, vp), 4, vp);
    const p = flightPath(a, b, vp);
    const mid = p.at(0.5);
    near(mid.zoom, 2, 1e-9);
    const c = toWorldPoint({ x: 500, y: 300 }, mid);
    near(c.x, 500, 1e-6);
    near(c.y, 300, 1e-6);
  });

  it('valores sempre finitos, inclusive em distâncias enormes', () => {
    const p = flightPath(a, centerOn({ x: 9e8, y: -9e8 }, 8, vp), vp);
    for (let u = 0; u <= 1; u += 0.01) for (const v of Object.values(p.at(u))) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('durações por velocidade', () => {
  const a: Camera = { x: 0, y: 0, zoom: 1 };
  const far = centerOn({ x: 12500, y: 300 }, 1, vp), close = centerOn({ x: 800, y: 300 }, 1, vp);
  it('ficam nos limites de cada perfil e crescem com a distância', () => {
    for (const speed of ['fast', 'smooth', 'cinematic'] as const) {
      const p = SPEED_PROFILE[speed];
      const d1 = travelPlan(a, close, vp, speed).duration, d2 = travelPlan(a, far, vp, speed).duration;
      expect(d1).toBeGreaterThanOrEqual(p.min);
      expect(d2).toBeLessThanOrEqual(p.max);
      expect(d2).toBeGreaterThan(d1);
    }
  });
  it('Rápida < Suave < Cinematográfica', () => {
    const d = (s: 'fast' | 'smooth' | 'cinematic') => travelPlan(a, far, vp, s).duration;
    expect(d('fast')).toBeLessThan(d('smooth'));
    expect(d('smooth')).toBeLessThan(d('cinematic'));
  });
  it('viagem longa no Suave: entre 0,9 e 1,2 s (antes: teto de 650 ms)', () => {
    const d = travelPlan(a, far, vp).duration;
    expect(d).toBeGreaterThanOrEqual(900);
    expect(d).toBeLessThanOrEqual(1200);
  });
});

describe('preferência de navegação', () => {
  it('saneamento descarta valores inválidos', () => {
    expect(sanitizeNavigationPrefs(undefined)).toEqual(DEFAULT_NAVIGATION_PREFS);
    expect(sanitizeNavigationPrefs({ motion: 'turbo', speed: 99 })).toEqual(DEFAULT_NAVIGATION_PREFS);
    expect(sanitizeNavigationPrefs({ motion: 'always', speed: 'cinematic', extra: 1 })).toEqual({ motion: 'always', speed: 'cinematic' });
    expect(sanitizeNavigationPrefs('never')).toEqual(DEFAULT_NAVIGATION_PREFS);
  });

  describe('motionEnabled', () => {
    let reduce = false;
    beforeEach(() => {
      __setCameraTestHooks(null, null);
      vi.stubGlobal('window', { matchMedia: () => ({ matches: reduce }) });
      vi.stubGlobal('requestAnimationFrame', () => 1);
    });
    afterEach(() => { vi.unstubAllGlobals(); setState({ navigationPrefs: { ...DEFAULT_NAVIGATION_PREFS } }); });

    it('Sistema segue prefers-reduced-motion; Sempre anima mesmo com reduce; Nunca não anima', () => {
      reduce = false;
      setState({ navigationPrefs: { motion: 'system', speed: 'smooth' } });
      expect(motionEnabled()).toBe(true);
      reduce = true;
      expect(motionEnabled()).toBe(false);
      setState({ navigationPrefs: { motion: 'always', speed: 'smooth' } });
      expect(motionEnabled()).toBe(true);
      reduce = false;
      setState({ navigationPrefs: { motion: 'never', speed: 'smooth' } });
      expect(motionEnabled()).toBe(false);
    });
  });
});

describe('motor: viagem com o novo trajeto', () => {
  let clock: ReturnType<typeof fakeClock>;
  beforeEach(() => {
    setState({ ...initialEditorState, boardId: 'A', status: 'ready', viewport: vp, camera: { x: 0, y: 0, zoom: 1 }, elements: [], history: {}, checkpoints: [] });
    clock = fakeClock();
    __setCameraTestHooks(clock, true);
  });
  afterEach(() => __setCameraTestHooks(null, null));

  it('quadros intermediários interpolados e destino exato', () => {
    const target = centerOn({ x: 15000, y: 4000 }, 1, vp);
    animateCameraTo(target);
    const seen: Camera[] = [];
    for (let i = 0; i < 200 && isCameraAnimating(); i++) { clock.step(16); seen.push({ ...getState().camera }); }
    expect(seen.length).toBeGreaterThan(40); // ~1,1 s a 60 Hz
    const mids = seen.filter((c) => c.x !== 0 && c.x !== target.x);
    expect(mids.length).toBeGreaterThan(10);
    expect(getState().camera).toEqual(target);
  });

  it('sem saltos: nenhum quadro desloca o centro mais que ~1 tela (na escala do quadro)', () => {
    animateCameraTo(centerOn({ x: 15000, y: 4000 }, 1, vp));
    let prev = getState().camera;
    while (isCameraAnimating()) {
      clock.step(16);
      const c = getState().camera;
      const d = Math.hypot(cameraCenter(c, vp).x - cameraCenter(prev, vp).x, cameraCenter(c, vp).y - cameraCenter(prev, vp).y) * Math.min(c.zoom, prev.zoom);
      expect(d).toBeLessThan(vp.width);
      prev = c;
    }
  });

  it('novo destino durante a viagem parte do estado visual atual e termina no novo destino', () => {
    panToWorldPoint({ x: 20000, y: 0 });
    clock.run(300);
    const before = { ...getState().camera };
    panToWorldPoint({ x: -3000, y: 900 });
    clock.step(16);
    const after = getState().camera;
    // O primeiro quadro do novo trajeto fica colado ao último do anterior.
    const jump = Math.hypot(cameraCenter(after, vp).x - cameraCenter(before, vp).x, cameraCenter(after, vp).y - cameraCenter(before, vp).y) * after.zoom;
    expect(jump).toBeLessThan(150);
    clock.run(3000);
    expect(getState().camera).toEqual(centerOn({ x: -3000, y: 900 }, 1, vp));
  });

  it('checkpoint: destaque só depois de chegar; zoom salvo apenas com “restaurar zoom”', () => {
    const far = createCheckpoint({ name: 'Longe', x: 12000, y: 0, savedZoom: 2, restoreZoom: true }, 'cp_far');
    const plain = createCheckpoint({ name: 'Perto', x: 0, y: 0, savedZoom: 3, restoreZoom: false }, 'cp_plain');
    setState({ checkpoints: [far, plain] });
    navigateToCheckpoint('cp_far');
    clock.run(300);
    expect(getState().checkpointFlash).toBeNull();
    clock.run(2000);
    expect(getState().checkpointFlash?.id).toBe('cp_far');
    expect(getState().camera).toEqual(centerOn({ x: 12000, y: 0 }, 2, vp));
    navigateToCheckpoint('cp_plain');
    clock.run(2000);
    expect(getState().camera.zoom).toBe(2); // mantém o zoom atual
  });

  it('a viagem não altera elementos, checkpoints nem histórico', () => {
    const cp = createCheckpoint({ name: 'X', x: 9000, y: 9000 }, 'cp_x');
    setState({ checkpoints: [cp], history: {} });
    const before = { els: getState().elements, cps: getState().checkpoints, hist: getState().history };
    navigateToCheckpoint('cp_x');
    clock.run(3000);
    expect(getState().elements).toBe(before.els);
    expect(getState().checkpoints).toBe(before.cps);
    expect(getState().history).toBe(before.hist);
  });

  it('velocidade Cinematográfica dura mais que Rápida (preferência lida na hora)', () => {
    const run = (speed: 'fast' | 'cinematic') => {
      setState({ camera: { x: 0, y: 0, zoom: 1 }, navigationPrefs: { motion: 'system', speed } });
      animateCameraTo(centerOn({ x: 12000, y: 0 }, 1, vp));
      let n = 0;
      while (isCameraAnimating() && n < 500) { clock.step(16); n++; }
      return n;
    };
    expect(run('fast')).toBeLessThan(run('cinematic'));
  });
});
