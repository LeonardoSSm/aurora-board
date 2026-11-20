/**
 * Aurora Wheel (issue #15) — lógica pura do menu radial de criação: setores, posicionamento na tela,
 * favoritos e a máquina de estados do gesto “segurar o botão direito”. Sem DOM nem React: testável.
 *
 * Gesto (mouse, botão direito, em área vazia do canvas):
 *   down ──(220 ms segurando, ou arrastar > 12 px)──▶ radial aberto
 *     └──(soltar antes)──▶ menu de contexto tradicional (UMA vez)
 *   radial aberto ── soltar sobre uma fatia ──▶ executa a fatia
 *                 ── soltar no centro sem ter passado por fatia ──▶ fica aberto (modo clique/teclado)
 *                 ── soltar no centro depois de passar por fatia, ou longe do anel ──▶ cancela
 *
 * O evento nativo `contextmenu` chega no DOWN (Linux/macOS) ou no UP (Windows), conforme o sistema. Por isso o
 * menu tradicional nunca é aberto pelo `contextmenu` de um gesto rastreado: só pelo `up` de um clique curto.
 * O `contextmenu` desse gesto é sempre engolido (preventDefault), chegue antes ou depois.
 */

export const HOLD_MS = 220;
/** Arrastar além disso antes do tempo também abre a roda (gesto rápido de quem já sabe a direção). */
export const DRAG_OPEN_PX = 12;

export interface RadialGeometry {
  /** Raio da zona neutra (centro “Criar”/cancelar). */
  inner: number;
  /** Raio externo do anel. */
  outer: number;
  /** Além do anel ainda vale a direção até este raio; mais longe, soltar cancela. */
  reach: number;
}
export const RADIAL_GEOMETRY: RadialGeometry = { inner: 34, outer: 118, reach: 220 };

export interface Pt { x: number; y: number }

/**
 * Setor sob o ponto (relativo ao centro). Setor 0 centrado no topo; sentido horário. `null` na zona neutra ou
 * fora do alcance. Ângulo de cada setor = 360°/n; a fronteira pertence ao setor seguinte.
 */
export function sectorAt(d: Pt, n: number, g: RadialGeometry = RADIAL_GEOMETRY): number | null {
  if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || n < 1) return null;
  const r = Math.hypot(d.x, d.y);
  if (r < g.inner || r > g.reach) return null;
  // atan2 com 0 no topo, crescendo no sentido horário (y da tela cresce para baixo).
  let a = Math.atan2(d.x, -d.y);
  if (a < 0) a += Math.PI * 2;
  const step = (Math.PI * 2) / n;
  return Math.floor((a + step / 2) / step) % n;
}

/** Ângulo central do setor i (radianos, 0 no topo, horário). */
export function sectorAngle(i: number, n: number): number {
  return (i * Math.PI * 2) / n;
}

/** Caminho SVG de uma fatia (coroa circular) centrada em (0,0). */
export function sectorPath(i: number, n: number, inner: number, outer: number, gapRad = 0.012): string {
  const step = (Math.PI * 2) / n;
  const a0 = sectorAngle(i, n) - step / 2 + gapRad, a1 = sectorAngle(i, n) + step / 2 - gapRad;
  const p = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Centro visual do menu: o ponto clicado, deslocado só o necessário para o anel caber na área visível.
 * (O objeto criado continua no ponto ORIGINAL — este deslocamento é só do desenho.)
 */
export function placeMenu(origin: Pt, bounds: Rect, radius: number, margin = 8): Pt {
  const minX = bounds.left + radius + margin, maxX = bounds.right - radius - margin;
  const minY = bounds.top + radius + margin, maxY = bounds.bottom - radius - margin;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  return { x: clamp(origin.x, minX, maxX), y: clamp(origin.y, minY, maxY) };
}

/* ------------------------------------------------------------------ */
/* Itens e favoritos                                                    */
/* ------------------------------------------------------------------ */

/** Ações nativas da roda. Widgets do registro entram como `widget:<id do plugin>`. */
export const RADIAL_BUILTINS = ['note', 'text', 'task', 'shape', 'connector', 'ai', 'value', 'more'] as const;
export type RadialBuiltin = (typeof RADIAL_BUILTINS)[number];
export type RadialItemId = RadialBuiltin | `widget:${string}`;

export const DEFAULT_FAVORITES: RadialItemId[] = ['note', 'text', 'task', 'shape', 'connector', 'ai', 'value', 'more'];
export const MAX_FAVORITES = 8;
export const MIN_FAVORITES = 3;

/**
 * Favoritos gravados (configuração local): só ids conhecidos, sem repetição, de 3 a 8, e sempre com “Mais”
 * (a roda nunca pode esconder o acesso aos demais itens). Ids obsoletos (widget removido) são descartados.
 */
export function sanitizeFavorites(raw: unknown, isKnown: (id: string) => boolean): RadialItemId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FAVORITES];
  const out: RadialItemId[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || out.includes(v as RadialItemId)) continue;
    const builtin = (RADIAL_BUILTINS as readonly string[]).includes(v);
    if (!builtin && !(v.startsWith('widget:') && isKnown(v))) continue;
    out.push(v as RadialItemId);
    if (out.length >= MAX_FAVORITES) break;
  }
  if (!out.includes('more')) {
    if (out.length >= MAX_FAVORITES) out[MAX_FAVORITES - 1] = 'more';
    else out.push('more');
  }
  return out.length >= MIN_FAVORITES ? out : [...DEFAULT_FAVORITES];
}

