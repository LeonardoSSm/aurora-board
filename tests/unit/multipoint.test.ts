/** Setas com vários pontos: criação por cliques, curvas e edição de pontos. */
import { beforeEach, describe, expect, it } from 'vitest';
import { catmullRom, getLinearRenderPoints } from '../../src/core/geometry';
import { createLinear, createShape } from '../../src/core/elements';
import { resolveLinear } from '../../src/core/bindings';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addElements, removeLinearPoint, setSelection, undo, worldToScreen } from '../../src/store/actions';
import { cancelGesture, finishDraft, isDrafting, pointerDown, pointerMove, pointerUp, type PointerInfo } from '../../src/canvas/controller';
import type { LinearElement } from '../../src/core/schema';

const ptr = (x: number, y: number): PointerInfo => ({
  screen: worldToScreen({ x, y }), world: { x, y }, button: 0, shift: false, alt: false, ctrl: false, pointerType: 'mouse', pointerId: 1, pressure: 0.5,
});
const click = (x: number, y: number) => { pointerDown(ptr(x, y)); pointerUp(ptr(x, y)); };
const absPoints = (a: LinearElement) => a.points.map(([x, y]) => [Math.round(a.x + x), Math.round(a.y + y)]);

function reset() {
  setState({
    ...initialEditorState, status: 'ready', boardId: 'b', history: {}, elements: [], camera: { x: 0, y: 0, zoom: 1 }, viewport: { width: 1600, height: 1000 },
    boards: [{ id: 'b', workspaceId: 'w', name: 'B', description: '', createdAt: 0, updatedAt: 0, archived: false, schemaVersion: 3, camera: { x: 0, y: 0, zoom: 1 }, settings: { grid: false, gridSize: 20, snapToGrid: false, snapToObjects: false, wheelMode: 'zoom' } }],
  });
}

describe('curvas', () => {
  it('Catmull-Rom passa exatamente pelos pontos', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: -40 }, { x: 100, y: 0 }, { x: 150, y: 30 }];
    const curve = catmullRom(pts, 8);
    for (const p of pts) expect(curve.some((c) => Math.abs(c.x - p.x) < 1e-9 && Math.abs(c.y - p.y) < 1e-9)).toBe(true);
    const a = createLinear('arrow', 0, 0, [[0, 0], [50, -40], [100, 0]]);
    a.path = 'curved';
    expect(getLinearRenderPoints(a).length).toBeGreaterThan(3);
    a.path = 'straight';
    expect(getLinearRenderPoints(a)).toHaveLength(3);
  });

  it('pontos internos ficam fixos e a ponta ancorada se orienta pelo vizinho', () => {
    const box = createShape('rectangle', 300, 0, 100, 100);
    const a = createLinear('arrow', 0, 0, [[0, 0], [200, 200], [350, 50]]);
    a.endBinding = { elementId: box.id, fixedPoint: null };
    const r = resolveLinear(a, new Map([[box.id, box]]));
    expect(absPoints(r)[1]).toEqual([200, 200]);
    // vizinho (200,200) fica abaixo-esquerda → a ponta encosta na borda inferior/esquerda, não no centro
    const [ex, ey] = absPoints(r)[2];
    expect(ex <= 300 || ey >= 100).toBe(true);
  });
});

