/**
 * Aurora Wheel (issue #15) — ponte entre os eventos do canvas e a máquina de estados pura (`core/radial.ts`).
 * Um único gesto por vez (módulo, não componente: Strict Mode/remontagens não criam timers duplicados).
 *
 * Responsabilidades:
 * - decidir se um botão direito do MOUSE em área vazia inicia o gesto (`canStartRadialHold`);
 * - um timer de 220 ms por gesto, sempre limpo em up/cancel/blur/troca de ferramenta/desmontagem;
 * - engolir o `contextmenu` nativo do gesto rastreado, chegue no down (Linux/macOS) ou no up (Windows),
 *   e abrir o menu tradicional UMA vez, no up de um clique curto.
 */
import { holdReducer, HOLD_MS, IDLE, placeMenu, RADIAL_GEOMETRY, type HoldEvent, type HoldState, type Pt } from '../core/radial';
import { getState, setState } from '../store/editor';

let state: HoldState = IDLE;
let timer: ReturnType<typeof setTimeout> | null = null;
/** O `contextmenu` nativo do gesto atual ainda não chegou: quando chegar, é engolido. */
let swallowContextMenu = false;
let swallowTimer: ReturnType<typeof setTimeout> | null = null;

/** Medição de abertura (benchmark E2E): instante em que o timer disparou e em que a roda pintou. */
export const radialTiming = { firedAt: 0 };

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export interface CanvasBounds { left: number; top: number; right: number; bottom: number }

/** Área visível do canvas, em coordenadas da janela, já descontando a barra de ferramentas no topo. */
let boundsOf: () => CanvasBounds = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
export function setRadialBounds(fn: () => CanvasBounds) { boundsOf = fn; }

/** Itens da roda atual (quantidade de fatias), definida pelo componente. */
let sliceCount = 8;
export function setRadialSliceCount(n: number) { sliceCount = Math.max(1, n); }

function dispatch(e: HoldEvent) {
  const [next, eff] = holdReducer(state, e);
  state = next;
  switch (eff.kind) {
    case 'start-timer':
      clearTimer();
      timer = setTimeout(() => { timer = null; radialTiming.firedAt = performance.now(); dispatch({ type: 'timer' }); }, HOLD_MS);
      return;
    case 'open-radial': {
      clearTimer();
      const b = boundsOf();
      const origin = state.origin;
      // Ponto do clique na janela; a roda pode deslocar-se para caber, o item nasce no ponto original.
      const center = placeMenu(origin, b, RADIAL_GEOMETRY.outer + 22);
      setState({ radial: { center, origin, world: state.world, sub: null, hover: null, source: 'pointer', openedAt: Date.now() }, contextMenu: null });
      return;
    }
    case 'open-context-menu': {
      clearTimer();
      setState({ contextMenu: { x: eff.at.x, y: eff.at.y, world: eff.world, targetId: null } });
      return;
    }
    case 'select':
      clearTimer();
      pendingSelect?.(eff.index, eff.world);
      return;
    case 'close':
      clearTimer();
      if (getState().radial) setState({ radial: null });
      return;
    case 'none':
      if (getState().radial && state.phase === 'open') setState({ radial: { ...getState().radial!, hover: state.hover } });
  }
}

/** O componente da roda registra como executar uma fatia (o mesmo caminho do clique e do teclado). */
let pendingSelect: ((index: number, world: Pt) => void) | null = null;
export function setRadialSelectHandler(fn: ((index: number, world: Pt) => void) | null) { pendingSelect = fn; }

/** Pode iniciar o gesto? Só mouse, botão direito, área vazia, sem edição/modal e com seleção ou mão. */
export function canStartRadialHold(e: { button: number; pointerType: string; ctrlKey: boolean; metaKey: boolean }, onEmptyCanvas: boolean): boolean {
  if (e.button !== 2 || e.pointerType !== 'mouse' || e.ctrlKey || e.metaKey) return false;
  if (!onEmptyCanvas) return false;
  const s = getState();
  if (s.tool !== 'select' && s.tool !== 'hand') return false;
  if (s.editingTextId || s.editingWidgetId || s.linearDraftId) return false;
  if (s.dialog || s.checkpointEditor || s.shortcutsOpen || s.boardsPanelOpen || s.radial) return false;
  return true;
}

/** Botão direito pressionado em área vazia: começa a contar. `at` em coordenadas da JANELA (clientX/Y). */
export function radialDown(pointerId: number, at: Pt, world: Pt) {
  swallowContextMenu = true;
  if (swallowTimer) clearTimeout(swallowTimer);
  swallowTimer = null;
  dispatch({ type: 'down', pointerId, at, world });
}

/** Repassa o movimento; devolve true se o gesto consumiu o evento. */
export function radialMove(pointerId: number, at: Pt): boolean {
  if (state.phase === 'idle' || state.pointerId !== pointerId) return false;
  const r = getState().radial;
  const center = r ? r.center : state.origin;
  dispatch({ type: 'move', pointerId, at, center, n: sliceCount });
  return true;
}

/** Botão solto; devolve true se o gesto consumiu o evento. */
export function radialUp(pointerId: number, at: Pt): boolean {
  if (state.phase === 'idle' || state.pointerId !== pointerId) return false;
  const r = getState().radial;
  const center = r ? r.center : state.origin;
  dispatch({ type: 'up', pointerId, at, center, n: sliceCount });
  // No Windows o contextmenu chega logo após o up; se não chegar, para de esperar.
  swallowTimer = setTimeout(() => { swallowContextMenu = false; swallowTimer = null; }, 600);
  return true;
}

/** `contextmenu` nativo: engole o do gesto rastreado. Devolve true se foi engolido. */
export function radialConsumesContextMenu(): boolean {
  if (!swallowContextMenu) return false;
  swallowContextMenu = false;
  if (swallowTimer) clearTimeout(swallowTimer);
  swallowTimer = null;
  return true;
}

/** Cancela o gesto (Esc, blur, pointercancel, troca de ferramenta, desmontagem, outro botão). */
export function cancelRadialHold() {
  dispatch({ type: 'cancel' });
}

/** Há gesto em andamento com o botão ainda pressionado? */
export function radialHoldActive(): boolean {
  return state.phase !== 'idle' && state.pointerId !== -1;
}

/** Fecha a roda e zera o gesto (ex.: após executar uma fatia pelo clique ou teclado). */
export function closeRadial() {
  clearTimer();
  state = IDLE;
  if (getState().radial) setState({ radial: null });
}

/** Abre a roda sem gesto (atalho W, botão “Criar”): no ponto dado (janela) ou no centro do canvas. */
export function openRadialAt(windowPoint: Pt | null, world: Pt) {
  clearTimer();
  state = IDLE;
  const b = boundsOf();
  const origin = windowPoint ?? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  const center = placeMenu(origin, b, RADIAL_GEOMETRY.outer + 22);
  setState({ radial: { center, origin, world, sub: null, hover: 0, source: 'keyboard', openedAt: Date.now() }, contextMenu: null });
}

/** Testes: estado interno. */
export function __radialState() { return { state, swallowContextMenu, timer: timer !== null }; }