/* ------------------------------------------------------------------ */
/* Máquina de estados do gesto                                         */
/* ------------------------------------------------------------------ */

export type HoldPhase = 'idle' | 'pending' | 'open';

export interface HoldState {
  phase: HoldPhase;
  pointerId: number;
  /** Ponto do clique (tela, relativo ao canvas) e no mundo — onde o item será criado. */
  origin: Pt;
  world: Pt;
  /** Posição atual do ponteiro (tela). */
  at: Pt;
  /** O ponteiro já esteve sobre uma fatia desde que a roda abriu. */
  visited: boolean;
  /** Fatia sob o ponteiro (ou selecionada pelo teclado). */
  hover: number | null;
}

export const IDLE: HoldState = { phase: 'idle', pointerId: -1, origin: { x: 0, y: 0 }, world: { x: 0, y: 0 }, at: { x: 0, y: 0 }, visited: false, hover: null };

export type HoldEvent =
  | { type: 'down'; pointerId: number; at: Pt; world: Pt }
  | { type: 'move'; pointerId: number; at: Pt; center: Pt; n: number }
  | { type: 'timer' }
  | { type: 'up'; pointerId: number; at: Pt; center: Pt; n: number }
  | { type: 'cancel' };

export type HoldEffect =
  | { kind: 'none' }
  | { kind: 'start-timer' }
  | { kind: 'open-radial' }
  | { kind: 'open-context-menu'; at: Pt; world: Pt }
  | { kind: 'select'; index: number; world: Pt }
  | { kind: 'close' };

const none: HoldEffect = { kind: 'none' };

/** Transição pura. O chamador executa o efeito (timer, abrir menus, criar item). */
export function holdReducer(s: HoldState, e: HoldEvent, g: RadialGeometry = RADIAL_GEOMETRY): [HoldState, HoldEffect] {
  switch (e.type) {
    case 'down':
      if (s.phase !== 'idle') return [s, none]; // segundo botão durante o gesto: ignora
      return [{ ...IDLE, phase: 'pending', pointerId: e.pointerId, origin: e.at, world: e.world, at: e.at }, { kind: 'start-timer' }];
    case 'timer':
      return s.phase === 'pending' ? [{ ...s, phase: 'open' }, { kind: 'open-radial' }] : [s, none];
    case 'move': {
      if (s.phase === 'idle' || e.pointerId !== s.pointerId) return [s, none];
      if (s.phase === 'pending') {
        const moved = Math.hypot(e.at.x - s.origin.x, e.at.y - s.origin.y) > DRAG_OPEN_PX;
        return moved ? [{ ...s, at: e.at, phase: 'open' }, { kind: 'open-radial' }] : [{ ...s, at: e.at }, none];
      }
      const hover = sectorAt({ x: e.at.x - e.center.x, y: e.at.y - e.center.y }, e.n, g);
      return [{ ...s, at: e.at, hover, visited: s.visited || hover !== null }, none];
    }
    case 'up': {
      if (s.phase === 'idle' || e.pointerId !== s.pointerId) return [s, none];
      if (s.phase === 'pending') return [IDLE, { kind: 'open-context-menu', at: s.origin, world: s.world }];
      const d = { x: e.at.x - e.center.x, y: e.at.y - e.center.y };
      const hover = sectorAt(d, e.n, g);
      if (hover !== null) return [IDLE, { kind: 'select', index: hover, world: s.world }];
      const inCenter = Math.hypot(d.x, d.y) < g.inner;
      // Soltou no centro sem ter escolhido direção: a roda fica aberta para clique ou teclado.
      if (inCenter && !s.visited) return [{ ...s, at: e.at, hover: null, pointerId: -1 }, none];
      return [IDLE, { kind: 'close' }];
    }
    case 'cancel':
      return s.phase === 'idle' ? [s, none] : [IDLE, { kind: 'close' }];
  }
}
