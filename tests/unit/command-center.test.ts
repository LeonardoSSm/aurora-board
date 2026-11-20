/** Issue #14 — índice entre quadros, incremental, corrida de navegação, captura/Inbox e benchmark (MemoryAdapter). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { flushSave, setAdapter } from '../../src/persistence/autosave';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { __resetIndex, indexSize, jumpTo, refreshIndex, search } from '../../src/store/commandCenter';
import { capture } from '../../src/store/quickCapture';
import { createBoard as makeBoard, createText } from '../../src/core/elements';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { __setCameraTestHooks } from '../../src/store/cameraMotion';
import type { Board, Workspace } from '../../src/core/schema';

registerBuiltinWidgets();

let adapter: MemoryAdapter;
const ws: Workspace = { id: 'W1', name: 'Pessoal', boardOrder: [], createdAt: 1, updatedAt: 1 } as Workspace;

async function addBoard(name: string, els: Board['elements'] = [], updatedAt = 1000): Promise<Board> {
  const b = { ...makeBoard('W1', name, ''), elements: els, updatedAt };
  await adapter.saveBoard(b);
  ws.boardOrder.push(b.id);
  await adapter.saveWorkspace(ws);
  return b;
}

beforeEach(async () => {
  adapter = new MemoryAdapter();
  setAdapter(adapter);
  ws.boardOrder = [];
  await adapter.saveWorkspace(ws);
  __resetIndex();
  __setCameraTestHooks(null, false);
  setState({ ...initialEditorState, status: 'ready', workspaces: [ws], workspaceId: 'W1', boards: [], boardId: '', elements: [], checkpoints: [], history: {} });
});
afterEach(() => __setCameraTestHooks(null, null));

async function openAs(board: Board) {
  const metas = await adapter.listBoards('W1');
  setState({ boards: metas, boardId: board.id, elements: board.elements, checkpoints: board.checkpoints ?? [] });
}

describe('índice entre quadros', () => {
  it('encontra conteúdo de quadros fechados e do atual; ids não se misturam', async () => {
    const t1 = createText(0, 0, 'Orçamento da reforma');
    const a = await addBoard('Projetos', [t1]);
    const b = await addBoard('Casa', [createText(0, 0, 'Jardim')]);
    await openAs(b);
    await refreshIndex();
    const r = search('orcamento');
    expect(r).toHaveLength(1);
    expect(r[0].doc).toMatchObject({ boardId: a.id, id: t1.id });
    expect(r[0].boardName).toBe('Projetos');
    expect(search('jardim')[0].doc.boardId).toBe(b.id);
  });

  it('incremental: relê só o quadro alterado; excluídos saem', async () => {
    const a = await addBoard('A', [createText(0, 0, 'alfa')]);
    const b = await addBoard('B', [createText(0, 0, 'beta')]);
    const c = await addBoard('C', []);
    await openAs(c);
    let loads = 0;
    const orig = adapter.loadBoard.bind(adapter);
    adapter.loadBoard = async (id) => { loads++; return orig(id); };
    await refreshIndex();
    expect(loads).toBe(2);
    loads = 0;
    await refreshIndex();
    expect(loads).toBe(0); // nada mudou: nenhuma leitura
    await adapter.saveBoard({ ...(await orig(a.id))!, elements: [createText(0, 0, 'alfa revisado')], updatedAt: 5000 });
    await refreshIndex();
    expect(loads).toBe(1);
    expect(search('revisado')).toHaveLength(1);
    await adapter.deleteBoard(b.id);
    await refreshIndex();
    expect(search('beta')).toHaveLength(0);
  });

  it('arquivados ficam fora por padrão', async () => {
    const a = await addBoard('Velho', [createText(0, 0, 'histórico')]);
    await adapter.saveBoard({ ...(await adapter.loadBoard(a.id))!, archived: true });
    const cur = await addBoard('Atual');
    await openAs(cur);
    await refreshIndex();
    expect(search('historico')).toHaveLength(0);
    expect(search('historico', { includeArchived: true })).toHaveLength(1);
  });
});

describe('navegação', () => {
  it('resultado excluído desde a indexação: avisa e não trava', async () => {
    const t = createText(0, 0, 'efêmero');
    const b = await addBoard('Único', [t]);
    await openAs(b);
    await refreshIndex();
    const [r] = search('efemero');
    setState({ elements: [] });
    expect(await jumpTo(r.doc)).toBe('missing');
  });
});

describe('captura rápida', () => {
  it('no quadro atual: um elemento novo, seleção e câmera intactas', async () => {
    const b = await addBoard('Atual', [createText(0, 0, 'x')]);
    await openAs(b);
    setState({ selectedIds: [b.elements[0].id], camera: { x: 10, y: 20, zoom: 1.5 } });
    const res = await capture({ kind: 'note', title: 'Ideia', details: 'detalhe' }, 'current');
    const s = getState();
    expect(s.elements).toHaveLength(2);
    expect(s.selectedIds).toEqual([b.elements[0].id]);
    expect(s.camera).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(s.elements.find((e) => e.id === res.elementId)).toMatchObject({ type: 'widget', widgetType: 'aurora.notes', title: 'Ideia' });
  });

  it('Inbox fechado: grava no adaptador sem tocar no estado; recusa com pendência; título vazio não grava', async () => {
    const inbox = await addBoard('Inbox', [createText(0, 0, 'antigo')]);
    const cur = await addBoard('Atual', []);
    await openAs(cur);
    const before = getState().elements;
    await capture({ kind: 'task', title: 'Pagar boleto', details: '' }, inbox.id);
    expect(getState().elements).toBe(before);
    const saved = (await adapter.loadBoard(inbox.id))!;
    expect(saved.elements).toHaveLength(2);
    expect(saved.elements[0]).toMatchObject({ text: 'antigo' }); // nada perdido
    expect((saved.elements[1] as { data: { items: { text: string }[] } }).data.items[0].text).toBe('Pagar boleto');
    await expect(capture({ kind: 'note', title: '   ', details: '' }, inbox.id)).rejects.toThrow(/título/);
    expect((await adapter.loadBoard(inbox.id))!.elements).toHaveLength(2);
  });

  it('falha de gravação (cota): erro e quadro de destino intacto', async () => {
    const inbox = await addBoard('Inbox', []);
    const cur = await addBoard('Atual', []);
    await openAs(cur);
    adapter.saveBoard = async () => { throw new DOMException('QuotaExceededError', 'QuotaExceededError'); };
    await expect(capture({ kind: 'note', title: 'x', details: '' }, inbox.id)).rejects.toThrow();
    expect((await adapter.loadBoard(inbox.id))!.elements).toHaveLength(0);
  });

  it('o autosave do quadro aberto não apaga o que foi capturado em outro quadro', async () => {
    const inbox = await addBoard('Inbox', []);
    const cur = await addBoard('Atual', []);
    await openAs(cur);
    await capture({ kind: 'note', title: 'Guardar', details: '' }, inbox.id);
    setState({ elements: [createText(0, 0, 'editando o atual')] });
    await flushSave(true);
    expect((await adapter.loadBoard(inbox.id))!.elements).toHaveLength(1);
  });
});

describe('desempenho (100 quadros / 20 mil elementos)', () => {
  it('indexa e busca dentro do orçamento', async () => {
    const words = ['projeto', 'reunião', 'orçamento', 'viagem', 'código', 'jardim', 'cozinha', 'mercado'];
    for (let i = 0; i < 100; i++) {
      const els = Array.from({ length: 200 }, (_, k) => createText(k * 10, i * 10, `${words[(i + k) % words.length]} item ${i}-${k}`));
      await addBoard(`Quadro ${i}`, els, 1000 + i);
    }
    const cur = await addBoard('Atual', []);
    await openAs(cur);
    const t0 = performance.now();
    await refreshIndex();
    const tIndex = performance.now() - t0;
    expect(indexSize()).toBeGreaterThanOrEqual(20_000);
    const t1 = performance.now();
    const r = search('orcamento item 42');
    const tSearch = performance.now() - t1;
    expect(r.length).toBeGreaterThan(0);
    expect(tIndex).toBeLessThan(8000);
    expect(tSearch).toBeLessThan(250);
    console.info(`[bench N1] indexação 100 quadros/20 mil elementos: ${Math.round(tIndex)} ms; busca: ${tSearch.toFixed(1)} ms`);
  }, 30_000);
});
