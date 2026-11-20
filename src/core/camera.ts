/**
 * Matemática da câmera (pura, sem DOM). Convenção do Aurora Board:
 *   tela = mundo × zoom + (x, y)        mundo = (tela − (x, y)) ÷ zoom
 * Tudo o que move a câmera (roda, botões, enquadrar, checkpoints) passa por aqui, para que a câmera
 * desenhada seja exatamente a usada no hit-test.
 */
import type { Box, Vec } from './geometry';

export interface Camera { x: number; y: number; zoom: number }
export interface Viewport { width: number; height: number }

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const clampZoom = (z: number) => (Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);

export function isValidCamera(c: unknown): c is Camera {
  const o = c as Camera;
  return !!o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.zoom) && o.zoom >= MIN_ZOOM && o.zoom <= MAX_ZOOM;
}

export const toScreenPoint = (p: Vec, c: Camera): Vec => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y });
export const toWorldPoint = (p: Vec, c: Camera): Vec => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom });

/** Zoom mantendo o ponto do mundo sob `anchor` (tela) exatamente sob `anchor`. */
export function zoomAround(c: Camera, nextZoom: number, anchor: Vec): Camera {
  const z = clampZoom(nextZoom);
  return { zoom: z, x: anchor.x - ((anchor.x - c.x) * z) / c.zoom, y: anchor.y - ((anchor.y - c.y) * z) / c.zoom };
}

/** Câmera que põe o ponto do mundo `w` no centro da área útil: x = cx − wx·z. */
export function centerOn(w: Vec, zoom: number, vp: Viewport, center: Vec = { x: vp.width / 2, y: vp.height / 2 }): Camera {
  const z = clampZoom(zoom);
  return { zoom: z, x: center.x - w.x * z, y: center.y - w.y * z };
}

export function cameraCenter(c: Camera, vp: Viewport): Vec {
  return toWorldPoint({ x: vp.width / 2, y: vp.height / 2 }, c);
}

export function fitBox(box: Box, vp: Viewport, maxZoom = 1, padding = 80): Camera {
  const w = Math.max(box.maxX - box.minX, 1), h = Math.max(box.maxY - box.minY, 1);
  const zoom = Math.min(maxZoom, clampZoom(Math.min((vp.width - padding * 2) / w, (vp.height - padding * 2) / h)));
  return { zoom, x: Math.round(vp.width / 2 - ((box.minX + box.maxX) / 2) * zoom), y: Math.round(vp.height / 2 - ((box.minY + box.maxY) / 2) * zoom) };
}

/* ------------------------------------------------------------------ */
/* Interpolação                                                        */
/* ------------------------------------------------------------------ */

/** Acelera e desacelera, sem ultrapassar o destino (sem efeito elástico). */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Câmera intermediária entre `from` e `to`. O CENTRO do mundo é interpolado (o destino fica sempre
 * na direção certa) e o zoom em escala logarítmica (zoom 1→4 percorre 1→2→4 por igual). Em viagens
 * longas, `arc` afasta um pouco no meio do caminho (sensação de deslocamento, sem demorar mais).
 * Em t = 1 devolve exatamente `to`.
 */
export function interpolateCamera(from: Camera, to: Camera, t: number, vp: Viewport, arc = 0): Camera {
  if (t >= 1) return { ...to };
  if (t <= 0) return { ...from };
  const c0 = cameraCenter(from, vp), c1 = cameraCenter(to, vp);
  const center = { x: c0.x + (c1.x - c0.x) * t, y: c0.y + (c1.y - c0.y) * t };
  let z = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t);
  if (arc > 0) z *= 1 - arc * Math.sin(Math.PI * t);
  return centerOn(center, z, vp);
}

/** Distância percorrida, em “telas” (diagonal do viewport no zoom de partida). */
export function travelScreens(from: Camera, to: Camera, vp: Viewport): number {
  const c0 = cameraCenter(from, vp), c1 = cameraCenter(to, vp);
  const diag = Math.hypot(vp.width, vp.height) / Math.min(from.zoom, to.zoom);
  return Math.hypot(c1.x - c0.x, c1.y - c0.y) / Math.max(diag, 1e-6);
}

/* ------------------------------------------------------------------ */
/* Viagem (issue #12)                                                  */
/* ------------------------------------------------------------------ */

