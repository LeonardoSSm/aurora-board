import { beforeAll, describe, expect, it } from 'vitest';
import { createLinear, createWidget, uid } from '../../src/core/elements';
import { computeDataflow } from '../../src/core/dataflow';
import { WIDGET } from '../../src/core/widgetIds';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { dataflowSpec } from '../../src/widgets/registry';
import type { AuroraElement, LinkKind } from '../../src/core/schema';
import type { FinanceSummary } from '../../src/core/finance';
import { buildContextText, contextSources, parseProposal } from '../../src/integrations/aiContext';

beforeAll(() => registerBuiltinWidgets());

function link(a: AuroraElement, b: AuroraElement, kind: LinkKind = 'data') {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, kind);
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  return l;
}

const fin = (title: string, entries: { kind: 'income' | 'expense'; cents: number }[]) =>
  createWidget(WIDGET.finance, '1.0.0', title, 0, 0, 300, 300, {
    currency: 'BRL',
    entries: entries.map((e) => ({ id: uid(), description: title, amountCents: e.cents, kind: e.kind, category: 'c', date: '', paid: false, installments: 1, installmentMode: 'split' })),
  });

describe('fluxo de dados entre widgets', () => {
  it('salário → despesas → gráfico propaga saldo e lançamentos', () => {
    const salary = fin('Salário', [{ kind: 'income', cents: 500000 }]);
    const expenses = fin('Despesas', [{ kind: 'expense', cents: 120000 }]);
    const chart = createWidget(WIDGET.chart, '1.0.0', 'Gráfico', 0, 0, 300, 300, {});
    const e1 = link(salary, expenses), e2 = link(expenses, chart);
    const r = computeDataflow([salary, expenses, chart, e1, e2], dataflowSpec);
    expect(r.edges.get(e1.id)?.status).toBe('ok');
    expect(r.edges.get(e2.id)?.toPort?.id).toBe('ledger');
    const sum = r.outputs.get(expenses.id)!.summary as FinanceSummary;
    expect(sum.balanceCents).toBe(380000);
    expect(r.inputs.get(chart.id)!.ledger).toHaveLength(1);
  });

  it('tipos incompatíveis são rejeitados com mensagem', () => {
    const notes = createWidget(WIDGET.notes, '1.0.0', 'Notas', 0, 0, 10, 10, {});
    const finance = fin('F', []);
    const e = link(notes, finance);
    const r = computeDataflow([notes, finance, e], dataflowSpec);
    expect(r.edges.get(e.id)?.status).toBe('incompatible');
  });

  it('ciclos são detectados e desativados (sem laço infinito)', () => {
    const a = fin('A', [{ kind: 'income', cents: 100 }]);
    const b = fin('B', []);
    const e1 = link(a, b), e2 = link(b, a);
    const r = computeDataflow([a, b, e1, e2], dataflowSpec);
    expect(r.edges.get(e1.id)?.status).toBe('cycle');
    expect(r.edges.get(e2.id)?.status).toBe('cycle');
  });

  it('conexões visuais e de contexto não transmitem dados', () => {
    const a = fin('A', [{ kind: 'income', cents: 100 }]);
    const b = fin('B', []);
    const r = computeDataflow([a, b, link(a, b, 'visual'), link(a, b, 'context')], dataflowSpec);
    expect(r.inputs.get(b.id)).toBeUndefined();
  });

  it('conexão de dados com ponta solta é sinalizada', () => {
    const a = fin('A', []);
    const l = createLinear('arrow', 0, 0, [[0, 0], [5, 5]], {}, 'data');
    l.startBinding = { elementId: a.id, fixedPoint: null };
    const r = computeDataflow([a, l], dataflowSpec);
    expect(r.edges.get(l.id)?.status).toBe('unbound');
  });
});

describe('contexto de IA', () => {
  it('envia somente fontes conectadas por contexto e autorizadas', () => {
    const ai = createWidget(WIDGET.ai, '1.0.0', 'IA', 0, 0, 10, 10, {});
    const secret = createWidget(WIDGET.notes, '1.0.0', 'Segredo', 0, 0, 10, 10, { markdown: 'SENHA-NAO-ENVIAR' });
    const visible = createWidget(WIDGET.notes, '1.0.0', 'Plano', 0, 0, 10, 10, { markdown: 'Plano do projeto' });
    const unauthorized = createWidget(WIDGET.notes, '1.0.0', 'Rascunho', 0, 0, 10, 10, { markdown: 'RASCUNHO-PRIVADO' });
    const unrelated = createWidget(WIDGET.notes, '1.0.0', 'Solta', 0, 0, 10, 10, { markdown: 'SOLTA' });
    const els = [ai, secret, visible, unauthorized, unrelated, link(secret, ai, 'visual'), link(visible, ai, 'context'), link(unauthorized, ai, 'context')];
    const sources = contextSources(els, ai.id, { [unauthorized.id]: false });
    const text = buildContextText(els, sources);
    expect(text).toContain('Plano do projeto');
    expect(text).not.toContain('SENHA-NAO-ENVIAR');
    expect(text).not.toContain('RASCUNHO-PRIVADO');
    expect(text).not.toContain('SOLTA');
    expect(sources.find((s) => s.id === secret.id)?.includable).toBe(false);
  });

  it('proposta estruturada valida ids de conexões', () => {
    const p = parseProposal('ok\n```json\n{"notes":[{"title":"A","content":"x"}],"tasks":[{"text":"t","priority":"high"}],"connections":[{"from":"a","to":"b"},{"from":"a","to":"zzz"}]}\n```', new Set(['a', 'b']));
    expect(p?.notes).toHaveLength(1);
    expect(p?.tasks[0].priority).toBe('high');
    expect(p?.connections).toHaveLength(1);
    expect(parseProposal('sem json', new Set())).toBeNull();
    expect(parseProposal('```json\n{inválido\n```', new Set())).toBeNull();
  });
});
