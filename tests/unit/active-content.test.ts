/** Ciclo S1 — política de conteúdo ativo importado (S1-SEC-003). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockActiveContent, sanitizeSandbox } from '../../src/core/widgetData';
import { parseImport } from '../../src/persistence/exportImport';

const sb = (data: unknown) => ({ id: 'w', type: 'widget', widgetType: 'aurora.sandbox-html', x: 0, y: 0, width: 10, height: 10, data });
const file = (els: unknown[]) => JSON.stringify({ format: 'aurora-board', schemaVersion: 3, exportedAt: 1, app: 'x', boards: [{ id: 'b', name: 'b', elements: els }], assets: [] });

describe('ativação de HTML personalizado', () => {
  it('importar sempre desativa, mesmo se o arquivo diz "allowed"', () => {
    const r = parseImport(file([sb({ html: '<b>x</b>', activation: { state: 'allowed', source: 'import', at: 1 } }), sb({ html: '<i>y</i>' })]), 'ws');
    expect(r.stats.activeContent).toBe(2);
    for (const el of r.boards[0].elements) expect(sanitizeSandbox((el as { data: unknown }).data).activation?.state).toBe('blocked');
  });
  it('outros widgets não são tocados', () => {
    const r = parseImport(file([{ id: 'n', type: 'widget', widgetType: 'aurora.notes', x: 0, y: 0, width: 1, height: 1, data: { markdown: 'a', activation: 'x' } }]), 'ws');
    expect(r.stats.activeContent).toBe(0);
    expect((r.boards[0].elements[0] as { data: { activation: unknown } }).data.activation).toBe('x');
  });
  it('fixture v3 antiga continua importável', () => {
    const r = parseImport(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'), 'ws');
    expect(r.boards.length).toBeGreaterThan(0);
  });
  it('sanitizeSandbox: sem marcação = conteúdo local; marcação inválida descartada', () => {
    expect(sanitizeSandbox({ html: 'a' }).activation).toBeUndefined();
    expect(sanitizeSandbox({ html: 'a', activation: { state: 'qualquer' } }).activation).toBeUndefined();
    expect(sanitizeSandbox({ html: 'a', activation: { state: 'blocked', source: 'paste', at: 5 } }).activation).toEqual({ state: 'blocked', source: 'paste', at: 5 });
  });
  it('blockActiveContent marca só widgets HTML', () => {
    const els = [sb({ html: '' }), { type: 'rectangle' }, { type: 'widget', widgetType: 'aurora.notes', data: {} }];
    expect(blockActiveContent(els, 'paste')).toBe(1);
    expect((els[0].data as { activation: { source: string } }).activation.source).toBe('paste');
  });
});
