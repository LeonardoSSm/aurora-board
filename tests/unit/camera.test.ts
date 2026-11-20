/** Câmera: conversões, âncora, interpolação, sensibilidade da roda e motor de animação (relógio controlado). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approachZoom, centerOn, clampZoom, fitBox, interpolateCamera, isValidCamera, isWheelNotch, MAX_ZOOM, MIN_ZOOM, nextZoomStep,
  normalizeWheel, sanitizeZoomPrefs, toScreenPoint, toWorldPoint, travelPlan, wheelZoomFactor, zoomAround, DEFAULT_ZOOM_PREFS, type Camera,
} from '../../src/core/camera';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { __setCameraTestHooks, animateCameraTo, cancelCameraAnimation, cameraTarget, isCameraAnimating, panCamera, panToWorldPoint, zoomTowardAnchor } from '../../src/store/cameraMotion';
import { panBy, zoomStep, zoomToFit } from '../../src/store/actions';
import { createShape } from '../../src/core/elements';

const vp = { width: 1000, height: 600 };
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Relógio manual: `step(ms)` avança o tempo e roda o quadro pendente. */
function fakeClock() {
  let t = 0;
  let cb: (() => void) | null = null;
  const c = {
    now: () => t,
    raf: (f: () => void) => { cb = f; return 1; },
    caf: () => { cb = null; },
    step(ms: number) { t += ms; const f = cb; cb = null; f?.(); },
    run(ms: number, frame = 16) { for (let k = 0; k < ms; k += frame) c.step(frame); },
    pending: () => cb !== null,
  };
  return c;
}

