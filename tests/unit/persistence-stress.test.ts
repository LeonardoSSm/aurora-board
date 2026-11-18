/**
 * Testes de estresse e concorrência da persistência (autosave + diário de recuperação).
 * Gravações são controladas por "portões" para reproduzir intercalações exatas, sem depender de tempo real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '../../src/persistence/adapter';
import type { AuroraElement, Board } from '../../src/core/schema';
import { createBoard, createShape, createWorkspace } from '../../src/core/elements';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addElements, openBoard, updateBoardMeta } from '../../src/store/actions';
import { initEditor } from '../../src/store/init';
import * as auto from '../../src/persistence/autosave';
const { flushSave, hasPendingChanges } = auto;
// Compatível com a API antiga (diário único) para reproduzir o defeito antes da correção.
const readJournals = (): { boardId: string; board: Board }[] => {
  const a = auto as unknown as { readJournals?: () => { boardId: string; board: Board }[]; readJournal?: () => { boardId: string; board: Board } | null };
  if (a.readJournals) return a.readJournals();
  const j = a.readJournal?.();
  return j ? [j] : [];
};
import { parseImport, buildExport } from '../../src/persistence/exportImport';

interface Gate { board: Board; release: () => Promise<void>; fail: (e?: Error) => void }

/** Adaptador cujas gravações ficam pendentes até serem liberadas (ou falharem) pelo teste. */
class GatedAdapter extends MemoryAdapter {
  gates: Gate[] = [];
  gated = false;
  async saveBoard(board: Board): Promise<void> {
    if (!this.gated) return super.saveBoard(board);
    return new Promise<void>((resolve, reject) => {
      this.gates.push({
        board: structuredClone(board),
        release: async () => { await MemoryAdapter.prototype.saveBoard.call(this, board); resolve(); await tick(); },
        fail: (e = new Error('falha simulada')) => reject(e),
      });
    });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

let adapter: GatedAdapter;
let boardA: Board, boardB: Board;

async function setup() {
  localStorage.clear();
  (localStorage as unknown as { failWrites: unknown }).failWrites = false;
  setState({ ...initialEditorState, history: {}, toasts: [] });
  adapter = new GatedAdapter();
  const ws = createWorkspace('W');
  boardA = createBoard(ws.id, 'A');
  boardB = createBoard(ws.id, 'B');
  ws.boardOrder = [boardA.id, boardB.id];
  await adapter.saveWorkspace(ws);
  await adapter.saveBoard(boardA);
  await adapter.saveBoard(boardB);
  await adapter.setSetting(`lastBoard:${ws.id}`, boardA.id);
  await initEditor(adapter, { demo: false });
  expect(getState().boardId).toBe(boardA.id);
}

function addRect(label: string): AuroraElement {
  const r = createShape('rectangle', 0, 0, 10, 10);
  r.text = label;
  addElements([r], false);
  return r;
}

const journalFor = (id: string) => readJournals().find((j) => j.boardId === id);

describe('persistência sob concorrência', () => {
  beforeEach(setup);
  afterEach(() => vi.useRealTimers());

  it('gravação antiga NÃO apaga o diário de uma alteração mais nova (R1) nem marca "salvo" cedo (R2)', async () => {
    adapter.gated = true;
    addRect('v1');
    const p1 = flushSave();
    addRect('v2');
    const p2 = flushSave();
    await tick();
    expect(adapter.gates).toHaveLength(1); // v2 aguarda v1 (fila)
    await adapter.gates[0].release();
    await settle();
    // v1 gravada, v2 ainda não: o diário precisa conter v2 e o estado não pode ser "salvo"
    expect(journalFor(boardA.id)?.board.elements.map((e) => e.text)).toEqual(['v1', 'v2']);
    expect(getState().saveState).not.toBe('saved');
    expect(hasPendingChanges()).toBe(true);
    await adapter.gates[1].release();
    await Promise.all([p1, p2]);
    await settle();
    expect(getState().saveState).toBe('saved');
    expect(journalFor(boardA.id)).toBeUndefined();
    expect((await adapter.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['v1', 'v2']);
  });

  it('cem alterações rápidas resultam no estado final gravado, sem gravações perdidas', async () => {
    for (let i = 0; i < 100; i++) addRect(`r${i}`);
    await flushSave();
    await settle();
    const saved = await adapter.loadBoard(boardA.id);
    expect(saved!.elements).toHaveLength(100);
    expect(saved!.elements.at(-1)!.text).toBe('r99');
    expect(getState().saveState).toBe('saved');
  });

  it('edição enquanto uma gravação está pendente é gravada em seguida', async () => {
    adapter.gated = true;
    addRect('a');
    void flushSave();
    await tick();
    addRect('b'); // durante a gravação
    adapter.gated = false;
    await adapter.gates[0].release();
    await flushSave();
    await settle();
    expect((await adapter.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('trocar de quadro com gravação pendente não perde nem mistura dados', async () => {
    adapter.gated = true;
    addRect('em A');
    const switching = openBoard(boardB.id); // força flush de A
    await tick();
    expect(adapter.gates).toHaveLength(1);
    await adapter.gates[0].release();
    await switching;
    adapter.gated = false;
    expect(getState().boardId).toBe(boardB.id);
    expect(getState().elements).toHaveLength(0);
    addRect('em B');
    await flushSave();
    await settle();
    expect((await adapter.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['em A']);
    expect((await adapter.loadBoard(boardB.id))!.elements.map((e) => e.text)).toEqual(['em B']);
  });

  it('falha de gravação mantém dados recuperáveis por quadro, mesmo após trocar de quadro (R3)', async () => {
    adapter.gated = true;
    addRect('A não salvo');
    const switching = openBoard(boardB.id);
    await tick();
    adapter.gates[0].fail();
    await switching;
    await settle();
    adapter.gated = true;
    addRect('B não salvo');
    void flushSave();
    await tick();
    // os dois quadros precisam continuar recuperáveis
    expect(journalFor(boardA.id)?.board.elements.map((e) => e.text)).toEqual(['A não salvo']);
    expect(journalFor(boardB.id)?.board.elements.map((e) => e.text)).toEqual(['B não salvo']);
    expect(getState().saveState).toBe('error');
  });

  it('falha seguida de nova tentativa bem-sucedida limpa o erro e grava', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    adapter.gated = true;
    addRect('x');
    const p = flushSave();
    await vi.advanceTimersByTimeAsync(0);
    adapter.gates[0].fail();
    await p;
    expect(getState().saveState).toBe('error');
    adapter.gated = false;
    await vi.advanceTimersByTimeAsync(5000); // nova tentativa automática
    expect((await adapter.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['x']);
    expect(getState().saveState).toBe('saved');
    expect(journalFor(boardA.id)).toBeUndefined();
  });

  it('fechar a página com alterações pendentes grava o diário de forma síncrona', async () => {
    adapter.gated = true;
    addRect('ao fechar');
    window.dispatchEvent(new Event('pagehide'));
    expect(journalFor(boardA.id)?.board.elements.map((e) => e.text)).toEqual(['ao fechar']);
  });

  it('reabrir após gravação interrompida recupera o diário', async () => {
    adapter.gated = true;
    addRect('interrompido');
    void flushSave(); // gravação nunca concluída (aba fechada)
    await tick();
    const persisted = adapter; // mesmo "banco"
    setState({ ...initialEditorState, history: {} });
    persisted.gated = false;
    await initEditor(persisted, { demo: false });
    expect((await persisted.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['interrompido']);
    expect(getState().elements.map((e) => e.text)).toEqual(['interrompido']);
    expect(readJournals()).toHaveLength(0);
  });

  it('falha de quota no diário não impede a gravação no IndexedDB', async () => {
    (localStorage as unknown as { failWrites: unknown }).failWrites = 'quota';
    addRect('sem diário');
    await flushSave();
    await settle();
    expect((await adapter.loadBoard(boardA.id))!.elements.map((e) => e.text)).toEqual(['sem diário']);
    expect(getState().saveState).toBe('saved');
  });

  it('metadados e elementos alterados juntos são gravados de forma consistente', async () => {
    adapter.gated = true;
    addRect('el');
    const p1 = flushSave();
    await updateBoardMeta(boardA.id, { name: 'Renomeado', description: 'nova' });
    addRect('el2');
    const p2 = flushSave();
    adapter.gated = false;
    await adapter.gates[0].release();
    await Promise.all([p1, p2]);
    await settle();
    const saved = (await adapter.loadBoard(boardA.id))!;
    expect(saved.name).toBe('Renomeado');
    expect(saved.description).toBe('nova');
    expect(saved.elements.map((e) => e.text)).toEqual(['el', 'el2']);
  });

  it('gravações concorrentes de quadros diferentes não se sobrescrevem', async () => {
    addRect('A1');
    await flushSave();
    await openBoard(boardB.id);
    addRect('B1');
    await updateBoardMeta(boardA.id, { description: 'meta de A fora de foco' });
    await flushSave();
    await settle();
    const a = (await adapter.loadBoard(boardA.id))!;
    expect(a.elements.map((e) => e.text)).toEqual(['A1']);
    expect(a.description).toBe('meta de A fora de foco');
    expect((await adapter.loadBoard(boardB.id))!.elements.map((e) => e.text)).toEqual(['B1']);
  });
});

describe('quadros grandes', () => {
  it('exporta e importa 20.000 elementos em tempo razoável e sem perdas', () => {
    const ws = createWorkspace('W');
    const b = createBoard(ws.id, 'Grande');
    b.elements = Array.from({ length: 20000 }, (_, i) => createShape(i % 2 ? 'rectangle' : 'ellipse', (i % 200) * 50, Math.floor(i / 200) * 50, 40, 40));
    const t0 = performance.now();
    const text = buildExport([b], []);
    const r = parseImport(text, 'ws2');
    const ms = performance.now() - t0;
    expect(r.boards[0].elements).toHaveLength(20000);
    expect(r.warnings).toEqual([]);
    expect(ms).toBeLessThan(15000);
  });
});
