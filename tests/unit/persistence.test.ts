import { describe, expect, it } from 'vitest';
import { IndexedDBAdapter } from '../../src/persistence/indexeddb';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { buildExport, ImportError, parseImport } from '../../src/persistence/exportImport';
import { migrateBoard } from '../../src/persistence/migrations';
import { importLegacy } from '../../src/persistence/legacy';
import { createBoard, createLinear, createShape, createWorkspace, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import { SCHEMA_VERSION, type LinearElement } from '../../src/core/schema';

/** Estrutura idêntica à gravada pelo protótipo Aurora Board v0.3 (aurora-board-v2-data). */
function legacyFixture() {
  return {
    version: 2,
    active: 'b1',
    boards: [
      {
        id: 'b1',
        name: 'Operação Dark',
        camera: { x: 70, y: 80, z: 0.8 },
        nodes: [
          { id: 'n1', type: 'group', x: 80, y: 100, w: 265, title: 'Operação Dark', desc: 'Plano visual', color: '#6ca7ff', data: {} },
          { id: 'n2', type: 'task', x: 410, y: 280, w: 265, title: 'Próximos passos', desc: '', color: '#67dcaf', data: { items: [{ id: 't1', text: 'Escolher nicho', done: true }, { id: 't2', text: 'Produzir vídeo', done: false }] } },
          { id: 'n3', type: 'finance', x: 760, y: 320, w: 265, title: 'Controle', desc: '', color: '#67dcaf', data: { items: [{ id: 'f1', text: 'Receita', value: 1500.5 }, { id: 'f2', text: 'Gasto', value: -200.25 }] } },
          { id: 'n4', type: 'calendar', x: 760, y: 60, w: 265, title: 'Agenda', desc: '', data: { events: [{ id: 'e1', date: '2026-11-18', title: 'Publicar' }] } },
          { id: 'n5', type: 'ai', x: 1090, y: 160, w: 265, title: 'Assistente', desc: '', data: { prompt: 'Analise.' } },
          { id: 'n6', type: 'manual_rect', x: 0, y: 400, w: 190, h: 125, title: 'Retângulo', desc: 'Texto dentro', groupId: 'g1', style: { stroke: '#f47f8d', fill: '#63333c', sw: 2.5, dash: 'dashed', rounded: false, opacity: 80, font: 'clean', size: 30, align: 'left' }, data: {} },
          { id: 'n7', type: 'manual_arrow', x: 200, y: 400, w: 100, h: 50, title: 'Seta', desc: '', groupId: 'g1', style: {}, data: { positiveSlope: true, fromLeft: true } },
          { id: 'n8', type: 'manual_text', x: 0, y: 600, w: 250, h: 60, title: 'Texto', desc: 'Olá', style: { font: 'mono', size: 16 }, data: {} },
          { id: 'n9', type: 'image', x: 0, y: 700, w: 265, title: 'Img', desc: '', data: { src: 'data:image/png;base64,iVBORw0KGgo=' } },
          { id: 'n10', type: 'mystery', x: 0, y: 0, w: 10, title: '?', desc: '', data: {} },
        ],
        edges: [
          { id: 'e1', from: 'n1', to: 'n2', kind: 'reference', label: '' },
          { id: 'e2', from: 'n3', to: 'n5', kind: 'context', label: 'dados' },
          { id: 'e3', from: 'n2', to: 'n4', kind: 'flow', label: '' },
          { id: 'e4', from: 'n2', to: 'nX', kind: 'flow', label: '' },
        ],
        strokes: [{ path: 'M 10 10 L 20 20 L 30 15', color: '#77b9ff' }],
      },
      { id: 'b2', name: 'Meu espaço', nodes: [], edges: [], strokes: [], camera: { x: 0, y: 0, z: 1 } },
    ],
  };
}

describe('importação v0.2/v0.3', () => {
  it('converte blocos, formas, conexões, traços e reporta incompatibilidades', () => {
    const r = importLegacy(legacyFixture(), 'ws1');
    expect(r.boards).toHaveLength(2);
    const b = r.boards[0];
    expect(b.camera.zoom).toBe(0.8);
    const tasks = b.elements.find((e) => e.type === 'widget' && e.widgetType === WIDGET.tasks);
    expect((tasks as any).data.items.map((i: any) => i.status)).toEqual(['done', 'todo']);
    const fin = b.elements.find((e) => e.type === 'widget' && e.widgetType === WIDGET.finance) as any;
    expect(fin.data.entries.map((e: any) => [e.kind, e.amountCents])).toEqual([['income', 150050], ['expense', 20025]]);
    const rect = b.elements.find((e) => e.type === 'rectangle')!;
    expect(rect.text).toBe('Texto dentro');
    expect(rect.style).toMatchObject({ strokeColor: '#f47f8d', backgroundColor: '#63333c', strokeStyle: 'dashed', roundness: 'sharp', opacity: 80, fontFamily: 'sans', fontSize: 30, textAlign: 'left' });
    const arrowShape = b.elements.find((e) => e.type === 'arrow' && !(e as LinearElement).startBinding) as LinearElement;
    expect(arrowShape.groupIds).toEqual(rect.groupIds);
    expect(arrowShape.points[1]).toEqual([100, 50]);
    const bound = b.elements.filter((e) => e.type === 'arrow' && (e as LinearElement).startBinding) as LinearElement[];
    expect(bound).toHaveLength(3);
    expect(bound.map((a) => a.connection.kind).sort()).toEqual(['context', 'visual', 'visual']);
    expect(b.elements.some((e) => e.type === 'freedraw')).toBe(true);
    expect(b.elements.some((e) => e.type === 'image')).toBe(true);
    expect(r.assets).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('mystery'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('inexistente'))).toBe(true);
  });

  it('parseImport detecta formato legado', () => {
    const r = parseImport(JSON.stringify(legacyFixture()), 'ws1');
    expect(r.source).toBe('legacy-v0.3');
    expect(r.boards.every((b) => b.workspaceId === 'ws1')).toBe(true);
  });
});