describe('conversões e âncora', () => {
  it('tela ↔ mundo são inversas', () => {
    const c: Camera = { x: 123.5, y: -40, zoom: 1.7 };
    const w = { x: 300, y: -250 };
    const s = toScreenPoint(w, c);
    expect(s).toEqual({ x: 300 * 1.7 + 123.5, y: -250 * 1.7 - 40 });
    near(toWorldPoint(s, c).x, w.x);
    near(toWorldPoint(s, c).y, w.y);
  });
  it('zoom ancorado mantém o ponto do mundo sob o cursor', () => {
    const c: Camera = { x: 40, y: 10, zoom: 1 };
    const anchor = { x: 700, y: 220 };
    const before = toWorldPoint(anchor, c);
    for (const z of [0.1, 0.37, 2, 7.9]) {
      const after = toWorldPoint(anchor, zoomAround(c, z, anchor));
      near(after.x, before.x, 1e-9);
      near(after.y, before.y, 1e-9);
    }
  });
  it('limites de zoom e câmeras inválidas', () => {
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 99, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(isValidCamera({ x: 0, y: NaN, zoom: 1 })).toBe(false);
    expect(isValidCamera({ x: 0, y: 0, zoom: Infinity })).toBe(false);
  });
  it('centralizar: câmera = W/2 − x·z', () => {
    expect(centerOn({ x: 500, y: -200 }, 2, vp)).toEqual({ zoom: 2, x: 500 - 1000, y: 300 + 400 });
    const f = fitBox({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, vp, 1);
    expect(f.zoom).toBe(1);
  });
});

describe('interpolação', () => {
  const a: Camera = { x: 0, y: 0, zoom: 1 }, b = centerOn({ x: 20000, y: -9000 }, 2, vp);
  it('começa e termina exatamente nas câmeras de origem e destino', () => {
    expect(interpolateCamera(a, b, 0, vp)).toEqual(a);
    expect(interpolateCamera(a, b, 1, vp, 0.3)).toEqual(b);
  });
  it('zoom em escala logarítmica e centro sempre na reta até o destino', () => {
    const mid = interpolateCamera({ x: 0, y: 0, zoom: 1 }, centerOn({ x: 0, y: 0 }, 4, vp), 0.5, vp);
    near(mid.zoom, 2, 1e-9);
    const c0 = toWorldPoint({ x: 500, y: 300 }, a), c1 = toWorldPoint({ x: 500, y: 300 }, b);
    for (const t of [0.1, 0.4, 0.8]) {
      const c = toWorldPoint({ x: 500, y: 300 }, interpolateCamera(a, b, t, vp, 0.3));
      const cross = (c.x - c0.x) * (c1.y - c0.y) - (c.y - c0.y) * (c1.x - c0.x);
      expect(Math.abs(cross) / Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeLessThan(1e-6);
    }
  });
  it('issue #12: viagens longas duram o suficiente para serem vistas (≤ 1,2 s no Suave); curtas são breves', () => {
    const far = travelPlan(a, b, vp), close = travelPlan(a, centerOn({ x: 30, y: 0 }, 1, vp), vp);
    expect(far.duration).toBeGreaterThanOrEqual(900);
    expect(far.duration).toBeLessThanOrEqual(1200);
    expect(close.duration).toBeGreaterThanOrEqual(280);
    expect(close.duration).toBeLessThan(400);
  });
  it('aproximação exponencial depende do tempo, não da taxa de quadros', () => {
    let z60 = 1, z30 = 1;
    for (let i = 0; i < 6; i++) z60 = approachZoom(z60, 2, 1000 / 60);
    for (let i = 0; i < 3; i++) z30 = approachZoom(z30, 2, 1000 / 30);
    near(z60, z30, 1e-9);
  });
});

describe('roda e sensibilidade', () => {
  const notch = { deltaX: 0, deltaY: 100, deltaMode: 0 };
  it('um clique de roda no padrão (suave) muda ~11%, não 63%', () => {
    const f = wheelZoomFactor({ ...notch, deltaY: -100 }, DEFAULT_ZOOM_PREFS);
    expect(f).toBeGreaterThan(1.08);
    expect(f).toBeLessThan(1.15);
    // Ctrl + clique de roda (antes: exp(−1) ≈ 63%) usa o mesmo ganho de clique.
    expect(wheelZoomFactor({ ...notch, deltaY: -100, ctrlKey: true }, DEFAULT_ZOOM_PREFS)).toBeCloseTo(f, 10);
  });
  it('pequeno movimento = pequena mudança; sentidos opostos se anulam', () => {
    const small = wheelZoomFactor({ deltaX: 0, deltaY: -4, deltaMode: 0 }, DEFAULT_ZOOM_PREFS);
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(1.01);
    const up = wheelZoomFactor({ ...notch, deltaY: -100 }, DEFAULT_ZOOM_PREFS), down = wheelZoomFactor({ ...notch }, DEFAULT_ZOOM_PREFS);
    near(up * down, 1, 1e-12);
  });
  it('eventos anormais são limitados; linhas e páginas viram pixels', () => {
    expect(wheelZoomFactor({ deltaX: 0, deltaY: -5000, deltaMode: 0 }, DEFAULT_ZOOM_PREFS)).toBeLessThan(1.3);
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 48 });
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 900)).toEqual({ dx: 0, dy: 900 });
    expect(normalizeWheel({ deltaX: NaN, deltaY: Infinity, deltaMode: 0 })).toEqual({ dx: 0, dy: 0 });
    expect(wheelZoomFactor({ deltaX: 0, deltaY: NaN, deltaMode: 0 }, DEFAULT_ZOOM_PREFS)).toBe(1);
  });
  it('pinça (Ctrl + eventos fracionários) tem ganho próprio e continua responsiva', () => {
    expect(isWheelNotch({ deltaX: 0, deltaY: -2.5, deltaMode: 0, ctrlKey: true })).toBe(false);
    const pinch = wheelZoomFactor({ deltaX: 0, deltaY: -10.5, deltaMode: 0, ctrlKey: true }, DEFAULT_ZOOM_PREFS);
    expect(pinch).toBeGreaterThan(1.05);
    expect(pinch).toBeLessThan(1.12);
  });
  it('presets ordenados e personalizado limitado; preferências inválidas viram padrão', () => {
    const f = (preset: 'precise' | 'smooth' | 'normal' | 'fast') => wheelZoomFactor({ ...notch, deltaY: -100 }, { preset, custom: 1 });
    expect(f('precise')).toBeLessThan(f('smooth'));
    expect(f('smooth')).toBeLessThan(f('normal'));
    expect(f('normal')).toBeLessThan(f('fast'));
    expect(sanitizeZoomPrefs({ preset: 'turbo', custom: 99 })).toEqual({ preset: 'smooth', custom: 2.5 });
    expect(sanitizeZoomPrefs(undefined)).toEqual(DEFAULT_ZOOM_PREFS);
    expect(sanitizeZoomPrefs({ preset: 'custom', custom: NaN })).toEqual({ preset: 'custom', custom: 1 });
  });
  it('passos dos botões', () => {
    expect(nextZoomStep(1, 1)).toBe(1.1);
    expect(nextZoomStep(1, -1)).toBe(0.9);
    expect(nextZoomStep(8, 1)).toBe(MAX_ZOOM);
    expect(nextZoomStep(0.1, -1)).toBe(MIN_ZOOM);
  });
});

