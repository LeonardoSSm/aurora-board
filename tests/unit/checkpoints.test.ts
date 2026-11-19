/** Checkpoints espaciais: modelo, saneamento, projeção nas bordas, agrupamento, histórico e persistência. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointSchema, createCheckpoint, patchCheckpoint, sanitizeCheckpoints, CHECKPOINT_LIMITS } from '../../src/core/checkpoints';
import { contains, directionName, inset, layoutIndicators, projectToRect, type Rect } from '../../src/core/edgeIndicators';
import { centerOn, toScreenPoint } from '../../src/core/camera';
import { safeRect } from '../../src/canvas/CheckpointLayer';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addCheckpoint, deleteCheckpoint, duplicateCheckpoint, moveCheckpointToView, navigateToCheckpoint, reorderCheckpoint, updateCheckpoint } from '../../src/store/checkpointActions';
import { addElements, redo, selectAll, undo, zoomToFit } from '../../src/store/actions';
import { __setCameraTestHooks } from '../../src/store/cameraMotion';
import { createBoard, createShape, createWorkspace } from '../../src/core/elements';
import { migrateBoard } from '../../src/persistence/migrations';
import { applyImport, buildExport, parseImport } from '../../src/persistence/exportImport';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { exportSVG } from '../../src/render/exportImage';
import { computeDataflow } from '../../src/core/dataflow';
import { dataflowSpec } from '../../src/widgets/registry';

let n = 0;
const id = () => `cp_${++n}`;
const vp = { width: 1200, height: 800 };
const R: Rect = { left: 10, top: 86, right: 1190, bottom: 736 };
const visible: Rect = { left: 0, top: 0, right: 1200, bottom: 800 };

describe('modelo e validação', () => {
  it('cria com padrões e coordenadas do mundo', () => {
    const cp = createCheckpoint({ name: '  Financeiro ', x: -5000.5, y: 120 }, 'a', 10);
    expect(cp).toMatchObject({ id: 'a', name: 'Financeiro', x: -5000.5, y: 120, color: '#8f9bff', icon: 'pin', savedZoom: null, restoreZoom: false, createdAt: 10 });
  });
  it('rejeita nome vazio, coordenadas não finitas e fora de limite', () => {
    for (const bad of [{ name: ' ', x: 0, y: 0 }, { name: 'a', x: NaN, y: 0 }, { name: 'a', x: 0, y: Infinity }, { name: 'a', x: 2e9, y: 0 }]) {
      expect(CheckpointSchema.safeParse({ ...bad, id: 'x' }).success).toBe(false);
    }
    const cp = createCheckpoint({ name: 'A', x: 0, y: 0 }, 'a');
    expect(patchCheckpoint(cp, { name: '' })).toBeNull();
    expect(patchCheckpoint(cp, { x: NaN })).toBeNull();
    expect(patchCheckpoint(cp, { name: 'B', color: '#123456' })).toMatchObject({ name: 'B', color: '#123456' });
  });
  it('saneamento de importação: corta textos, descarta inválidos sem derrubar, renomeia ids repetidos', () => {
    const raw = [
      { id: 'a', name: 'x'.repeat(200), description: 'd'.repeat(999), x: 1, y: 2, color: 'vermelho', icon: 'caveira', savedZoom: 99 },
      { id: 'a', name: 'Duplicado', x: 3, y: 4 },
      { id: 'b', name: '', x: 0, y: 0 },
      { id: 'c', name: 'NaN', x: 'abc', y: 0 },
      null,
      'texto',
      { name: 'Sem id', x: 5, y: 6, savedZoom: 'grande' },
    ];
    const { checkpoints, warnings } = sanitizeCheckpoints(raw, id);
    expect(checkpoints.map((c) => c.name)).toEqual(['x'.repeat(CHECKPOINT_LIMITS.name), 'Duplicado', 'Sem id']);
    expect(checkpoints[0]).toMatchObject({ color: '#8f9bff', icon: 'pin', savedZoom: 8 });
    expect(checkpoints[0].description).toHaveLength(CHECKPOINT_LIMITS.description);
    expect(new Set(checkpoints.map((c) => c.id)).size).toBe(3);
    expect(checkpoints[2].savedZoom).toBeNull();
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(sanitizeCheckpoints(undefined, id)).toEqual({ checkpoints: [], warnings: [] });
    expect(sanitizeCheckpoints({ oops: 1 }, id).checkpoints).toEqual([]);
  });
});

describe('projeção nas bordas', () => {
  const c = { x: 600, y: 411 };
  it('direções horizontal, vertical e diagonal pela geometria real', () => {
    expect(projectToRect(c, { x: -9000, y: 411 }, R)).toMatchObject({ side: 'left', x: 10, y: 411 });
    expect(projectToRect(c, { x: 9000, y: 411 }, R)).toMatchObject({ side: 'right', x: 1190 });
    expect(projectToRect(c, { x: 600, y: -9000 }, R)).toMatchObject({ side: 'top', y: 86 });
    expect(projectToRect(c, { x: 600, y: 9000 }, R)).toMatchObject({ side: 'bottom', y: 736 });
    // Acima à direita: cai perto do canto superior direito, na reta centro→ponto.
    const p = projectToRect(c, { x: c.x + 5000, y: c.y - 5000 }, R);
    expect(p.side === 'top' || p.side === 'right').toBe(true);
    expect(Math.abs((p.x - c.x) + (p.y - c.y))).toBeLessThan(1e-6); // mesma inclinação (−45°)
    expect(directionName(Math.atan2(-1, 1))).toBe('acima à direita');
    expect(directionName(Math.PI)).toBe('à esquerda');
  });
  it('dentro × fora, com histerese na borda', () => {
    const at = (x: number, y: number) => [{ id: 'a', screen: { x, y } }];
    expect(layoutIndicators(at(600, 400), visible, R, new Set()).inside).toHaveLength(1);
    expect(layoutIndicators(at(-500, 400), visible, R, new Set()).edges).toHaveLength(1);
    // Exatamente na borda: estava fora → continua fora; estava dentro → continua dentro.
    expect(layoutIndicators(at(5, 400), visible, R, new Set()).inside).toHaveLength(0);
    expect(layoutIndicators(at(-5, 400), visible, R, new Set(['a'])).inside).toHaveLength(1);
    expect(layoutIndicators(at(-20, 400), visible, R, new Set(['a'])).inside).toHaveLength(0);
  });
  it('muitos checkpoints na mesma direção viram grupo acessível; distantes ficam separados', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, screen: { x: -3000, y: 380 + i * 3 } }));
    const g = layoutIndicators(many, visible, R, new Set());
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].ids).toHaveLength(10);
    const spread = layoutIndicators([{ id: 'a', screen: { x: -3000, y: -3000 } }, { id: 'b', screen: { x: -3000, y: 4000 } }], visible, R, new Set());
    expect(spread.edges.map((e) => e.ids.length)).toEqual([1, 1]);
    // Indicador sempre dentro da área segura, mesmo com o destino a quilômetros.
    for (const e of layoutIndicators([{ id: 'z', screen: { x: 1e7, y: -1e7 } }], visible, R, new Set()).edges) expect(contains(inset(R, -0.01), e)).toBe(true);
  });
  it('área segura desconta barra, controles e painéis sobrepostos; resize e zoom mudam a projeção', () => {
    const desk = safeRect(vp, { compact: false, libraryOpen: true, propertiesOpen: true });
    expect(desk.safe.top).toBeGreaterThan(60);
    expect(desk.safe.bottom).toBeLessThan(vp.height - 40);
    const phone = safeRect({ width: 390, height: 700 }, { compact: true, libraryOpen: true, propertiesOpen: false });
    expect(phone.safe.left).toBeGreaterThan(250);
    const cam = centerOn({ x: 0, y: 0 }, 1, vp);
    const pt = { x: 500, y: 0 };
    expect(layoutIndicators([{ id: 'a', screen: toScreenPoint(pt, cam) }], desk.visible, desk.safe, new Set()).inside).toHaveLength(1);
    const narrow = safeRect({ width: 600, height: 800 }, { compact: false, libraryOpen: false, propertiesOpen: false });
    expect(layoutIndicators([{ id: 'a', screen: toScreenPoint(pt, centerOn({ x: 0, y: 0 }, 1, { width: 600, height: 800 })) }], narrow.visible, narrow.safe, new Set()).edges[0].side).toBe('right');
    expect(layoutIndicators([{ id: 'a', screen: toScreenPoint(pt, centerOn({ x: 0, y: 0 }, 0.3, vp)) }], desk.visible, desk.safe, new Set()).inside).toHaveLength(1);
  });
});

describe('ações, histórico e navegação', () => {
  beforeEach(() => {
    setState({ ...initialEditorState, boardId: 'A', status: 'ready', viewport: vp, camera: { x: 600, y: 400, zoom: 1 }, elements: [], checkpoints: [], history: {} });
    __setCameraTestHooks(null, false);
  });

  it('criar, editar, reordenar, duplicar, excluir — tudo desfazível', () => {
    const a = addCheckpoint({ name: 'Financeiro', x: -4000, y: 0 })!;
    const b = addCheckpoint({ name: 'Arquitetura', x: 3000, y: 900, color: '#5addaa', icon: 'building' })!;
    expect(addCheckpoint({ name: '   ', x: 0, y: 0 })).toBeNull();
    expect(updateCheckpoint(a, { name: 'Finanças', description: 'Orçamento 2027' })).toBe(true);
    expect(updateCheckpoint(a, { name: '' })).toBe(false);
    reorderCheckpoint(b, -1);
    expect(getState().checkpoints.map((c) => c.name)).toEqual(['Arquitetura', 'Finanças']);
    const copy = duplicateCheckpoint(a)!;
    expect(getState().checkpoints.find((c) => c.id === copy)).toMatchObject({ name: 'Finanças (cópia)', x: -4000 });
    deleteCheckpoint(copy);
    expect(getState().checkpoints).toHaveLength(2);
    undo();
    expect(getState().checkpoints).toHaveLength(3);
    undo(); undo(); undo();
    expect(getState().checkpoints.find((c) => c.id === a)?.name).toBe('Financeiro');
    redo();
    expect(getState().checkpoints.find((c) => c.id === a)?.name).toBe('Finanças');
    expect(getState().elements).toEqual([]);
  });

  it('navegar centraliza exatamente (zoom atual por padrão; o memorizado se pedido)', () => {
    setState({ camera: { x: 0, y: 0, zoom: 1.5 } });
    const a = addCheckpoint({ name: 'A', x: 2500, y: -700 })!;
    navigateToCheckpoint(a);
    expect(getState().camera).toEqual({ zoom: 1.5, x: 600 - 2500 * 1.5, y: 400 + 700 * 1.5 });
    const b = addCheckpoint({ name: 'B', x: 10, y: 20, savedZoom: 0.5, restoreZoom: true })!;
    navigateToCheckpoint(b);
    expect(getState().camera).toEqual({ zoom: 0.5, x: 600 - 5, y: 400 - 10 });
    moveCheckpointToView(a);
    expect(getState().checkpoints.find((c) => c.id === a)).toMatchObject({ x: 10, y: 20 });
  });

  it('checkpoints não são elementos: fora de Ctrl+A, Enquadrar tudo, fluxo de dados e exportação de imagem', async () => {
    addCheckpoint({ name: 'Longe', x: 1e6, y: 1e6 });
    const r = createShape('rectangle', 0, 0, 100, 100);
    addElements([r]);
    selectAll();
    expect(getState().selectedIds).toEqual([r.id]);
    zoomToFit();
    expect(getState().camera.zoom).toBe(1);
    expect(computeDataflow(getState().elements, dataflowSpec).edges.size).toBe(0);
    const { svg } = await exportSVG(getState().elements, { background: true });
    expect(svg).not.toContain('Longe');
  });
});

describe('persistência, migração, importação e múltiplos quadros', () => {
  it('quadros antigos (fixture congelada e sem campo) carregam com lista vazia', () => {
    const legacy = parseImport(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'), 'ws');
    expect(legacy.warnings).toEqual([]);
    expect(legacy.boards[0].checkpoints).toEqual([]);
    const ws = createWorkspace('W');
    const b = createBoard(ws.id, 'Q') as unknown as Record<string, unknown>;
    delete b.checkpoints;
    delete (b.settings as Record<string, unknown>).showCheckpointIndicators;
    const m = migrateBoard(b, ws.id);
    expect(m.board.checkpoints).toEqual([]);
    expect(m.warnings).toEqual([]);
  });

  it('exportar → importar como novo preserva coordenadas, aparência e zoom; dados inválidos saneados', async () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Universo');
    board.checkpoints = [
      createCheckpoint({ name: 'Financeiro', x: -12345.678, y: 9876.5, color: '#f3c577', icon: 'wallet', description: 'Contas', savedZoom: 0.42, restoreZoom: true }, 'cp_fin'),
      createCheckpoint({ name: 'Ideias', x: 1, y: 2 }, 'cp_ide'),
    ];
    const json = JSON.parse(buildExport([board], [], ws));
    json.boards[0].checkpoints.push({ id: 'cp_bad', name: '', x: 0, y: 0 });
    const parsed = parseImport(JSON.stringify(json), ws.id);
    expect(parsed.warnings.some((w) => w.includes('inválido'))).toBe(true);
    const adapter = new MemoryAdapter();
    await adapter.saveBoard(board);
    const { boardIds } = await applyImport(adapter, parsed, ws, () => 'b_copia');
    const copy = (await adapter.loadBoard('b_copia'))!;
    expect(boardIds).toEqual(['b_copia']);
    expect(copy.checkpoints).toEqual(board.checkpoints);
    const original = (await adapter.loadBoard(board.id))!;
    // Editar a cópia não muda o original.
    copy.checkpoints![0].name = 'Mudou';
    await adapter.saveBoard(copy);
    expect((await adapter.loadBoard(board.id))!.checkpoints![0].name).toBe('Financeiro');
    expect(original.checkpoints).toHaveLength(2);
  });

  it('cada quadro tem os seus checkpoints (estado do editor vem do quadro aberto)', async () => {
    const { openBoard } = await import('../../src/store/actions');
    const { setAdapter } = await import('../../src/persistence/autosave');
    const adapter = new MemoryAdapter();
    setAdapter(adapter);
    const ws = createWorkspace('W');
    const a = createBoard(ws.id, 'A'), b = createBoard(ws.id, 'B');
    a.checkpoints = [createCheckpoint({ name: 'Só no A', x: 5, y: 5 }, 'cp_a')];
    ws.boardOrder = [a.id, b.id];
    await adapter.saveWorkspace(ws);
    await adapter.saveBoard(a);
    await adapter.saveBoard(b);
    setState({ ...initialEditorState, status: 'ready', workspaces: [ws], workspaceId: ws.id, boards: [a, b].map(({ elements: _e, ...m }) => m), viewport: vp, history: {} });
    await openBoard(a.id);
    expect(getState().checkpoints.map((c) => c.name)).toEqual(['Só no A']);
    await openBoard(b.id);
    expect(getState().checkpoints).toEqual([]);
    await openBoard(a.id);
    expect(getState().checkpoints.map((c) => c.name)).toEqual(['Só no A']);
  });
});
