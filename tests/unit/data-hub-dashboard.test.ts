/**
 * Issue #24 — Data Hub, D2-B: agregação nativa (`groups`), exemplo de dashboard HTML e “Criar painel HTML
 * conectado”. Dados SINTÉTICOS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import type { LinearElement, WidgetElement } from '../../src/core/schema';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { setAdapter } from '../../src/persistence/autosave';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { getDataflow } from '../../src/widgets/dataflow';
import { BRIDGE_LIMITS, buildInputSnapshot, sanitizeBridge } from '../../src/core/htmlBridge';
import { contextSources } from '../../src/integrations/aiContext';
import { validateContent } from '../../src/data/model';
import { parseDatasetText } from '../../src/data/parse';
import { AGGREGATE_LIMITS, aggregateDataset } from '../../src/data/aggregate';
import { resetDatasetCacheForTests, saveDataset } from '../../src/data/store';
import { buildConnectedDashboard, DASHBOARD_LINKS } from '../../src/widgets/builtin/datasetDashboard';
import { BRIDGE_EXAMPLES, DATASET_DASHBOARD_BRIDGE, DATASET_DASHBOARD_HTML } from '../../src/widgets/builtin/sandboxExamples';

beforeAll(() => registerBuiltinWidgets());
beforeEach(() => {
  resetDatasetCacheForTests();
  setAdapter(new MemoryAdapter());
  setState({ ...initialEditorState, boardId: 'b1', status: 'ready', elements: [], htmlAiGrants: [] });
});

const SALES = 'produto,região,valor\nCafé,Sul,10\nPão,Norte,3\nBolo,Sul,7\nSuco,,5\nChá,Norte,x\n';
const content = () => parseDatasetText('v.csv', SALES).content;

async function datasetEl(view: Record<string, unknown> = {}) {
  const c = content();
  const assetId = await saveDataset(c, 'vendas.csv');
  return createWidget(WIDGET.dataset, '1.0.0', 'Vendas', 0, 0, 440, 300, {
    source: { assetId, name: 'vendas', kind: 'csv', rows: c.rows.length, columns: c.columns.length, bytes: 10, importedAt: 1 },
    view: { page: 0, pageSize: 100, columns: [], groupBy: '', measure: '', ...view },
  }) as WidgetElement;
}

describe('agregação nativa (conjunto inteiro)', () => {
  it('conta, soma, média, mínimo e máximo por grupo; vazios agrupados; não numéricos fora da soma', () => {
    // “x” na coluna valor deixa a coluna como texto: a medida precisa ser numérica para somar.
    const c = parseDatasetText('v.csv', 'produto,região,valor\nCafé,Sul,10\nPão,Norte,3\nBolo,Sul,7\nSuco,,5\n').content;
    const g = aggregateDataset(c, 'região', 'valor')!;
    expect(g.groupBy).toEqual({ id: 'região', label: 'região' });
    expect(g.measure).toEqual({ id: 'valor', label: 'valor' });
    expect(g.groups).toEqual([
      { group: 'Sul', count: 2, valid: 2, sum: 17, mean: 8.5, min: 7, max: 10 },
      { group: null, count: 1, valid: 1, sum: 5, mean: 5, min: 5, max: 5 },
      { group: 'Norte', count: 1, valid: 1, sum: 3, mean: 3, min: 3, max: 3 },
    ]);
    expect(g).toMatchObject({ groupCount: 3, rowCount: 4, truncated: false });
    const mixed = aggregateDataset(content(), 'região', 'valor')!;
    expect(mixed.groups.find((x) => x.group === 'Norte')).toMatchObject({ count: 2, valid: 0, sum: 0, mean: null });
  });

  it('sem medida ordena pela contagem; coluna inexistente → null', () => {
    const g = aggregateDataset(content(), 'região', '')!;
    expect(g.measure).toBeNull();
    expect(g.groups.map((x) => [x.group, x.count])).toEqual([['Norte', 2], ['Sul', 2], [null, 1]]);
    expect(aggregateDataset(content(), 'nao_existe', '')).toBeNull();
  });

  it('muitos grupos e rótulos longos: limitado a 500 grupos e ao limite por saída, com aviso', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [`${'g'.repeat(180)}${i}`, i]);
    const c = validateContent({ format: 'aurora-dataset', version: 1, columns: [{ label: 'grupo', type: 'text' }, { label: 'n', type: 'number' }], rows });
    const g = aggregateDataset(c, 'grupo', 'n')!;
    expect(g.groupCount).toBe(5000);
    expect(g.truncated).toBe(true);
    expect(g.groups.length).toBeLessThanOrEqual(AGGREGATE_LIMITS.maxGroups);
    expect(JSON.stringify(g).length).toBeLessThanOrEqual(BRIDGE_LIMITS.maxValueChars);
    expect(g.groups[0].sum).toBe(4999); // os maiores ficam
  });

  it('saída `groups` do bloco só existe com agrupamento configurado', async () => {
    const off = await datasetEl();
    const on = await datasetEl({ groupBy: 'região', measure: '' });
    setState({ elements: [off, on] });
    const flow = getDataflow(getState().elements);
    expect(flow.outputs.get(off.id)?.groups).toBeUndefined();
    expect((flow.outputs.get(on.id)?.groups as { groupCount: number }).groupCount).toBe(3);
  });
});

describe('exemplo de dashboard HTML', () => {
  it('não usa HTML a partir de dados, rede, armazenamento, avaliação de código nem recursos externos', () => {
    const src = DATASET_DASHBOARD_HTML;
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /indexedDB/, /localStorage/, /sessionStorage/, /\beval\s*\(/, /new Function/, /import\s*\(/, /<link\b/, /src\s*=/, /url\(/]) {
      expect(src, String(bad)).not.toMatch(bad);
    }
    // Única URL: o namespace do SVG (não é uma requisição).
    expect([...src.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0])).toEqual(['http://www.w3.org/2000/svg']);
    // O estado guarda só preferências (medida/filtro), nunca linhas.
    expect(src).toMatch(/aurora\.setState\(\{ medida: pref\.medida, coluna: pref\.coluna, valor: pref\.valor \}\)/);
  });

  it('portas válidas e iguais às do exemplo na biblioteca', () => {
    expect(sanitizeBridge(DATASET_DASHBOARD_BRIDGE)).toEqual(DATASET_DASHBOARD_BRIDGE);
    expect(BRIDGE_EXAMPLES[0]).toMatchObject({ id: 'dataset-dashboard', html: DATASET_DASHBOARD_HTML });
    for (const id of ['total', 'media', 'filtradas', 'porGrupo', 'resumo']) expect(DATASET_DASHBOARD_BRIDGE.outputs.some((o) => o.id === id)).toBe(true);
  });
});

describe('“Criar painel HTML conectado”', () => {
  it('cria o bloco HTML com o exemplo e as quatro conexões tipadas, todas válidas no fluxo de dados', async () => {
    const ds = await datasetEl({ groupBy: 'região', measure: '' });
    const [html, ...edges] = buildConnectedDashboard(ds) as [WidgetElement, ...LinearElement[]];
    expect(html.widgetType).toBe(WIDGET.sandbox);
    expect((html.data as { html: string }).html).toBe(DATASET_DASHBOARD_HTML);
    expect(html.x).toBeGreaterThan(ds.x + ds.width);
    expect(edges.map((e) => [e.connection.kind, e.connection.sourcePort, e.connection.targetPort, e.startBinding?.elementId, e.endBinding?.elementId])).toEqual(
      DASHBOARD_LINKS.map(([from, to]) => ['data', from, to, ds.id, html.id]),
    );
    setState({ elements: [ds, html, ...edges] });
    const flow = getDataflow(getState().elements);
    for (const e of edges) expect(flow.edges.get(e.id)?.status, e.connection.sourcePort).toBe('ok');
    const ins = flow.inputs.get(html.id)!;
    // O que chega ao iframe cabe nos limites e traz o agrupamento do conjunto inteiro.
    const snap = buildInputSnapshot(DATASET_DASHBOARD_BRIDGE.inputs, ins);
    expect(snap.errors).toEqual({});
    expect((snap.inputs.linhas as unknown[]).length).toBe(5);
    expect((snap.inputs.grupos as { groupCount: number }).groupCount).toBe(3);
    expect((snap.inputs.colunas as { id: string }[]).map((c) => c.id)).toEqual(['produto', 'região', 'valor']);
  });

  it('privacidade: o painel derivado de dados importados não vai para a IA (proteção transitiva)', async () => {
    const ds = await datasetEl();
    const els = buildConnectedDashboard(ds);
    const html = els[0] as WidgetElement;
    // Mesmo com o HTML pedindo “saídas para a IA”, a origem protegida bloqueia.
    (html.data as { bridge: { ai: unknown } }).bridge.ai = { mode: 'outputs', outputs: ['total'], confirmedDigest: '', confirmedAt: 0 };
    const ai = createWidget(WIDGET.ai, '1.0.0', 'Assistente', 1400, 0, 380, 460, { provider: 'anthropic' }) as WidgetElement;
    const link = { ...(els[1] as LinearElement), id: 'ctx', connection: { kind: 'context' as const, relation: '' }, startBinding: { elementId: html.id, fixedPoint: null }, endBinding: { elementId: ai.id, fixedPoint: null } } as LinearElement;
    const elements = [ds, ...els, ai, link];
    setState({ elements });
    const src = contextSources(elements, ai.id, {});
    expect(src).toHaveLength(1);
    expect(src[0].includable).toBe(false);
  });
});