describe('exportação / importação (formato atual)', () => {
  it('ida e volta preserva elementos e assets', () => {
    const b = createBoard('ws', 'Teste');
    const r = createShape('rectangle', 1, 2, 3, 4);
    r.text = 'oi';
    b.elements = [r, createWidget(WIDGET.notes, '1.0.0', 'N', 0, 0, 10, 10, { markdown: '# x', mode: 'edit' })];
    const asset = { id: 'a1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', name: 'x', size: 2, createdAt: 1 };
    const out = parseImport(buildExport([b], [asset]), 'ws2');
    expect(out.source).toBe('aurora');
    expect(out.boards[0].elements).toEqual(b.elements);
    expect(out.boards[0].workspaceId).toBe('ws2');
    expect(out.assets).toEqual([asset]);
  });

  it('rejeita JSON inválido e formatos desconhecidos', () => {
    expect(() => parseImport('{oops', 'ws')).toThrow(ImportError);
    expect(() => parseImport('{"foo":1}', 'ws')).toThrow(/Formato não reconhecido/);
    expect(() => parseImport(JSON.stringify({ type: 'excalidraw', elements: [] }), 'ws')).toThrow(/Excalidraw/);
  });

  it('elementos inválidos são descartados com aviso, sem perder o restante', () => {
    const file = { format: 'aurora-board', schemaVersion: SCHEMA_VERSION, exportedAt: 1, app: 'x', boards: [{ id: 'b', name: 'B', elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }, { type: 'nave-espacial' }] }], assets: [] };
    const r = parseImport(JSON.stringify(file), 'ws');
    expect(r.boards[0].elements).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('migração preenche campos ausentes e avisa sobre versão futura', () => {
    const { board, warnings } = migrateBoard({ id: 'x', name: 'Futuro', schemaVersion: SCHEMA_VERSION + 5, elements: [{ id: 'l', type: 'arrow', x: 0, y: 0, width: 5, height: 5 }] }, 'ws');
    expect(board.settings.gridSize).toBeGreaterThan(0);
    expect((board.elements[0] as LinearElement).connection.kind).toBe('visual');
    expect(warnings[0]).toMatch(/versão mais nova/);
  });
});

describe('adaptadores de persistência', () => {
  for (const [name, make] of [['IndexedDB', () => new IndexedDBAdapter(`test-${Math.random()}`)], ['Memória', () => new MemoryAdapter()]] as const) {
    it(`${name}: salva, lista, carrega e exclui`, async () => {
      const a = make();
      const ws = createWorkspace('W');
      await a.saveWorkspace(ws);
      const b = createBoard(ws.id, 'Quadro');
      b.elements = [createShape('ellipse', 0, 0, 10, 10), createLinear('arrow', 0, 0, [[0, 0], [5, 5]])];
      await a.saveBoard(b);
      expect((await a.listWorkspaces()).map((w) => w.id)).toEqual([ws.id]);
      const metas = await a.listBoards(ws.id);
      expect(metas).toHaveLength(1);
      expect('elements' in metas[0]).toBe(false);
      expect((await a.loadBoard(b.id))?.elements).toEqual(b.elements);
      await a.putAsset({ id: 'as', mimeType: 'text/plain', dataURL: 'data:,x', name: 'x', size: 1, createdAt: 0 });
      expect((await a.getAsset('as'))?.dataURL).toBe('data:,x');
      await a.setSetting('k', { v: 1 });
      expect(await a.getSetting('k')).toEqual({ v: 1 });
      await a.deleteBoard(b.id);
      expect(await a.loadBoard(b.id)).toBeNull();
      await a.saveBoard(b);
      await a.deleteWorkspace(ws.id);
      expect(await a.loadBoard(b.id)).toBeNull();
    });
  }
});