describe('motor de animação', () => {
  let clock: ReturnType<typeof fakeClock>;
  beforeEach(() => {
    setState({ ...initialEditorState, boardId: 'A', status: 'ready', viewport: vp, camera: { x: 0, y: 0, zoom: 1 }, elements: [], history: {} });
    clock = fakeClock();
    __setCameraTestHooks(clock, true);
  });
  afterEach(() => __setCameraTestHooks(null, null));

  it('zoom da roda: âncora parada em todos os quadros e alvo exato no fim', () => {
    const anchor = { x: 640, y: 180 };
    const w = toWorldPoint(anchor, getState().camera);
    zoomTowardAnchor(1.5, anchor);
    for (let i = 0; i < 40 && isCameraAnimating(); i++) {
      clock.step(16);
      const p = toWorldPoint(anchor, getState().camera);
      near(p.x, w.x, 1e-9);
      near(p.y, w.y, 1e-9);
    }
    expect(isCameraAnimating()).toBe(false);
    expect(getState().camera.zoom).toBe(1.5);
  });

  it('eventos seguidos acumulam num único movimento; inverter não dá salto; parar não continua', () => {
    const a = { x: 500, y: 300 };
    zoomTowardAnchor(1.1, a);
    zoomTowardAnchor(1.1, a);
    expect(cameraTarget().zoom).toBeCloseTo(1.21, 10);
    clock.step(16);
    const z1 = getState().camera.zoom;
    zoomTowardAnchor(1 / 1.21, a); // inverte
    clock.step(16);
    const z2 = getState().camera.zoom;
    expect(Math.abs(Math.log(z2 / z1))).toBeLessThan(0.1);
    clock.run(800);
    expect(getState().camera.zoom).toBeCloseTo(1, 12);
    expect(clock.pending()).toBe(false);
  });

  it('pan durante o zoom desloca a âncora junto; viagem é cancelada pelo pan', () => {
    zoomTowardAnchor(2, { x: 500, y: 300 });
    clock.step(16);
    panCamera(30, -10);
    clock.run(800);
    const c = getState().camera;
    expect(c.zoom).toBe(2);
    const w = toWorldPoint({ x: 530, y: 290 }, c);
    near(w.x, 500, 1e-6);
    near(w.y, 300, 1e-6);
    animateCameraTo(centerOn({ x: 5000, y: 0 }, 1, vp));
    clock.step(16);
    panBy(5, 5);
    expect(isCameraAnimating()).toBe(false);
  });

  it('viagem termina exatamente no destino; novo destino substitui o anterior', () => {
    panToWorldPoint({ x: 3000, y: 2000 });
    clock.run(100);
    panToWorldPoint({ x: -800, y: 400 });
    clock.run(1000);
    expect(getState().camera).toEqual(centerOn({ x: -800, y: 400 }, 1, vp));
    for (const v of Object.values(getState().camera)) expect(Number.isFinite(v)).toBe(true);
  });

  it('cancelar congela a câmera onde está, sem quadros residuais', () => {
    animateCameraTo(centerOn({ x: 9000, y: 9000 }, 3, vp));
    clock.run(80);
    cancelCameraAnimation();
    const c = { ...getState().camera };
    clock.run(500);
    expect(getState().camera).toEqual(c);
  });

  it('trocar de quadro: a animação antiga não escreve no novo quadro', () => {
    animateCameraTo(centerOn({ x: 9000, y: 0 }, 1, vp));
    clock.step(16);
    setState({ boardId: 'B', camera: { x: 1, y: 2, zoom: 1 } });
    clock.run(500);
    expect(getState().camera).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(isCameraAnimating()).toBe(false);
  });

  it('movimento reduzido: tudo imediato', () => {
    __setCameraTestHooks(clock, false);
    zoomTowardAnchor(2, { x: 0, y: 0 });
    expect(getState().camera.zoom).toBe(2);
    panToWorldPoint({ x: 100, y: 100 });
    expect(getState().camera).toEqual(centerOn({ x: 100, y: 100 }, 2, vp));
    expect(isCameraAnimating()).toBe(false);
  });

  it('botões acumulam a partir do destino; Enquadrar tudo anima até o enquadramento', () => {
    zoomStep(1);
    zoomStep(1);
    expect(cameraTarget().zoom).toBe(1.25);
    clock.run(400);
    expect(getState().camera.zoom).toBe(1.25);
    setState({ elements: [createShape('rectangle', 1000, 1000, 200, 100)] });
    zoomToFit();
    clock.run(800);
    expect(getState().camera).toEqual(fitBox({ minX: 1000, minY: 1000, maxX: 1200, maxY: 1100 }, vp, 1));
  });
});
