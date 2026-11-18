import { beforeEach, describe, expect, it } from 'vitest';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import {
  addElements,
  commitTextEdit,
  createTextAt,
  deleteSelected,
  duplicateSelected,
  groupSelection,
  pasteContent,
  redo,
  serializeSelection,
  setSelection,
  undo,
  ungroupSelection,
  updateStyle,
  zoomAt,
  screenToWorld,
  worldToScreen,
} from '../../src/store/actions';
import { createLinear, createShape } from '../../src/core/elements';
import { pointerDown, pointerMove, pointerUp, type PointerInfo } from '../../src/canvas/controller';
import type { LinearElement } from '../../src/core/schema';

function reset() {
  setState({ ...initialEditorState, boardId: 'b', status: 'ready', history: {}, elements: [], boards: [] });
}

const ptr = (x: number, y: number, extra: Partial<PointerInfo> = {}): PointerInfo => ({
  screen: worldToScreen({ x, y }),
  world: { x, y },
  button: 0,
  shift: false,
  alt: false,
  ctrl: false,
  pointerType: 'mouse',
  pointerId: 1,
  pressure: 0.5,
  ...extra,
});

describe('comandos do editor', () => {
  beforeEach(reset);

  it('adicionar → desfazer → refazer', () => {
    const r = createShape('rectangle', 0, 0, 10, 10);
    addElements([r]);
    expect(getState().elements).toHaveLength(1);
    undo();
    expect(getState().elements).toHaveLength(0);
    redo();
    expect(getState().elements[0].id).toBe(r.id);
  });

  it('criar texto e confirmar gera uma única entrada de histórico; texto vazio é descartado', () => {
    const t = createTextAt({ x: 10, y: 10 });
    commitTextEdit(t.id, 'Olá mundo');
    expect(getState().elements[0].text).toBe('Olá mundo');
    expect(getState().history.b.undo).toHaveLength(1);
    const t2 = createTextAt({ x: 50, y: 50 });
    commitTextEdit(t2.id, '   ');
    expect(getState().elements).toHaveLength(1);
    expect(getState().history.b.undo).toHaveLength(1);
  });

  it('texto dentro de forma (duplo clique) e mudança de tamanho/fonte', () => {
    const r = createShape('rectangle', 0, 0, 160, 40);
    addElements([r]);
    commitTextEdit(r.id, 'linha 1\nlinha 2\nlinha 3\nlinha 4');
    const el = getState().elements[0];
    expect(el.text).toContain('linha 4');
    expect(el.height).toBeGreaterThan(40); // forma cresce para caber o texto
    setSelection([r.id]);
    updateStyle({ fontSize: 36, fontFamily: 'mono' });
    expect(getState().elements[0].style.fontSize).toBe(36);
    expect(getState().elements[0].style.fontFamily).toBe('mono');
  });

  it('agrupar, mover o grupo preservando estrutura e desagrupar', () => {
    const a = createShape('rectangle', 0, 0, 50, 50, { backgroundColor: '#123' });
    const b = createShape('ellipse', 100, 0, 50, 50, { backgroundColor: '#123' });
    addElements([a, b]);
    setSelection([a.id, b.id]);
    groupSelection();
    // clicar em um seleciona o grupo inteiro
    setSelection([]);
    pointerDown(ptr(25, 25));
    expect(getState().selectedIds.sort()).toEqual([a.id, b.id].sort());
    pointerMove(ptr(75, 125));
    pointerUp(ptr(75, 125));
    const [a2, b2] = getState().elements;
    expect([a2.x, a2.y]).toEqual([50, 100]);
    expect([b2.x, b2.y]).toEqual([150, 100]);
    expect(b2.x - a2.x).toBe(100);
    ungroupSelection();
    expect(getState().elements.every((e) => e.groupIds.length === 0)).toBe(true);
    // desfazer volta para agrupado
    undo();
    expect(getState().elements.every((e) => e.groupIds.length === 1)).toBe(true);
  });

  it('desenhar retângulo com a ferramenta e criar seta entre formas', () => {
    setState({ tool: 'rectangle' });
    pointerDown(ptr(0, 0));
    pointerMove(ptr(120, 80));
    pointerUp(ptr(120, 80));
    const rect = getState().elements[0];
    expect(rect).toMatchObject({ type: 'rectangle', x: 0, y: 0, width: 120, height: 80 });
    expect(getState().tool).toBe('select');

    setState({ tool: 'rectangle' });
    pointerDown(ptr(400, 0));
    pointerMove(ptr(500, 80));
    pointerUp(ptr(500, 80));
    const rect2 = getState().elements[1];

    setState({ tool: 'arrow' });
    pointerDown(ptr(60, 40));
    pointerMove(ptr(300, 40));
    pointerMove(ptr(450, 40));
    pointerUp(ptr(450, 40));
    const arrow = getState().elements[2] as LinearElement;
    expect(arrow.startBinding?.elementId).toBe(rect.id);
    expect(arrow.endBinding?.elementId).toBe(rect2.id);

    // mover a forma de destino: a seta acompanha
    setState({ tool: 'select', selectedIds: [] });
    pointerDown(ptr(450, 2));
    pointerMove(ptr(450, 302));
    pointerUp(ptr(450, 302));
    const moved = getState().elements.find((e) => e.id === arrow.id) as LinearElement;
    expect(moved.endBinding?.elementId).toBe(rect2.id);
    expect(moved.y + moved.points[1][1]).toBeGreaterThan(250);
  });

  it('ferramenta Conectar exige origem e destino', () => {
    const a = createShape('rectangle', 0, 0, 100, 100, { backgroundColor: '#123' });
    addElements([a]);
    setState({ tool: 'connect', connectionKind: 'data' });
    pointerDown(ptr(50, 50));
    pointerMove(ptr(400, 400));
    pointerUp(ptr(400, 400));
    expect(getState().elements).toHaveLength(1); // cancelada
  });

  it('excluir e duplicar', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    addElements([a]);
    duplicateSelected();
    expect(getState().elements).toHaveLength(2);
    expect(getState().elements[1].x).toBe(24);
    deleteSelected();
    expect(getState().elements).toHaveLength(1);
  });

  it('copiar e colar elementos (com offset) e texto/URL', async () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    const arrow = createLinear('arrow', 20, 0, [[0, 0], [10, 0]]);
    addElements([a, arrow]);
    setSelection([a.id, arrow.id]);
    const data = serializeSelection()!;
    await pasteContent(data, [], null);
    expect(getState().elements).toHaveLength(4);
    expect(getState().elements[2].id).not.toBe(a.id);
    await pasteContent('texto colado', [], { x: 0, y: 0 });
    expect(getState().elements.at(-1)!.type).toBe('text');
  });

  it('zoom com foco no cursor mantém o ponto sob o ponteiro', () => {
    setState({ camera: { x: 0, y: 0, zoom: 1 } });
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(anchor);
    zoomAt(2.5, anchor);
    const after = screenToWorld(anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(getState().camera.zoom).toBe(2.5);
  });

  it('seleção por área (marquee) seleciona elementos contidos', () => {
    const a = createShape('rectangle', 10, 10, 20, 20);
    const b = createShape('rectangle', 300, 300, 20, 20);
    addElements([a, b]);
    setState({ selectedIds: [] });
    pointerDown(ptr(0, 0));
    pointerMove(ptr(100, 100));
    pointerUp(ptr(100, 100));
    expect(getState().selectedIds).toEqual([a.id]);
  });
});