describe('criação por cliques', () => {
  beforeEach(reset);

  it('clique, clique, clique, Enter → seta com 3 pontos (prévia descartada)', () => {
    setState({ tool: 'arrow' });
    click(0, 0);
    expect(isDrafting()).toBe(true);
    pointerMove(ptr(100, -50));
    click(100, -50);
    pointerMove(ptr(200, 0));
    click(200, 0);
    pointerMove(ptr(260, 80)); // prévia
    finishDraft(); // Enter/Esc
    const a = getState().elements[0] as LinearElement;
    expect(absPoints(a)).toEqual([[0, 0], [100, -50], [200, 0]]);
    expect(a.path).toBe('curved');
    expect(isDrafting()).toBe(false);
    expect(getState().tool).toBe('select');
    expect(getState().history.b.undo).toHaveLength(1); // uma única entrada no histórico
    undo();
    expect(getState().elements).toHaveLength(0);
  });

  it('clicar no último ponto finaliza; clicar numa forma ancora e finaliza', () => {
    const target = createShape('rectangle', 300, -50, 100, 100, { backgroundColor: '#123' });
    addElements([target]);
    setState({ tool: 'arrow', selectedIds: [] });
    click(0, 0);
    pointerMove(ptr(150, 100));
    click(150, 100);
    pointerMove(ptr(350, 0));
    click(350, 0); // sobre a forma
    const a = getState().elements.find((e) => e.type === 'arrow') as LinearElement;
    expect(a.endBinding?.elementId).toBe(target.id);
    expect(a.points).toHaveLength(3);
    expect(isDrafting()).toBe(false);

    setState({ tool: 'arrow', selectedIds: [] });
    click(0, 300);
    pointerMove(ptr(100, 300));
    click(100, 300);
    click(100, 300); // de novo no último ponto
    const b = getState().elements.filter((e) => e.type === 'arrow')[1] as LinearElement;
    expect(absPoints(b)).toEqual([[0, 300], [100, 300]]);
  });

  it('Esc com só o primeiro clique não cria nada; arrastar continua criando seta simples', () => {
    setState({ tool: 'arrow' });
    click(0, 0);
    pointerMove(ptr(80, 80));
    cancelGesture(); // Esc
    expect(getState().elements).toHaveLength(0);
    setState({ tool: 'arrow' });
    pointerDown(ptr(0, 0));
    pointerMove(ptr(120, 0));
    pointerUp(ptr(120, 0));
    expect(isDrafting()).toBe(false);
    expect((getState().elements[0] as LinearElement).points).toHaveLength(2);
  });

  it('trocar de ferramenta finaliza o rascunho', () => {
    setState({ tool: 'line' });
    click(0, 0);
    pointerMove(ptr(50, 50));
    click(50, 50);
    pointerMove(ptr(90, 10));
    setState({ tool: 'select' });
    const l = getState().elements[0] as LinearElement;
    expect(l.type).toBe('line');
    expect(l.path).toBe('straight');
    expect(absPoints(l)).toEqual([[0, 0], [50, 50]]);
  });
});

describe('edição de pontos', () => {
  beforeEach(reset);

  it('arrastar o ponto médio insere um ponto; Delete remove ponto', () => {
    const a = createLinear('arrow', 0, 0, [[0, 0], [200, 0]]);
    a.path = 'straight';
    addElements([a]);
    setSelection([a.id]);
    // ponto médio do segmento: (100, 0)
    pointerDown(ptr(100, 0));
    pointerMove(ptr(100, 80));
    pointerUp(ptr(100, 80));
    let cur = getState().elements[0] as LinearElement;
    expect(absPoints(cur)).toEqual([[0, 0], [100, 80], [200, 0]]);
    expect(getState().selectedPointIndex).toBe(1);
    expect(removeLinearPoint(a.id, 1)).toBe(true);
    cur = getState().elements[0] as LinearElement;
    expect(absPoints(cur)).toEqual([[0, 0], [200, 0]]);
    expect(removeLinearPoint(a.id, 0)).toBe(false); // mínimo de 2 pontos
  });

  it('arrastar um ponto existente o move', () => {
    const a = createLinear('arrow', 0, 0, [[0, 0], [100, 50], [200, 0]]);
    addElements([a]);
    setSelection([a.id]);
    pointerDown(ptr(100, 50));
    pointerMove(ptr(120, -40));
    pointerUp(ptr(120, -40));
    expect(absPoints(getState().elements[0] as LinearElement)[1]).toEqual([120, -40]);
  });
});
