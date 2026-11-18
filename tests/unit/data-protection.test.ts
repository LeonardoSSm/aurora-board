/**
 * Proteção de dados existentes: fixtures CONGELADAS do formato atual (esquema 3) e do protótipo v0.3.
 * Se uma mudança de esquema quebrar estes testes, falta uma migração — não regenere as fixtures.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyImport, parseImport } from '../../src/persistence/exportImport';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { createBoard, createWorkspace } from '../../src/core/elements';
import { assetIdsOf } from '../../src/persistence/exportImport';
import type { LinearElement } from '../../src/core/schema';

const v3 = readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8');
const legacy = readFileSync('tests/fixtures/legacy-v03-localstorage.json', 'utf8');

describe('fixture do formato atual (esquema 3)', () => {
  it('importa sem perdas nem avisos', () => {
    const raw = JSON.parse(v3);
    const r = parseImport(v3, 'ws-novo');
    expect(r.source).toBe('aurora');
    expect(r.warnings).toEqual([]);
    expect(r.boards[0].elements).toHaveLength(raw.boards[0].elements.length);
    expect(r.boards[0].elements.map((e) => e.id)).toEqual(raw.boards[0].elements.map((e: { id: string }) => e.id));
    const types = new Set(r.boards[0].elements.map((e) => (e.type === 'widget' ? e.widgetType : e.type)));
    for (const t of ['rectangle', 'ellipse', 'diamond', 'sticky', 'frame', 'text', 'arrow', 'freedraw', 'image', 'aurora.finance', 'aurora.tasks', 'aurora.notes', 'aurora.ai', 'aurora.chart'])
      expect(types).toContain(t);
  });

  it('referências internas são consistentes (vínculos, frames, grupos, assets)', () => {
    const b = parseImport(v3, 'ws').boards[0];
    const ids = new Set(b.elements.map((e) => e.id));
    for (const e of b.elements) {
      if (e.frameId) expect(ids.has(e.frameId)).toBe(true);
      if (e.type === 'arrow' || e.type === 'line') {
        const l = e as LinearElement;
        if (l.startBinding) expect(ids.has(l.startBinding.elementId)).toBe(true);
        if (l.endBinding) expect(ids.has(l.endBinding.elementId)).toBe(true);
      }
    }
    const assets = new Set(parseImport(v3, 'ws').assets.map((a) => a.id));
    for (const a of assetIdsOf(b.elements)) expect(assets.has(a)).toBe(true);
    const grouped = b.elements.filter((e) => e.groupIds.length);
    expect(grouped.length).toBe(2);
    expect(grouped[0].groupIds).toEqual(grouped[1].groupIds);
  });
});

describe('fixture do protótipo v0.3 (localStorage aurora-board-v2-data)', () => {
  it('importa todos os quadros e informa conversões', () => {
    const r = parseImport(legacy, 'ws');
    expect(r.source).toBe('legacy-v0.3');
    expect(r.boards.map((b) => b.name)).toEqual(['Operação Dark (v0.3)', 'Meu espaço (v0.3)']);
    expect(r.boards[0].elements.filter((e) => e.type === 'widget')).toHaveLength(7);
    expect(r.warnings.some((w) => w.includes('Estrutura'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('fluxo'))).toBe(true);
  });
});

describe('importação não destrutiva', () => {
  it('importar o mesmo arquivo duas vezes cria quadros novos e não altera os existentes', async () => {
    const adapter = new MemoryAdapter();
    const ws = createWorkspace('W');
    await adapter.saveWorkspace(ws);
    const mine = createBoard(ws.id, 'Meu quadro');
    await adapter.saveBoard(mine);
    const r1 = parseImport(v3, ws.id);
    let n = 0;
    const first = await applyImport(adapter, r1, { ...ws, boardOrder: [mine.id] }, () => `novo-${++n}`);
    const second = await applyImport(adapter, parseImport(v3, ws.id), first.workspace, () => `novo-${++n}`);
    expect(first.boardIds[0]).toBe(r1.boards[0].id); // id livre → mantido
    expect(second.boardIds[0]).toBe('novo-1'); // id em uso → id novo, nunca sobrescreve
    expect(second.workspace.boardOrder).toEqual([mine.id, first.boardIds[0], 'novo-1']);
    expect(await adapter.loadBoard(mine.id)).toEqual(mine);
    const boards = await adapter.listBoards(ws.id);
    expect(boards).toHaveLength(3);
  });

  it('asset já existente não é substituído pelo do arquivo', async () => {
    const adapter = new MemoryAdapter();
    const original = { id: 'a_fixture_png', mimeType: 'image/png', dataURL: 'data:image/png;base64,ORIGINAL', name: 'meu.png', size: 1, createdAt: 1 };
    await adapter.putAsset(original);
    const ws = createWorkspace('W');
    await applyImport(adapter, parseImport(v3, ws.id), ws, () => 'x');
    expect(await adapter.getAsset('a_fixture_png')).toEqual(original);
  });
});
