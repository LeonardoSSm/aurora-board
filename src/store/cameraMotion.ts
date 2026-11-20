/**
 * Motor único de movimento da câmera. Um só laço de requestAnimationFrame por vez; cada quadro grava
 * a câmera no estado (a MESMA usada para desenhar e para o hit-test). Pedidos novos substituem o
 * destino — não há fila de animações atrasadas.
 *
 * Dois tipos de movimento:
 * - zoom contínuo (roda): o alvo de zoom acumula os eventos e a câmera se aproxima dele com uma curva
 *   exponencial dependente do tempo; a âncora (ponto sob o cursor) fica parada em TODOS os quadros.
 * - viagem (botões, enquadrar, checkpoints): interpolação de centro e zoom com duração limitada.
 *
 * Cancelamento: novo pan/arrasto/pinça (controller), troca de quadro, Esc, mudança de viewport. Movimento
 * imediato quando a preferência pessoal `navigationPrefs.motion` é “Nunca”, ou “Sistema” com
 * `prefers-reduced-motion: reduce`; “Sempre” anima mesmo assim (issue #12). Cada animação guarda o quadro em que começou e para
 * sozinha se o quadro mudar, sem escrever câmera em outro quadro.
 */
import { clampZoom, approachZoom, easeInOutCubic, interpolateCamera, isValidCamera, toWorldPoint, travelPlan, zoomAround, centerOn, fitBox, type Camera, type FlightPath } from '../core/camera';
import type { Box, Vec } from '../core/geometry';
import { getState, setState } from './editor';

interface Clock { now(): number; raf(cb: () => void): number; caf(id: number): void }

const defaultClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  raf: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
  caf: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)),
};
let clock: Clock = defaultClock;
let motionOverride: boolean | null = null;

/** Testes: relógio controlado e movimento forçado (true/false) ou automático (null). */
export function __setCameraTestHooks(c: Clock | null, motion: boolean | null = null) {
  cancelCameraAnimation();
  clock = c ?? defaultClock;
  motionOverride = motion;
}

/** O sistema operacional/navegador pede movimento reduzido? */
export function systemPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animar? Fora de um navegador (sem requestAnimationFrame), nunca. Depois, a preferência pessoal:
 * “Nunca” → imediato; “Sempre” → anima mesmo com movimento reduzido no sistema; “Sistema” (padrão) →
 * anima, exceto com `prefers-reduced-motion: reduce`.
 */
export function motionEnabled(): boolean {
  if (motionOverride !== null) return motionOverride;
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return false;
  const mode = getState().navigationPrefs?.motion ?? 'system';
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return !systemPrefersReducedMotion();
}

type Anim =
  | { kind: 'zoom'; boardId: string; target: number; anchor: Vec; anchorWorld: Vec; last: number }
  | { kind: 'travel'; boardId: string; from: Camera; to: Camera; start: number; duration: number; path: FlightPath | null; onDone?: () => void };

let anim: Anim | null = null;
let frame = 0;

export function isCameraAnimating() {
  return anim !== null;
}

/** Para onde a câmera está indo (ou a atual, sem animação). */
export function cameraTarget(): Camera {
  const s = getState();
  if (anim?.kind === 'travel') return anim.to;
  if (anim?.kind === 'zoom') return zoomAround(s.camera, anim.target, anim.anchor);
  return s.camera;
}

export function cancelCameraAnimation() {
  if (frame) clock.caf(frame);
  frame = 0;
  anim = null;
}

function write(c: Camera) {
  if (isValidCamera(c)) setState({ camera: c });
}

