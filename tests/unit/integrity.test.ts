/** Reação do app a dados inconsistentes gravados no armazenamento. */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { createBoard, createLinear, createShape, createWorkspace } from '../../src/core/elements';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { initEditor } from '../../src/store/init';
import { migrateBoard, repairReferences } from '../../src/persistence/migrations';
import type { Board, LinearElement } from '../../src/core/schema';

describe('reparo de referências', () => {
  it('remove vínculos e frames órfãos e grupos de um membro só', () => {
    const a = createShape('rectangle', 0, 0, 10, 10);
    a.frameId = 'nao-existe';
    a.groupIds = ['g-solo'];
    const arrow = createLinear('arrow', 0, 0, [[0, 0], [10, 10]]);
    arrow.startBinding = { elementId: a.id, fixedPoint: null };
    arrow.endBinding = { elementId: 'sumiu', fixedPoint: null };
    const w = repairReferences([a, arrow]);
    expect(a.frameId).toBeNull();
    expect(a.groupIds).toEqual([]);
    expect(arrow.startBinding?.elementId).toBe(a.id);
    expect(arrow.endBinding).toBeNull();
    expect(w).toHaveLength(2);
  });

  it('ids duplicados, elementos inválidos e valores não numéricos', () => {
    const r = createShape('rectangle', 0, 0, 10, 10);
    const raw = { id: 'b', name: 'X', elements: [r, { ...r }, { type: 'rectangle', x: 'abc', y: null }, { type: 'arrow', id: 'z', x: 0, y: 0, points: [[0, 0]] }, null] };
    const { board, warnings } = migrateBoard(raw, 'ws');
    expect(board.elements.length).toBeGreaterThanOrEqual(2);
    expect(new Set(board.elements.map((e) => e.id)).size).toBe(board.elements.length);
    for (const e of board.elements) { expect(Number.isFinite(e.x)).toBe(true); expect(Number.isFinite(e.y)).toBe(true); }
    expect(warnings.some((w) => w.includes('duplicado'))).toBe(true);
    expect(warnings.some((w) => w.includes('inválido'))).toBe(true);
  });
});

describe('abrir um quadro corrompido gravado no IndexedDB', () => {
  beforeEach(() => { localStorage.clear(); setState({ ...initialEditorState, history: {}, toasts: [] }); });

  it('abre com o que é válido, avisa o usuário e não altera o banco até a próxima edição', async () => {
    const adapter = new MemoryAdapter();
    const ws = createWorkspace('W');
    const b = createBoard(ws.id, 'Corrompido');
    const ok = createShape('rectangle', 0, 0, 10, 10);
    const orphan = createLinear('arrow', 0, 0, [[0, 0], [5, 5]]) as LinearElement;
    orphan.endBinding = { elementId: 'apagado', fixedPoint: null };
    const corrupted = { ...b, elements: [ok, orphan, { type: 'ellipse', id: 'ruim', x: NaN }] } as unknown as Board;
    ws.boardOrder = [b.id];
    await adapter.saveWorkspace(ws);
    await adapter.saveBoard(corrupted);
    await initEditor(adapter, { demo: false });
    const s = getState();
    expect(s.status).toBe('ready');
    // coordenada inválida é reparada (0) em vez de descartar o elemento
    expect(s.elements.map((e) => e.id)).toEqual([ok.id, orphan.id, 'ruim']);
    expect(s.elements[2].x).toBe(0);
    expect((s.elements[1] as LinearElement).endBinding).toBeNull();
    expect(s.toasts.some((t) => t.message.includes('integridade'))).toBe(true);
    // Sem edição, nada é regravado: o original continua disponível para recuperação manual/exportação.
    expect((await adapter.loadBoard(b.id))!.elements).toHaveLength(3);
  });
});
