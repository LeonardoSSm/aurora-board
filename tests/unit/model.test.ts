import { describe, expect, it } from 'vitest';
import { cloneElements, createLinear, createShape } from '../../src/core/elements';
import { resolveLinear, unbindDeleted, updateBoundArrows } from '../../src/core/bindings';
import { expandToGroups, groupElements, reorder, ungroupElements, selectableGroupId } from '../../src/core/groups';
import { emptyHistory, pushEntry, redoStep, undoStep } from '../../src/core/history';
import type { AuroraElement, LinearElement } from '../../src/core/schema';

function connected() {
  const a = createShape('rectangle', 0, 0, 100, 100);
  const b = createShape('rectangle', 300, 0, 100, 100);
  const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
  arrow.startBinding = { elementId: a.id, fixedPoint: null };
  arrow.endBinding = { elementId: b.id, fixedPoint: null };
  const els = updateBoundArrows([a, b, arrow]);
  return { a, b, els, arrowId: arrow.id };
}

describe('conexões ancoradas', () => {
  it('seta liga as bordas dos dois elementos', () => {
    const { els, arrowId } = connected();
    const ar = els.find((e) => e.id === arrowId) as LinearElement;
    expect(ar.x).toBeGreaterThan(100); // após a borda direita de A (+folga)
    expect(ar.x).toBeLessThan(110);
    const end = ar.x + ar.points[1][0];
    expect(end).toBeLessThan(300);
    expect(end).toBeGreaterThan(290);
  });

  it('seta acompanha quando o elemento conectado é movido', () => {
    const { b, els, arrowId } = connected();
    const moved = els.map((e) => (e.id === b.id ? { ...e, y: 400 } : e));
    const out = updateBoundArrows(moved, new Set([b.id]));
    const ar = out.find((e) => e.id === arrowId) as LinearElement;
    const endY = ar.y + ar.points[1][1];
    expect(endY).toBeGreaterThan(390); // ponta foi para B na nova posição
  });

  it('ponto de conexão fixo é respeitado', () => {
    const { a, b, els, arrowId } = connected();
    const ar = els.find((e) => e.id === arrowId) as LinearElement;
    const fixed = resolveLinear({ ...ar, endBinding: { elementId: b.id, fixedPoint: [0.5, 0] } }, new Map([[a.id, a], [b.id, b]]));
    expect(fixed.x + fixed.points[1][0]).toBeCloseTo(350);
    expect(fixed.y + fixed.points[1][1]).toBeLessThan(0); // acima do topo (folga)
  });

  it('excluir elemento remove o vínculo sem apagar a seta', () => {
    const { a, els, arrowId } = connected();
    const out = unbindDeleted(els.filter((e) => e.id !== a.id), new Set([a.id]));
    const ar = out.find((e) => e.id === arrowId) as LinearElement;
    expect(ar.startBinding).toBeNull();
    expect(ar.endBinding).not.toBeNull();
  });

  it('clonar conjunto remapeia vínculos internos e solta externos', () => {
    const { a, els, arrowId } = connected();
    const arrow = els.find((e) => e.id === arrowId)!;
    const [ca, carrow] = cloneElements([a, arrow], { x: 10, y: 10 }) as [AuroraElement, LinearElement];
    expect(ca.id).not.toBe(a.id);
    expect(carrow.startBinding?.elementId).toBe(ca.id);
    expect(carrow.endBinding).toBeNull();
  });
});

describe('grupos e camadas', () => {
  it('agrupa, expande seleção e desagrupa', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    const b = createShape('ellipse', 20, 0, 10, 10);
    const c = createShape('diamond', 40, 0, 10, 10);
    const { elements, groupId } = groupElements([a, b, c], new Set([a.id, b.id]), null);
    expect(groupId).toBeTruthy();
    expect(expandToGroups(elements, [a.id], null)).toEqual(new Set([a.id, b.id]));
    const un = ungroupElements(elements, new Set([a.id, b.id]), null);
    expect(un.every((e) => e.groupIds.length === 0)).toBe(true);
  });

  it('grupos aninhados: seleciona o mais externo; editando entra um nível', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    const b = createShape('rectangle', 20, 0, 10, 10);
    const c = createShape('rectangle', 40, 0, 10, 10);
    const g1 = groupElements([a, b, c], new Set([a.id, b.id]), null);
    const g2 = groupElements(g1.elements, new Set([a.id, b.id, c.id]), null);
    const ea = g2.elements.find((e) => e.id === a.id)!;
    expect(selectableGroupId(ea, null)).toBe(g2.groupId);
    expect(selectableGroupId(ea, g2.groupId)).toBe(g1.groupId);
    expect(expandToGroups(g2.elements, [c.id], null).size).toBe(3);
  });

  it('ordem de camadas', () => {
    const [a, b, c] = [createShape('rectangle', 0, 0, 1, 1), createShape('rectangle', 0, 0, 1, 1), createShape('rectangle', 0, 0, 1, 1)];
    const ids = (els: AuroraElement[]) => els.map((e) => e.id);
    expect(ids(reorder([a, b, c], new Set([a.id]), 'front'))).toEqual([b.id, c.id, a.id]);
    expect(ids(reorder([a, b, c], new Set([c.id]), 'back'))).toEqual([c.id, a.id, b.id]);
    expect(ids(reorder([a, b, c], new Set([a.id]), 'forward'))).toEqual([b.id, a.id, c.id]);
    expect(ids(reorder([a, b, c], new Set([c.id]), 'backward'))).toEqual([a.id, c.id, b.id]);
  });
});

describe('histórico', () => {
  it('desfaz e refaz, e agrupa digitação consecutiva', () => {
    const s0: AuroraElement[] = [];
    const s1 = [createShape('rectangle', 0, 0, 1, 1)];
    const s2 = [...s1, createShape('rectangle', 0, 0, 1, 1)];
    let h = pushEntry(emptyHistory(), { before: s0, after: s1, selectionBefore: [], selectionAfter: [], at: 1 });
    h = pushEntry(h, { before: s1, after: s2, selectionBefore: [], selectionAfter: [], at: 2 });
    const u = undoStep(h)!;
    expect(u.entry.before).toBe(s1);
    const r = redoStep(u.stack)!;
    expect(r.entry.after).toBe(s2);
    // coalescência
    let c = pushEntry(emptyHistory(), { before: s0, after: s1, selectionBefore: [], selectionAfter: [], coalesceKey: 'k', at: 1000 });
    c = pushEntry(c, { before: s1, after: s2, selectionBefore: [], selectionAfter: [], coalesceKey: 'k', at: 1500 });
    expect(c.undo).toHaveLength(1);
    expect(c.undo[0].before).toBe(s0);
    expect(c.undo[0].after).toBe(s2);
  });
});
