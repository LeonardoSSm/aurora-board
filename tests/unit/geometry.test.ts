import { describe, expect, it } from 'vitest';
import { createLinear, createShape } from '../../src/core/elements';
import { boundaryPointTowards, getCommonBounds, getElementAtPoint, getElementBounds, hitTest, rotatePoint } from '../../src/core/geometry';
import { resizeMultiple, resizeSingle, rotateElements } from '../../src/core/transform';

describe('geometria', () => {
  it('rotaciona ponto em torno de centro', () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
  });

  it('limites consideram rotação', () => {
    const r = createShape('rectangle', 0, 0, 100, 20);
    r.angle = Math.PI / 2;
    const b = getElementBounds(r);
    expect(b.minX).toBeCloseTo(40);
    expect(b.maxX).toBeCloseTo(60);
    expect(b.minY).toBeCloseTo(-40);
    expect(b.maxY).toBeCloseTo(60);
  });

  it('retângulo transparente só é atingido perto do contorno; preenchido em toda área', () => {
    const r = createShape('rectangle', 0, 0, 100, 100);
    expect(hitTest(r, { x: 50, y: 50 }, 4)).toBe(false);
    expect(hitTest(r, { x: 1, y: 50 }, 4)).toBe(true);
    r.style.backgroundColor = '#fff';
    expect(hitTest(r, { x: 50, y: 50 }, 4)).toBe(true);
    // seleção atual: área interna conta mesmo transparente
    r.style.backgroundColor = 'transparent';
    expect(hitTest(r, { x: 50, y: 50 }, 4, true)).toBe(true);
  });

  it('texto interno torna a forma clicável por dentro', () => {
    const r = createShape('ellipse', 0, 0, 100, 60);
    r.text = 'olá';
    expect(hitTest(r, { x: 50, y: 30 }, 2)).toBe(true);
    expect(hitTest(r, { x: 2, y: 2 }, 2)).toBe(false); // canto fora da elipse
  });

  it('seta é atingida perto do segmento', () => {
    const a = createLinear('arrow', 0, 0, [[0, 0], [100, 0]]);
    expect(hitTest(a, { x: 50, y: 3 }, 4)).toBe(true);
    expect(hitTest(a, { x: 50, y: 20 }, 4)).toBe(false);
  });

  it('getElementAtPoint retorna o elemento mais ao topo', () => {
    const a = createShape('rectangle', 0, 0, 100, 100, { backgroundColor: '#111' });
    const b = createShape('rectangle', 50, 50, 100, 100, { backgroundColor: '#222' });
    expect(getElementAtPoint([a, b], { x: 75, y: 75 }, 2)?.id).toBe(b.id);
    expect(getElementAtPoint([a, b], { x: 10, y: 10 }, 2)?.id).toBe(a.id);
  });

  it('ponto de borda na direção do alvo (retângulo, elipse, losango)', () => {
    const r = createShape('rectangle', 0, 0, 100, 50);
    const p = boundaryPointTowards(r, { x: 500, y: 25 }, 0);
    expect(p.point.x).toBeCloseTo(100);
    expect(p.point.y).toBeCloseTo(25);
    expect(p.side).toBe('right');
    const e = createShape('ellipse', 0, 0, 100, 100);
    const q = boundaryPointTowards(e, { x: 50, y: -200 }, 0);
    expect(q.point.y).toBeCloseTo(0);
    const d = createShape('diamond', 0, 0, 100, 100);
    const s = boundaryPointTowards(d, { x: 500, y: 50 }, 0);
    expect(s.point.x).toBeCloseTo(100);
  });
});

describe('transformações', () => {
  it('redimensionar pelo canto SE mantém o canto NW', () => {
    const r = createShape('rectangle', 10, 10, 100, 50);
    const out = resizeSingle(r, 'se', { x: 210, y: 110 }, { keepAspect: false, fromCenter: false });
    expect(out.x).toBeCloseTo(10);
    expect(out.y).toBeCloseTo(10);
    expect(out.width).toBeCloseTo(200);
    expect(out.height).toBeCloseTo(100);
  });

  it('redimensionar elemento rotacionado mantém a borda oposta fixa no mundo', () => {
    const r = createShape('rectangle', 0, 0, 100, 50);
    r.angle = Math.PI / 2;
    // canto NW local rotacionado = ponto fixo ao arrastar SE
    const c = { x: 50, y: 25 };
    const nwBefore = rotatePoint({ x: 0, y: 0 }, c, r.angle);
    const pointer = rotatePoint({ x: 150, y: 80 }, c, r.angle);
    const out = resizeSingle(r, 'se', pointer, { keepAspect: false, fromCenter: false });
    const c2 = { x: out.x + out.width / 2, y: out.y + out.height / 2 };
    const nwAfter = rotatePoint({ x: out.x, y: out.y }, c2, out.angle);
    expect(nwAfter.x).toBeCloseTo(nwBefore.x);
    expect(nwAfter.y).toBeCloseTo(nwBefore.y);
    expect(out.width).toBeCloseTo(150);
  });

  it('Shift mantém proporção', () => {
    const r = createShape('rectangle', 0, 0, 100, 50);
    const out = resizeSingle(r, 'se', { x: 300, y: 60 }, { keepAspect: true, fromCenter: false });
    expect(out.width / out.height).toBeCloseTo(2);
  });

  it('redimensionar seleção múltipla escala proporcionalmente', () => {
    const a = createShape('rectangle', 0, 0, 50, 50);
    const b = createShape('rectangle', 50, 50, 50, 50);
    const box = getCommonBounds([a, b])!;
    const [a2, b2] = resizeMultiple([a, b], box, 'se', { x: 200, y: 200 });
    expect(a2.x).toBeCloseTo(0);
    expect(a2.width).toBeCloseTo(100);
    expect(b2.x).toBeCloseTo(100);
    expect(b2.y).toBeCloseTo(100);
  });

  it('rotacionar grupo gira posições ao redor do centro comum', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    const b = createShape('rectangle', 90, 0, 10, 10);
    const [a2, b2] = rotateElements([a, b], { x: 50, y: 5 }, Math.PI);
    expect(a2.x).toBeCloseTo(90);
    expect(b2.x).toBeCloseTo(0);
    expect(a2.angle).toBeCloseTo(Math.PI);
  });
});
