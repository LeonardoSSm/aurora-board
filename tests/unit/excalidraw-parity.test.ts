/** Comportamentos ajustados a partir da comparação com o Excalidraw. */
import { beforeEach, describe, expect, it } from 'vitest';
import { snapBox } from '../../src/core/snapping';
import { elbowRoute } from '../../src/core/geometry';
import { createShape } from '../../src/core/elements';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addElements, copyStyle, createFlowchartNode, navigateConnected, pasteStyle, setSelection, setTool, worldToScreen } from '../../src/store/actions';
import { pointerDown, pointerMove, pointerUp, type PointerInfo } from '../../src/canvas/controller';
import type { LinearElement } from '../../src/core/schema';

const ptr = (x: number, y: number, extra: Partial<PointerInfo> = {}): PointerInfo => ({
  screen: worldToScreen({ x, y }), world: { x, y }, button: 0, shift: false, alt: false, ctrl: false, pointerType: 'mouse', pointerId: 1, pressure: 0.5, ...extra,
});

function reset(snapToObjects = true) {
  setState({
    ...initialEditorState,
    status: 'ready',
    boardId: 'b',
    history: {},
    elements: [],
    viewport: { width: 1600, height: 1000 },
    camera: { x: 800, y: 500, zoom: 1 },
    boards: [{ id: 'b', workspaceId: 'w', name: 'B', description: '', createdAt: 0, updatedAt: 0, archived: false, schemaVersion: 3, camera: { x: 0, y: 0, zoom: 1 }, settings: { grid: false, gridSize: 20, snapToGrid: false, snapToObjects, wheelMode: 'zoom' } }],
  });
}

describe('encaixe em objetos', () => {
  it('alinha bordas e centros dentro do limite e gera guia', () => {
    const r = snapBox({ minX: 103, minY: 300, maxX: 203, maxY: 350 }, [{ minX: 100, minY: 0, maxX: 200, maxY: 50 }], 6);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ x1: 100, y1: 0, x2: 100, y2: 350 }]);
    expect(snapBox({ minX: 120, minY: 300, maxX: 220, maxY: 350 }, [{ minX: 100, minY: 0, maxX: 200, maxY: 50 }], 6).guides).toHaveLength(0);
  });

  it('ao arrastar, a forma encaixa no topo da vizinha; Ctrl desliga o encaixe', () => {
    reset();
    const a = createShape('rectangle', 0, 0, 100, 100, { backgroundColor: '#123' });
    const b = createShape('rectangle', 300, 200, 100, 100, { backgroundColor: '#123' });
    addElements([a, b]);
    setState({ selectedIds: [] });
    pointerDown(ptr(350, 250));
    pointerMove(ptr(350, 54)); // topo ficaria em 4 → encaixa em 0
    expect(getState().snapGuides.length).toBeGreaterThan(0);
    pointerUp(ptr(350, 54));
    expect(getState().elements[1].y).toBe(0);
    expect(getState().snapGuides).toHaveLength(0);

    pointerDown(ptr(350, 50));
    pointerMove(ptr(350, 254, { ctrl: true }));
    pointerUp(ptr(350, 254, { ctrl: true }));
    expect(getState().elements[1].y).toBe(204);
  });
});

describe('setas em cotovelo', () => {
  it('saem e entram perpendiculares aos lados ancorados', () => {
    const pts = elbowRoute({ x: 0, y: 0 }, { x: 200, y: -100 }, 'bottom', 'top');
    expect(pts[1]).toEqual({ x: 0, y: 24 }); // desce primeiro
    expect(pts[pts.length - 2]).toEqual({ x: 200, y: -124 }); // entra por cima
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
  });
});

describe('fluxograma (Ctrl+setas) e navegação (Alt+setas)', () => {
  beforeEach(() => reset());

  it('cria nó conectado na direção, desviando de espaço ocupado', () => {
    const a = createShape('rectangle', 0, 0, 100, 60);
    addElements([a]);
    expect(createFlowchartNode('right')).toBe(true);
    const s = getState();
    const node = s.elements[1];
    const arrow = s.elements[2] as LinearElement;
    expect(node).toMatchObject({ type: 'rectangle', x: 190, y: 0, width: 100, height: 60, text: '' });
    expect(arrow.startBinding).toEqual({ elementId: a.id, fixedPoint: [1, 0.5] });
    expect(arrow.endBinding).toEqual({ elementId: node.id, fixedPoint: [0, 0.5] });
    expect(s.selectedIds).toEqual([node.id]);
    // de novo a partir de A: lugar ocupado → desloca na vertical
    setSelection([a.id]);
    createFlowchartNode('right');
    const second = getState().elements[3];
    expect(second.x).toBe(190);
    expect(second.y).not.toBe(0);
    // navega de volta
    setSelection([node.id]);
    expect(navigateConnected('left')).toBe(true);
    expect(getState().selectedIds).toEqual([a.id]);
  });

  it('não cria fluxo para seleção múltipla ou elementos não-forma', () => {
    const a = createShape('rectangle', 0, 0, 100, 60);
    const b = createShape('frame', 300, 0, 100, 60);
    addElements([a, b]);
    setSelection([a.id, b.id]);
    expect(createFlowchartNode('down')).toBe(false);
    setSelection([b.id]);
    expect(createFlowchartNode('down')).toBe(false);
  });
});

