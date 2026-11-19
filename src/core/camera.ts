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

/** Duração e arco da viagem: cresce com o logaritmo da distância e fica entre 220 e 650 ms. */
export function travelPlan(from: Camera, to: Camera, vp: Viewport): { duration: number; arc: number } {
  const screens = travelScreens(from, to, vp);
  const zoomChange = Math.abs(Math.log2(to.zoom / from.zoom));
  const duration = Math.round(Math.min(650, 220 + 110 * Math.log2(1 + screens) + 60 * zoomChange));
  const arc = screens > 2 ? Math.min(0.45, 0.12 * Math.log2(screens)) : 0;
  return { duration, arc };
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