/**
 * Trajeto de “voo” entre duas câmeras (van Wijk & Nuij, “Smooth and efficient zooming and panning”, 2003):
 * o centro anda em linha reta até o destino enquanto a largura visível `w` (= largura da tela ÷ zoom) cresce e
 * volta a diminuir, de modo que a velocidade NA TELA fica constante ao longo do parâmetro `s`. Em viagens
 * curtas o afastamento é quase imperceptível; em viagens longas a câmera se afasta o suficiente para que o
 * conteúdo passe pela tela em vez de “saltar”. `RHO` controla o compromisso afastar × deslocar (o d3 usa √2;
 * aqui 0,7 deixa o afastamento discreto: ~3% em 1 tela, ~20% em 3 telas, ~3× em 12 telas).
 *
 * `at(u)` com u em [0, 1] devolve a câmera; em u = 1 devolve EXATAMENTE `to`. `length` é o comprimento do
 * trajeto (unidade adimensional usada para a duração).
 */
export const FLIGHT_RHO = 0.7;

export interface FlightPath { length: number; at(u: number): Camera }

export function flightPath(from: Camera, to: Camera, vp: Viewport, rho = FLIGHT_RHO): FlightPath {
  const W = Math.max(vp.width, 1);
  const c0 = cameraCenter(from, vp), c1 = cameraCenter(to, vp);
  const w0 = W / from.zoom, w1 = W / to.zoom;
  const dx = c1.x - c0.x, dy = c1.y - c0.y;
  const d = Math.hypot(dx, dy);
  const rho2 = rho * rho;
  const end = (u: number) => u >= 1;
  const cam = (cx: number, cy: number, w: number) => centerOn({ x: cx, y: cy }, W / w, vp);

  // Sem deslocamento (só zoom): w varia em escala logarítmica.
  if (d < 1e-6 * Math.max(w0, w1)) {
    const k = Math.log(w1 / w0);
    return {
      length: Math.abs(k) / rho,
      at: (u) => (end(u) ? { ...to } : u <= 0 ? { ...from } : cam(c0.x + dx * u, c0.y + dy * u, w0 * Math.exp(k * u))),
    };
  }
  const b = (i: 0 | 1) => (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * d * d) / (2 * (i ? w1 : w0) * rho2 * d);
  // ln(√(b²+1) − b) = −asinh(b). A forma direta cancela para b grande (zoom muda muito, centro quase parado):
  // √(b²+1) − b arredonda para 0 → comprimento infinito e quadros NaN (apontamento do PR #16).
  const r = (bi: number) => -Math.asinh(bi);
  const r0 = r(b(0)), r1 = r(b(1));
  const S = (r1 - r0) / rho;
  const coshR0 = Math.cosh(r0), sinhR0 = Math.sinh(r0);
  return {
    length: S,
    at: (u) => {
      if (end(u)) return { ...to };
      if (u <= 0) return { ...from };
      const s = u * S;
      const along = (w0 / rho2) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0); // distância percorrida (mundo)
      const w = (w0 * coshR0) / Math.cosh(rho * s + r0);
      return cam(c0.x + (dx / d) * along, c0.y + (dy / d) * along, w);
    },
  };
}

/** Velocidade da viagem (preferência pessoal). */
export type NavigationSpeed = 'fast' | 'smooth' | 'cinematic';
/** Animar a câmera: seguir o sistema (prefers-reduced-motion), sempre ou nunca. */
export type NavigationMotion = 'system' | 'always' | 'never';
export interface NavigationPrefs { motion: NavigationMotion; speed: NavigationSpeed }
export const DEFAULT_NAVIGATION_PREFS: NavigationPrefs = { motion: 'system', speed: 'smooth' };
export const NAVIGATION_SPEED_LABEL: Record<NavigationSpeed, string> = { fast: 'Rápida', smooth: 'Suave', cinematic: 'Cinematográfica' };

/**
 * Duração = mínimo + ganho × comprimento do trajeto, limitada ao máximo. Números do perfil “Suave” (padrão):
 * ~400 ms para uma tela, ~1,1 s para 12 telas, teto de 1,2 s (antes: 220–650 ms para qualquer distância).
 */
export const SPEED_PROFILE: Record<NavigationSpeed, { min: number; gain: number; max: number }> = {
  fast: { min: 180, gain: 90, max: 700 },
  smooth: { min: 280, gain: 170, max: 1200 },
  cinematic: { min: 420, gain: 300, max: 2000 },
};

export function sanitizeNavigationPrefs(raw: unknown): NavigationPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const motion = o.motion === 'always' || o.motion === 'never' ? o.motion : 'system';
  const speed = o.speed === 'fast' || o.speed === 'cinematic' ? o.speed : 'smooth';
  return { motion, speed };
}