describe('comportamentos do editor', () => {
  beforeEach(() => reset());

  it('copiar e colar estilo', () => {
    const a = createShape('rectangle', 0, 0, 10, 10, { strokeColor: '#f00', strokeWidth: 4, fontFamily: 'mono' });
    const b = createShape('ellipse', 50, 0, 10, 10);
    addElements([a, b]);
    setSelection([a.id]);
    copyStyle();
    setSelection([b.id]);
    pasteStyle();
    expect(getState().elements[1].style).toMatchObject({ strokeColor: '#f00', strokeWidth: 4, fontFamily: 'mono' });
  });

  it('escolher ferramenta de desenho limpa a seleção (seleção e mão preservam)', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    addElements([a]);
    setTool('hand');
    expect(getState().selectedIds).toEqual([a.id]);
    setTool('ellipse');
    expect(getState().selectedIds).toEqual([]);
  });

  it('encolher uma forma com texto respeita a altura do texto', () => {
    const a = createShape('rectangle', 0, 0, 300, 60, { backgroundColor: '#123' });
    a.text = 'um texto relativamente longo que vai quebrar em várias linhas';
    addElements([a]);
    setSelection([a.id]);
    const before = getState().elements[0];
    // alça SE: arrasta para deixar estreita e baixa
    const se = { x: before.x + before.width + 5, y: before.y + before.height + 5 };
    pointerDown(ptr(se.x, se.y));
    pointerMove(ptr(80, 20));
    pointerUp(ptr(80, 20));
    const after = getState().elements[0];
    expect(after.width).toBeLessThan(100);
    expect(after.height).toBeGreaterThan(60); // cresceu para caber o texto quebrado
  });
});

describe('prioridade da seleção ao arrastar (Excalidraw)', () => {
  beforeEach(() => reset());

  it('arrastar dentro da caixa do selecionado move ele mesmo com outro por cima; clique simples seleciona o de cima', () => {
    const bottom = createShape('rectangle', 0, 0, 200, 200, { backgroundColor: '#123' });
    const top = createShape('rectangle', 50, 50, 60, 60, { backgroundColor: '#456' });
    addElements([bottom, top]);
    setSelection([bottom.id]);
    // arrasto começando sobre "top", que está por cima de "bottom" (selecionado)
    pointerDown(ptr(80, 80));
    pointerMove(ptr(130, 80));
    pointerUp(ptr(130, 80));
    let s = getState();
    expect(s.elements.find((e) => e.id === bottom.id)!.x).toBe(50);
    expect(s.elements.find((e) => e.id === top.id)!.x).toBe(50); // não se moveu
    expect(s.selectedIds).toEqual([bottom.id]);
    // clique sem arrastar no mesmo ponto: seleciona o de cima
    pointerDown(ptr(80, 80));
    pointerUp(ptr(80, 80));
    s = getState();
    expect(s.selectedIds).toEqual([top.id]);
  });

  it('frames não capturam cliques no seu interior (filhos continuam clicáveis)', () => {
    const frame = createShape('frame', 0, 0, 300, 300);
    const child = createShape('rectangle', 100, 100, 50, 50, { backgroundColor: '#123' });
    addElements([frame, child]);
    setSelection([frame.id]);
    pointerDown(ptr(120, 120));
    pointerUp(ptr(120, 120));
    expect(getState().selectedIds).toEqual([child.id]);
  });
});

describe('texto dentro de formas', () => {
  beforeEach(() => reset());

  it('palavra longa ou fonte XL alarga a forma (centro mantido) em vez de quebrar no meio da palavra', async () => {
    const { commitTextEdit, updateStyle } = await import('../../src/store/actions');
    const r = createShape('rectangle', 0, 0, 80, 60);
    addElements([r]);
    commitTextEdit(r.id, 'Planejamento');
    let el = getState().elements[0];
    expect(el.width).toBeGreaterThan(80);
    expect(el.x + el.width / 2).toBeCloseTo(40); // centro preservado
    setSelection([r.id]);
    const w1 = el.width;
    updateStyle({ fontSize: 36 });
    el = getState().elements[0];
    expect(el.width).toBeGreaterThan(w1);
  });
});
