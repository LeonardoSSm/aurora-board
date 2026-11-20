/** Issue #15 — Aurora Wheel: setores, posicionamento, favoritos e máquina de estados do gesto. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAVORITES, DRAG_OPEN_PX, holdReducer, IDLE, MAX_FAVORITES, placeMenu, RADIAL_GEOMETRY as G, sanitizeFavorites, sectorAt, sectorPath,
  type HoldEvent, type HoldState,
} from '../../src/core/radial';

const N = 8;
const polar = (deg: number, r: number) => ({ x: r * Math.sin((deg * Math.PI) / 180), y: -r * Math.cos((deg * Math.PI) / 180) });

describe('setores', () => {
  it('8 fatias: topo = 0, sentido horário, cada uma com 45°', () => {
    expect(sectorAt(polar(0, 80), N)).toBe(0);
    expect(sectorAt(polar(45, 80), N)).toBe(1);
    expect(sectorAt(polar(90, 80), N)).toBe(2);
    expect(sectorAt(polar(180, 80), N)).toBe(4);
    expect(sectorAt(polar(270, 80), N)).toBe(6);
    expect(sectorAt(polar(350, 80), N)).toBe(0);
    expect(sectorAt(polar(21, 80), N)).toBe(0);
    expect(sectorAt(polar(23, 80), N)).toBe(1);
  });
  it('limiar exato: a fronteira pertence ao setor seguinte', () => {
    expect(sectorAt(polar(22.5, 80), N)).toBe(1);
    expect(sectorAt(polar(22.49, 80), N)).toBe(0);
  });
  it('zona neutra no centro e alcance máximo', () => {
    expect(sectorAt({ x: 0, y: 0 }, N)).toBeNull();
    expect(sectorAt(polar(90, G.inner - 1), N)).toBeNull();
    expect(sectorAt(polar(90, G.inner), N)).toBe(2);
    expect(sectorAt(polar(90, G.outer + 50), N)).toBe(2); // além do anel ainda vale a direção
    expect(sectorAt(polar(90, G.reach + 1), N)).toBeNull();
    expect(sectorAt({ x: NaN, y: 3 }, N)).toBeNull();
  });
  it('funciona com 3 a 8 fatias', () => {
    for (let n = 3; n <= 8; n++) for (let i = 0; i < n; i++) expect(sectorAt(polar((i * 360) / n, 70), n)).toBe(i);
  });
  it('caminho SVG válido para cada fatia', () => {
    for (let i = 0; i < N; i++) expect(sectorPath(i, N, G.inner, G.outer)).toMatch(/^M [-\d.]+ [-\d.]+ A .* Z$/);
  });
});

describe('posicionamento', () => {
  const bounds = { left: 0, top: 56, right: 800, bottom: 600 };
  it('no meio: fica no ponto clicado', () => {
    expect(placeMenu({ x: 400, y: 300 }, bounds, G.outer)).toEqual({ x: 400, y: 300 });
  });
  it('perto das bordas: desloca só o necessário para caber', () => {
    expect(placeMenu({ x: 5, y: 60 }, bounds, G.outer)).toEqual({ x: G.outer + 8, y: 56 + G.outer + 8 });
    expect(placeMenu({ x: 799, y: 599 }, bounds, G.outer)).toEqual({ x: 800 - G.outer - 8, y: 600 - G.outer - 8 });
  });
  it('área menor que o menu: centraliza', () => {
    const p = placeMenu({ x: 10, y: 10 }, { left: 0, top: 0, right: 100, bottom: 100 }, G.outer);
    expect(p).toEqual({ x: 50, y: 50 });
  });
});

describe('favoritos', () => {
  const known = (id: string) => ['widget:aurora.chart', 'widget:aurora.formula'].includes(id);
  it('inválidos → padrão', () => {
    expect(sanitizeFavorites(undefined, known)).toEqual(DEFAULT_FAVORITES);
    expect(sanitizeFavorites('note', known)).toEqual(DEFAULT_FAVORITES);
    expect(sanitizeFavorites([], known)).toEqual(DEFAULT_FAVORITES);
  });
  it('descarta obsoletos e repetidos, limita a 8 e garante “Mais”', () => {
    const r = sanitizeFavorites(['note', 'note', 'widget:aurora.chart', 'widget:removido', 'bogus', 'task', 1, null], known);
    expect(r).toEqual(['note', 'widget:aurora.chart', 'task', 'more']);
    const many = sanitizeFavorites(['note', 'text', 'task', 'shape', 'connector', 'ai', 'value', 'widget:aurora.chart', 'widget:aurora.formula'], known);
    expect(many).toHaveLength(MAX_FAVORITES);
    expect(many[MAX_FAVORITES - 1]).toBe('more');
  });
});

describe('gesto (máquina de estados)', () => {
  const center = { x: 400, y: 300 };
  const run = (events: HoldEvent[]) => {
    let s: HoldState = IDLE;
    const effects: string[] = [];
    for (const e of events) {
      const [n, eff] = holdReducer(s, e);
      s = n;
      if (eff.kind !== 'none') effects.push(eff.kind === 'select' ? `select:${eff.index}` : eff.kind);
    }
    return { s, effects };
  };
  const down: HoldEvent = { type: 'down', pointerId: 1, at: center, world: { x: 1234, y: -55 } };
  const at = (deg: number, r: number) => ({ x: center.x + polar(deg, r).x, y: center.y + polar(deg, r).y });

  it('clique curto → menu tradicional uma única vez; sem roda', () => {
    const r = run([down, { type: 'up', pointerId: 1, at: center, center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-context-menu']);
    expect(r.s.phase).toBe('idle');
  });
  it('segurar → roda; soltar numa fatia executa a fatia com o ponto do mundo original', () => {
    let s: HoldState = IDLE;
    [s] = holdReducer(s, down);
    let eff;
    [s, eff] = holdReducer(s, { type: 'timer' });
    expect(eff.kind).toBe('open-radial');
    [s] = holdReducer(s, { type: 'move', pointerId: 1, at: at(90, 80), center, n: N });
    expect(s.hover).toBe(2);
    [s, eff] = holdReducer(s, { type: 'up', pointerId: 1, at: at(90, 80), center, n: N });
    expect(eff).toEqual({ kind: 'select', index: 2, world: { x: 1234, y: -55 } });
    expect(s.phase).toBe('idle');
  });
  it('o timer depois de soltar não abre nada (sem timer duplicado/fantasma)', () => {
    const r = run([down, { type: 'up', pointerId: 1, at: center, center, n: N }, { type: 'timer' }]);
    expect(r.effects).toEqual(['start-timer', 'open-context-menu']);
  });
  it(`arrastar mais de ${DRAG_OPEN_PX}px antes do tempo abre a roda (sem menu tradicional)`, () => {
    const r = run([down, { type: 'move', pointerId: 1, at: at(180, DRAG_OPEN_PX + 1), center, n: N }, { type: 'up', pointerId: 1, at: at(180, 90), center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-radial', 'select:4']);
  });
  it('pequena tremida antes do tempo continua sendo clique curto', () => {
    const r = run([down, { type: 'move', pointerId: 1, at: at(10, 4), center, n: N }, { type: 'up', pointerId: 1, at: at(10, 4), center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-context-menu']);
  });
  it('soltar no centro sem escolher direção: a roda fica aberta (modo clique/teclado)', () => {
    const r = run([down, { type: 'timer' }, { type: 'up', pointerId: 1, at: center, center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-radial']);
    expect(r.s.phase).toBe('open');
    expect(r.s.pointerId).toBe(-1);
  });
  it('passar por uma fatia e voltar ao centro: soltar cancela', () => {
    const r = run([down, { type: 'timer' }, { type: 'move', pointerId: 1, at: at(0, 80), center, n: N }, { type: 'move', pointerId: 1, at: center, center, n: N }, { type: 'up', pointerId: 1, at: center, center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-radial', 'close']);
  });
  it('soltar longe do anel cancela', () => {
    const r = run([down, { type: 'timer' }, { type: 'up', pointerId: 1, at: at(45, G.reach + 40), center, n: N }]);
    expect(r.effects).toEqual(['start-timer', 'open-radial', 'close']);
  });
  it('cancelamento (Esc, blur, pointercancel, troca de ferramenta) em qualquer fase', () => {
    expect(run([down, { type: 'cancel' }]).effects).toEqual(['start-timer', 'close']);
    expect(run([down, { type: 'timer' }, { type: 'cancel' }]).effects).toEqual(['start-timer', 'open-radial', 'close']);
    expect(run([{ type: 'cancel' }]).effects).toEqual([]);
  });
  it('eventos de outro ponteiro e segundo “down” são ignorados', () => {
    const r = run([down, { type: 'down', pointerId: 2, at: center, world: { x: 0, y: 0 } }, { type: 'up', pointerId: 2, at: center, center, n: N }, { type: 'timer' }]);
    expect(r.effects).toEqual(['start-timer', 'open-radial']);
  });
});