function tick() {
  frame = 0;
  const a = anim;
  if (!a) return;
  const s = getState();
  if (s.boardId !== a.boardId) { anim = null; return; } // trocou de quadro: não escreve no outro
  const now = clock.now();
  if (a.kind === 'zoom') {
    const z = approachZoom(s.camera.zoom, a.target, now - a.last);
    a.last = now;
    const done = Math.abs(Math.log(z / a.target)) < 1e-3;
    const zoom = done ? a.target : z;
    // Âncora exata em todos os quadros: x = âncora − mundo·zoom.
    write({ zoom, x: a.anchor.x - a.anchorWorld.x * zoom, y: a.anchor.y - a.anchorWorld.y * zoom });
    if (done) { anim = null; return; }
  } else {
    const t = Math.min(1, (now - a.start) / a.duration);
    const e = easeInOutCubic(t);
    write(a.path ? a.path.at(e) : interpolateCamera(a.from, a.to, e, s.viewport));
    if (t >= 1) { anim = null; a.onDone?.(); return; }
  }
  frame = clock.raf(tick);
}

function run() {
  if (!frame) frame = clock.raf(tick);
}

/**
 * Zoom contínuo ancorado (roda). Acumula no alvo atual: vários eventos seguidos viram um só movimento,
 * e inverter o sentido muda o alvo na hora (sem salto e sem continuar aproximando depois de parar).
 */
export function zoomTowardAnchor(factor: number, anchor: Vec) {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const s = getState();
  if (!motionEnabled()) { cancelCameraAnimation(); write(zoomAround(s.camera, s.camera.zoom * factor, anchor)); return; }
  const base = anim?.kind === 'zoom' ? anim.target : s.camera.zoom;
  const target = clampZoom(base * factor);
  if (anim?.kind !== 'zoom') cancelCameraAnimation();
  anim = { kind: 'zoom', boardId: s.boardId, target, anchor, anchorWorld: toWorldPoint(anchor, s.camera), last: anim?.kind === 'zoom' ? anim.last : clock.now() };
  run();
}

/** Pan imediato (arrasto, touchpad). Durante um zoom contínuo, desloca a âncora junto (sem salto). */
export function panCamera(dx: number, dy: number) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const c = getState().camera;
  if (anim?.kind === 'zoom') anim.anchor = { x: anim.anchor.x + dx, y: anim.anchor.y + dy };
  else if (anim) cancelCameraAnimation();
  write({ ...c, x: c.x + dx, y: c.y + dy });
}

/**
 * Viagem até uma câmera. Sem `duration`: trajeto de voo (afastamento discreto proporcional à distância) com a
 * duração da velocidade escolhida (Suave: ~0,3–1,2 s). Com `duration` (botões de zoom): interpolação direta
 * e curta. Parte SEMPRE da câmera visível atual — um novo destino durante uma viagem não dá salto.
 */
export function animateCameraTo(target: Camera, opts: { onDone?: () => void; duration?: number } = {}) {
  const s = getState();
  const to = { ...target, zoom: clampZoom(target.zoom) };
  if (!isValidCamera(to)) return;
  cancelCameraAnimation();
  if (!motionEnabled()) { write(to); opts.onDone?.(); return; }
  const from = s.camera;
  if (opts.duration !== undefined) {
    anim = { kind: 'travel', boardId: s.boardId, from, to, start: clock.now(), duration: Math.max(1, opts.duration), path: null, onDone: opts.onDone };
  } else {
    const plan = travelPlan(from, to, s.viewport, s.navigationPrefs?.speed ?? 'smooth');
    anim = { kind: 'travel', boardId: s.boardId, from, to, start: clock.now(), duration: Math.max(1, plan.duration), path: plan.path, onDone: opts.onDone };
  }
  run();
}

/** Centraliza um ponto do mundo (zoom atual por padrão). */
export function panToWorldPoint(world: Vec, opts: { zoom?: number; onDone?: () => void } = {}) {
  const s = getState();
  animateCameraTo(centerOn(world, opts.zoom ?? cameraTarget().zoom, s.viewport), { onDone: opts.onDone });
}

export function fitCameraToBounds(box: Box, maxZoom = 1, padding = 80) {
  animateCameraTo(fitBox(box, getState().viewport, maxZoom, padding));
}

/** Zoom discreto (botões/atalhos) ancorado no centro, com transição curta. */
export function zoomToLevel(zoom: number, anchor?: Vec) {
  const s = getState();
  const a = anchor ?? { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  animateCameraTo(zoomAround(s.camera, zoom, a), { duration: 180 });
}
