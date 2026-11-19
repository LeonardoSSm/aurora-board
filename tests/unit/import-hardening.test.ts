/**
 * Ciclo S1 — endurecimento da importação (S1-SEC-004/005/006/007/008).
 * Cargas sintéticas, sem rede. Os testes de volume usam limites reduzidos para não pesar no ambiente.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyImport, checkImportFileSize, ImportError, parseImport } from '../../src/persistence/exportImport';
import { checkGenericBudget, checkImportBudget, IMPORT_LIMITS, ImportBudgetError, type ImportLimits } from '../../src/persistence/importBudget';
import { isSafeColor, migrateBoard, sanitizeSettings } from '../../src/persistence/migrations';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { IndexedDBAdapter } from '../../src/persistence/indexeddb';
import { createBoard, createShape, createWorkspace } from '../../src/core/elements';
import { exportSVG } from '../../src/render/exportImage';
import { cardLayout } from '../../src/core/financeCard';
import { aiTileLayout, createAITileData } from '../../src/core/aiTiles';

const rect = (i: number) => ({ id: `e${i}`, type: 'rectangle', x: i, y: i, width: 10, height: 10 });
const file = (boards: unknown[], assets: unknown[] = []) => ({ format: 'aurora-board', schemaVersion: 3, exportedAt: 1, app: 'x', boards, assets });
const board = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ id: `b${Math.random()}`, name: 'Q', elements, ...extra });
const small = (p: Partial<ImportLimits>): ImportLimits => ({ ...IMPORT_LIMITS, ...p });
const nested = (depth: number) => { let s = '1'; for (let i = 0; i < depth; i++) s = `[${s}]`; return s; };

describe('S1-SEC-004 — limites antes de ler e antes de validar', () => {
  it('tamanho do arquivo é checado sem ler o conteúdo', () => {
    expect(() => checkImportFileSize(IMPORT_LIMITS.maxFileBytes)).not.toThrow();
    expect(() => checkImportFileSize(IMPORT_LIMITS.maxFileBytes + 1)).toThrow(ImportError);
  });

  it.each([
    ['quadros', small({ maxBoards: 2 }), file([board([]), board([]), board([])]), /quadros/],
    ['elementos por quadro', small({ maxElementsPerBoard: 3 }), file([board([rect(1), rect(2), rect(3), rect(4)])]), /elementos/],
    ['elementos no total', small({ maxTotalElements: 5 }), file([board([rect(1), rect(2), rect(3)]), board([rect(4), rect(5), rect(6)])]), /no total/],
    ['pontos por elemento', small({ maxPointsPerElement: 10 }), file([board([{ id: 'f', type: 'freedraw', points: Array.from({ length: 11 }, () => [0, 0, 0.5]) }])]), /pontos/],
    ['pontos no total', small({ maxTotalPoints: 10 }), file([board([{ id: 'f', type: 'freedraw', points: Array.from({ length: 6 }, () => [0, 0, 0.5]) }, { id: 'g', type: 'line', points: Array.from({ length: 6 }, () => [0, 0]) }])]), /pontos/],
    ['texto por elemento', small({ maxStringChars: 100 }), file([board([{ ...rect(1), text: 'x'.repeat(101) }])]), /texto/],
    ['widgets HTML', small({ maxHtmlWidgets: 1 }), file([board([1, 2].map((i) => ({ id: `w${i}`, type: 'widget', widgetType: 'aurora.sandbox-html', data: { html: '<p>' } })))]), /HTML/],
    ['tamanho do HTML', small({ maxHtmlChars: 10 }), file([board([{ id: 'w', type: 'widget', widgetType: 'aurora.sandbox-html', data: { html: 'x'.repeat(11) } }])]), /HTML/],
    ['nós de dados de widget', small({ maxWidgetNodes: 50 }), file([board([{ id: 'w', type: 'widget', widgetType: 'x.y', data: { a: Array.from({ length: 60 }, (_, i) => i) } }])]), /itens/],
    ['quantidade de assets', small({ maxAssets: 1 }), file([board([])], [{ id: 'a' }, { id: 'b' }]), /arquivos/],
    ['tamanho de asset', small({ maxAssetDataURLChars: 20 }), file([board([])], [{ id: 'a', name: 'grande', dataURL: 'data:image/png;base64,' + 'A'.repeat(40) }]), /25 MB/],
    ['configurações aninhadas', small({}), file([board([], { settings: JSON.parse(`{"x":${nested(60)}}`) })]), /aninhada/],
  ])('recusa: %s', (_n, lim, data, msg) => expect(() => checkImportBudget(data, lim)).toThrow(msg));

  it('quadro grande legítimo (100 000 elementos) continua aceito e rápido', () => {
    const text = JSON.stringify(file([board(Array.from({ length: 100_000 }, (_, i) => rect(i)))]));
    const t = performance.now();
    const r = parseImport(text, 'ws');
    const ms = performance.now() - t;
    expect(r.stats.elements).toBe(100_000);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  it('o orçamento recusa antes da validação completa (custo de 1 000 000 elementos)', () => {
    // 500 quadros × 2 000 elementos: antes, era tudo saneado (≈3 s em Node); agora é recusado na contagem.
    const boards = Array.from({ length: 500 }, () => board(Array.from({ length: 2_000 }, (_, i) => rect(i))));
    const text = JSON.stringify(file(boards));
    const t = performance.now();
    expect(() => parseImport(text, 'ws')).toThrow(/no total/);
    const ms = performance.now() - t;
    // Só o JSON.parse (inevitável) e uma contagem: bem abaixo do saneamento completo.
    expect(ms).toBeLessThan(3_000);
  }, 60_000);
});

describe('S1-SEC-005 — aninhamento profundo', () => {
  const deepFile = (where: 'state' | 'settings') =>
    where === 'state'
      ? `{"format":"aurora-board","schemaVersion":3,"exportedAt":1,"app":"x","boards":[{"id":"b","name":"b","elements":[{"id":"w","type":"widget","widgetType":"aurora.sandbox-html","x":0,"y":0,"width":1,"height":1,"data":{"html":"","state":${nested(100_000)}}}]}],"assets":[]}`
      : `{"format":"aurora-board","schemaVersion":3,"exportedAt":1,"app":"x","boards":[{"id":"b","name":"b","settings":{"grid":${nested(100_000)}},"elements":[]}],"assets":[]}`;

  it('estado de widget com 100 000 níveis é recusado (antes: aceito e quebrava salvamento/exportação)', () => {
    expect(() => parseImport(deepFile('state'), 'ws')).toThrow(/aninhada/);
  });
  it('configurações com 100 000 níveis são recusadas', () => expect(() => parseImport(deepFile('settings'), 'ws')).toThrow(/aninhada|itens/));
  it('formato legado com aninhamento profundo é recusado', () => {
    const legacy = JSON.parse(readFileSync('tests/fixtures/legacy-v03-localstorage.json', 'utf8'));
    legacy.evil = JSON.parse(nested(60));
    expect(() => parseImport(JSON.stringify(legacy), 'ws')).toThrow(/aninhada/);
    expect(() => checkGenericBudget(JSON.parse(nested(40)))).not.toThrow();
  });
  it('a checagem é iterativa (não estoura a pilha mesmo com 1 000 000 de níveis)', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1_000_000; i++) deep = [deep];
    expect(() => checkGenericBudget(deep)).toThrow(ImportBudgetError);
  });
});

describe('S1-SEC-008 — configurações e S1-SEC-007 — cores', () => {
  it('configurações inválidas voltam ao padrão com aviso; desconhecidas são descartadas', () => {
    const w: string[] = [];
    const s = sanitizeSettings({ gridSize: 0, snapToGrid: true, wheelMode: 'turbo', lixo: { a: 1 } }, w);
    expect(s.gridSize).toBe(20);
    expect(s.snapToGrid).toBe(true);
    expect(s.wheelMode).toBe('zoom');
    expect('lixo' in s).toBe(false);
    expect(w.join()).toMatch(/gridSize.*wheelMode/);
  });
  it('quadros antigos sem configurações recebem padrões sem aviso', () => {
    const { board: b, warnings } = migrateBoard({ id: 'b', name: 'x', elements: [] }, 'ws');
    expect(b.settings.gridSize).toBe(20);
    expect(warnings.some((x) => /Configurações/.test(x))).toBe(false);
  });
  it.each(['#fff', '#12ab34', '#12ab34cc', 'transparent', 'red', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120deg 50% 50%)', ''])('cor aceita: %s', (c) => expect(isSafeColor(c)).toBe(true));
  it.each(['red"/><script>', 'url(javascript:x)', 'blue;x:y', '#fff" onload="x', 'a'.repeat(70), 'expression(alert(1))'])('cor recusada: %s', (c) => expect(isSafeColor(c)).toBe(false));
  it('cores manipuladas não chegam ao SVG exportado', async () => {
    const r = createShape('rectangle', 0, 0, 100, 100);
    const { board: b } = migrateBoard({ id: 'b', name: 'b', elements: [{ ...r, style: { ...r.style, fillStyle: 'solid', backgroundColor: 'red"/><script>alert(1)</script><path d="', strokeColor: 'blue" onload="alert(2)' } }] }, 'ws');
    expect(b.elements[0].style.backgroundColor).toBe('transparent');
    // Mesmo que uma cor ruim chegue por outro caminho (ex.: estado em memória), a exportação escapa.
    const raw = { ...b.elements[0], style: { ...b.elements[0].style, backgroundColor: 'red"/><script>alert(1)</script><path d="' } };
    const { svg } = await exportSVG([raw], { background: false });
    expect(svg).not.toContain('<script>');
    expect(svg).not.toMatch(/onload=/);
  });
});

describe('S1-SEC-006 — gravação atômica', () => {
  const v3 = readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8');

  it('falha no meio da gravação não deixa quadros nem assets parciais', async () => {
    const adapter = new MemoryAdapter();
    const ws = createWorkspace('W');
    const mine = createBoard(ws.id, 'Meu quadro');
    await adapter.saveBoard(mine);
    await adapter.saveWorkspace({ ...ws, boardOrder: [mine.id] });
    adapter.failCommitAfter = 0;
    await expect(applyImport(adapter, parseImport(v3, ws.id), { ...ws, boardOrder: [mine.id] }, () => 'novo')).rejects.toThrow(/simulada/);
    expect([...adapter.boards.keys()]).toEqual([mine.id]);
    expect(adapter.assets.size).toBe(0);
    expect((await adapter.listWorkspaces())[0].boardOrder).toEqual([mine.id]);
  });

  it('IndexedDB: um valor não clonável aborta a transação inteira', async () => {
    const adapter = new IndexedDBAdapter(`s1-atomic-${Math.random()}`);
    const ws = createWorkspace('W');
    await adapter.saveWorkspace(ws);
    const ok = createBoard(ws.id, 'ok');
    const bad = { ...createBoard(ws.id, 'ruim'), elements: [{ ...createShape('rectangle', 0, 0, 1, 1), text: (() => 'x') as unknown as string }] };
    await expect(adapter.commitImport({ assets: [{ id: 'a1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', name: 'a', size: 1, createdAt: 1 }], boards: [ok, bad as never], workspace: { ...ws, boardOrder: [ok.id, bad.id] } })).rejects.toThrow();
    expect(await adapter.loadBoard(ok.id)).toBeNull();
    expect(await adapter.getAsset('a1')).toBeNull();
    expect((await adapter.listWorkspaces())[0].boardOrder).toEqual([]);
  });

  it('quadro que não pode ser clonado é recusado antes de qualquer gravação', async () => {
    const adapter = new MemoryAdapter();
    const ws = createWorkspace('W');
    const r = parseImport(v3, ws.id);
    let deep: unknown = 1;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    (r.boards[0].elements as unknown[]).push({ ...createShape('rectangle', 0, 0, 1, 1), extra: deep });
    await expect(applyImport(adapter, r, ws, () => 'novo')).rejects.toThrow(/não pode ser gravado/);
    expect(adapter.boards.size).toBe(0);
    expect(adapter.assets.size).toBe(0);
  });

  it('assets com data URL malformado são descartados com aviso; repetidos mantêm a primeira cópia', () => {
    const data = file([board([{ id: 'i', type: 'image', assetId: 'a1', x: 0, y: 0, width: 1, height: 1 }])], [
      { id: 'a1', mimeType: 'image/png', dataURL: 'javascript:alert(1)', name: 'x', size: 1, createdAt: 1 },
      { id: 'a2', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', name: 'y', size: 1, createdAt: 1 },
      { id: 'a2', mimeType: 'image/png', dataURL: 'data:image/png;base64,BB==', name: 'z', size: 1, createdAt: 1 },
    ]);
    const r = parseImport(JSON.stringify(data), 'ws');
    expect(r.assets.map((a) => a.dataURL)).toEqual(['data:image/png;base64,AA==']);
    expect(r.warnings.join('\n')).toMatch(/inválido descartado[\s\S]*repetido[\s\S]*a1 ausente/);
  });
});

describe('S1-SEC-018 — laços dependentes de dados (achados pelo fuzzing)', () => {
  it.each([-1e15, -1e308, 1e15, 0.5, -3])('schemaVersion %s não trava a migração', (v) => {
    const t = performance.now();
    const { board: b } = migrateBoard({ id: 'b', name: 'x', schemaVersion: v, elements: [rect(1)] }, 'ws');
    expect(b.elements).toHaveLength(1);
    expect(performance.now() - t).toBeLessThan(200);
  });
  it('título gigante em cards é truncado em tempo proporcional à largura', () => {
    const t = performance.now();
    const nodes = cardLayout({ title: 'T'.repeat(2_000_000), value: 'V'.repeat(200_000), valueColor: '#fff', rows: [{ label: 'L'.repeat(100_000), value: '1' }], accent: '#fff' }, 220, 120, 'detailed');
    expect(nodes.length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(1_500);
    const tile = aiTileLayout(createAITileData('claude'), 220, 120, 'X'.repeat(2_000_000));
    expect(tile.length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(3_000);
  });
});

describe('fuzzing controlado da importação', () => {
  /** PRNG determinístico (mulberry32): casos reproduzíveis. */
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const base = JSON.parse(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'));
  const junk = (r: () => number): unknown => {
    const k = Math.floor(r() * 12);
    return [null, -1e308, 1e308, NaN, '', '<script>x</script>', 'x'.repeat(5000), [], {}, { __proto__: { polluted: 1 } }, [[[[[]]]]], true][k];
  };
  function mutate(v: unknown, r: () => number, depth = 0): unknown {
    if (r() < 0.06) return junk(r);
    if (Array.isArray(v)) {
      const out = v.map((x) => mutate(x, r, depth + 1));
      if (r() < 0.05) out.push(junk(r));
      if (r() < 0.05 && out.length) out.splice(Math.floor(r() * out.length), 1);
      if (r() < 0.03 && out.length) out.push(out[0]); // ids duplicados
      return out;
    }
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (r() > 0.03) o[k] = mutate(x, r, depth + 1);
      if (r() < 0.04) o['campoInesperado'] = junk(r);
      return o;
    }
    if (typeof v === 'number' && r() < 0.1) return [0, -0, 1e15, -1e15, 0.5][Math.floor(r() * 5)];
    if (typeof v === 'string' && r() < 0.05) return v + '\u0000￿';
    return v;
  }

  it('600 variações: só ImportError ou sucesso; nada lança outro erro, tudo dentro do tempo', () => {
    const r = rng(20261119);
    let ok = 0, refused = 0, slowest = 0;
    for (let i = 0; i < 600; i++) {
      const variant = mutate(base, r);
      const text = i % 50 === 0 ? JSON.stringify(variant).slice(0, Math.floor(r() * 2000)) : JSON.stringify(variant); // JSON truncado
      const t = performance.now();
      try {
        const res = parseImport(text, 'ws');
        for (const b of res.boards) structuredClone(b); // o resultado precisa ser gravável
        ok++;
      } catch (e) {
        expect(e, `caso ${i}: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`).toBeInstanceOf(ImportError);
        refused++;
      }
      slowest = Math.max(slowest, performance.now() - t);
    }
    expect(ok + refused).toBe(600);
    expect(ok).toBeGreaterThan(50); // a maioria das mutações leves continua importável (compatibilidade)
    expect(slowest).toBeLessThan(2_000);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