/** Plano da viagem: trajeto de voo e duração conforme a velocidade escolhida. */
export function travelPlan(from: Camera, to: Camera, vp: Viewport, speed: NavigationSpeed = 'smooth'): { duration: number; path: FlightPath } {
  const path = flightPath(from, to, vp);
  const p = SPEED_PROFILE[speed] ?? SPEED_PROFILE.smooth;
  const duration = Math.round(Math.min(p.max, p.min + p.gain * (Number.isFinite(path.length) ? path.length : 0)));
  return { duration, path };
}

/**
 * Aproximação exponencial dependente do tempo (não da taxa de quadros): a cada `dt` ms o zoom
 * percorre a mesma fração do caminho até o alvo, em escala logarítmica.
 */
export function approachZoom(current: number, target: number, dtMs: number, tauMs = 70): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * k);
}

/* ------------------------------------------------------------------ */
/* Roda e sensibilidade                                                */
/* ------------------------------------------------------------------ */

export type ZoomSensitivityPreset = 'precise' | 'smooth' | 'normal' | 'fast' | 'custom';
export interface ZoomPreferences { preset: ZoomSensitivityPreset; custom: number }

/** Multiplicador por preset. Padrão conservador: “suave”. */
export const SENSITIVITY: Record<Exclude<ZoomSensitivityPreset, 'custom'>, number> = { precise: 0.55, smooth: 0.8, normal: 1, fast: 1.6 };
export const SENSITIVITY_LABEL: Record<ZoomSensitivityPreset, string> = { precise: 'Preciso', smooth: 'Suave', normal: 'Normal', fast: 'Rápido', custom: 'Personalizado' };
export const DEFAULT_ZOOM_PREFS: ZoomPreferences = { preset: 'smooth', custom: 1 };
export const CUSTOM_RANGE = { min: 0.25, max: 2.5 };

export function sanitizeZoomPrefs(raw: unknown): ZoomPreferences {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<ZoomPreferences>;
  const preset = o.preset && ['precise', 'smooth', 'normal', 'fast', 'custom'].includes(o.preset) ? o.preset : DEFAULT_ZOOM_PREFS.preset;
  const custom = typeof o.custom === 'number' && Number.isFinite(o.custom) ? Math.min(CUSTOM_RANGE.max, Math.max(CUSTOM_RANGE.min, o.custom)) : 1;
  return { preset, custom };
}

export const sensitivityOf = (p: ZoomPreferences) => (p.preset === 'custom' ? p.custom : SENSITIVITY[p.preset]);

/** Ganho por pixel de roda (sensibilidade normal: um “clique” de 100 px ≈ 14%). */
const NOTCH_GAIN = 0.0015;
/** Pinça do touchpad (Ctrl + eventos pequenos e contínuos): ganho maior, aplicado direto. */
const PINCH_GAIN = 0.009;
/** Limite por evento: eventos anormais (ex.: 1000 px) não viram saltos. */
const MAX_EVENT_PX = 150;

export interface WheelLike { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean; metaKey?: boolean }

/** Converte para pixels (linhas = 16 px, páginas = altura da página) e descarta valores não finitos. */
export function normalizeWheel(e: WheelLike, pageHeight = 800): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  const f = (v: number) => (Number.isFinite(v) ? v * unit : 0);
  return { dx: f(e.deltaX), dy: f(e.deltaY) };
}

/**
 * “Clique” de roda (discreto) × gesto contínuo. Só decide o GANHO do zoom com Ctrl; não muda se a roda
 * faz pan ou zoom. Rodas em linhas/páginas ou saltos inteiros grandes sem componente horizontal → clique.
 */
export function isWheelNotch(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return true;
  return e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
}

/** Fator de zoom de um evento de roda (> 1 aproxima). */
export function wheelZoomFactor(e: WheelLike, prefs: ZoomPreferences, pageHeight = 800): number {
  const { dy } = normalizeWheel(e, pageHeight);
  const d = Math.max(-MAX_EVENT_PX, Math.min(MAX_EVENT_PX, dy));
  const gain = ((e.ctrlKey || e.metaKey) && !isWheelNotch(e) ? PINCH_GAIN : NOTCH_GAIN) * sensitivityOf(prefs);
  return Math.exp(-d * gain);
}

/** Passos dos botões +/− e de Ctrl+= / Ctrl+−. */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
export function nextZoomStep(z: number, direction: 1 | -1): number {
  return direction > 0 ? ZOOM_STEPS.find((v) => v > z + 0.001) ?? MAX_ZOOM : [...ZOOM_STEPS].reverse().find((v) => v < z - 0.001) ?? MIN_ZOOM;
}
