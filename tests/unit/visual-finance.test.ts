/** Finanças visuais: decimal, valores, meses, fórmulas, portas, fluxo reativo, compatibilidade e persistência. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { decToString, divRound, formatDec, normalizeLocaleNumber, parseDec, ONE } from '../../src/core/decimal';
import { createValueData, parseTextToValue, parseValueInput, sanitizeValue, valueOutput } from '../../src/core/valueTile';
import { computePeriod, sanitizePeriod, type OccurrenceSet } from '../../src/core/financePeriod';
import { evaluateFormula, parseFormula, type FormulaVariable } from '../../src/core/formula';
import { formatScalar, moneyValue, numberValue, percentValue, readScalar, slugVariable } from '../../src/core/scalar';
import { computeDataflow, finalizeDataEdges, findPortPair, suggestPorts } from '../../src/core/dataflow';
import { expandEntry, type FinanceEntry } from '../../src/core/finance';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { dataflowSpec, getWidget } from '../../src/widgets/registry';
import { WIDGET } from '../../src/core/widgetIds';
import { cloneElements, createBoard, createLinear, createShape, createText, createWidget, createWorkspace } from '../../src/core/elements';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addElements, convertTextToValue, deleteSelected, redo, setSelection, undo, updateElements } from '../../src/store/actions';
import { applyImport, buildExport, parseImport } from '../../src/persistence/exportImport';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { migrateBoard } from '../../src/persistence/migrations';
import { renameVariable } from '../../src/widgets/builtin/formula';
import { buildSeries } from '../../src/widgets/builtin/chart';
import type { AuroraElement, LinearElement, WidgetElement } from '../../src/core/schema';

registerBuiltinWidgets();

const money = (reais: string, currency: 'BRL' | 'USD' | 'EUR' = 'BRL', role?: 'income' | 'expense' | 'neutral') => moneyValue(Math.round(Number(reais) * 100), currency, role ? { role } : {});
const v = (name: string, value: unknown): FormulaVariable => ({ name, value, source: name, edgeId: `e_${name}` });
const ok = (expr: string, vars: FormulaVariable[] = []) => {
  const r = evaluateFormula(expr, vars);
  if (!r.ok) throw new Error(`esperava sucesso: ${expr} → ${r.error.message}`);
  return r.value;
};
const err = (expr: string, vars: FormulaVariable[] = []) => {
  const r = evaluateFormula(expr, vars);
  if (r.ok) throw new Error(`esperava erro: ${expr}`);
  return r.error;
};

function link(a: AuroraElement, b: AuroraElement, conn: Partial<LinearElement['connection']> = {}): LinearElement {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  l.connection = { ...l.connection, ...conn };
  return l;
}
const value = (title: string, reais: number, role: 'income' | 'expense' | 'neutral', extra: Record<string, unknown> = {}) =>
  createWidget(WIDGET.value, '1.0.0', title, 0, 0, 176, 76, createValueData({ amountCents: Math.round(reais * 100), financialRole: role, ...extra }));
const month = (period: string, extra: Record<string, unknown> = {}) => createWidget(WIDGET.financePeriod, '1.0.0', period, 0, 0, 220, 150, { period, currency: 'BRL', ...extra });
const formula = (expression: string, title = 'F') => createWidget(WIDGET.formula, '1.0.0', title, 0, 0, 210, 96, { expression });

describe('1–5. decimal, valores e precisão', () => {
  it('soma e multiplicação exatas (sem erro de ponto flutuante)', () => {
    expect(decToString(parseDec('0.1')! + parseDec('0.2')!)).toBe('0.3');
    expect(formatScalar(ok('=0.1 + 0.2'))).toBe('0,3');
    expect(formatScalar(ok('=salario * 0.2', [v('salario', money('3000'))]))).toBe(formatScalar(money('600')));
  });
  it('arredondamento meio-para-longe-do-zero e explícito em centavos', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    // R$ 10,00 / 3 = 3,333… → 3,33; R$ 0,05 * 0.5 = 0,025 → 0,03
    expect((ok('=a / 3', [v('a', money('10'))]) as { cents: number }).cents).toBe(333);
    expect((ok('=a * 0.5', [v('a', money('0.05'))]) as { cents: number }).cents).toBe(3);
  });
  it('números inválidos, NaN, infinito e fora dos limites são rejeitados', () => {
    expect(parseDec('abc')).toBeNull();
    expect(parseDec('1e5')).toBeNull();
    expect(parseDec('99999999999999999')).toBeNull();
    expect(readScalar(NaN)).toBeNull();
    expect(readScalar(Infinity)).toBeNull();
    expect(readScalar({ t: 'money', cents: 1.5, currency: 'BRL' })).toBeNull();
    expect(readScalar({ t: 'money', cents: 10, currency: 'JPY' })).toBeNull();
    expect(parseValueInput('1e999', { valueType: 'money', financialRole: 'neutral' }).ok).toBe(false);
    expect(parseValueInput('99.999.999.999.999.999,00', { valueType: 'money', financialRole: 'neutral' }).ok).toBe(false);
  });
  it('dinheiro, número e porcentagem com formato pt-BR', () => {
    expect(parseValueInput('1.500,00', { valueType: 'money', financialRole: 'income' })).toEqual({ ok: true, patch: { amountCents: 150000 } });
    expect(parseValueInput('1.500', { valueType: 'money', financialRole: 'income' })).toEqual({ ok: true, patch: { amountCents: 150000 } });
    expect(parseValueInput('12,5', { valueType: 'number', financialRole: 'neutral' })).toEqual({ ok: true, patch: { numericValue: '12.5' } });
    expect(parseValueInput('15%', { valueType: 'percentage', financialRole: 'neutral' })).toEqual({ ok: true, patch: { numericValue: '15' } });
    expect(parseValueInput('-500', { valueType: 'money', financialRole: 'expense' }).ok).toBe(false);
    expect(normalizeLocaleNumber('1.234.567,89')).toBe('1234567.89');
    expect(normalizeLocaleNumber('1,2,3')).toBeNull();
    expect(formatDec(parseDec('1234567.5')!, 2, 2)).toBe('1.234.567,50');
  });
  it('despesa é positiva com papel “despesa” (sem subtração dupla)', () => {
    const d = sanitizeValue({ amountCents: -500, financialRole: 'expense' });
    expect(d.amountCents).toBe(500);
    const out = valueOutput(createValueData({ amountCents: 50000, financialRole: 'expense' }), { key: 'k', label: 'Aluguel' });
    expect(out).toMatchObject({ t: 'money', cents: 50000, role: 'expense' });
    expect(valueOutput(createValueData({ valueType: 'percentage', numericValue: '20' }), { key: 'k', label: 'r' })).toEqual({ t: 'percent', v: '0.2' });
  });
  it('sanitização de dados importados', () => {
    const d = sanitizeValue({ valueType: 'x', currency: 'JPY', amountCents: 'mil', numericValue: 'NaN', period: '2027-13', displayMode: 'gigante', accentColor: 'red' });
    expect(d).toMatchObject({ valueType: 'money', currency: 'BRL', amountCents: 0, numericValue: '0', period: '', displayMode: 'normal', accentColor: '' });
  });
});

describe('6. conversão explícita de texto em valor', () => {
  it.each([
    ['1500', { valueType: 'money', amountCents: 150000 }, ''],
    ['Salário: R$ 3.000,00', { valueType: 'money', amountCents: 300000 }, 'Salário'],
    ['Reserva 20%', { valueType: 'percentage', numericValue: '20' }, 'Reserva'],
    ['US$ 10,50 hotel', { valueType: 'money', currency: 'USD', amountCents: 1050 }, 'hotel'],
  ])('%s', (text, data, label) => {
    const r = parseTextToValue(text)!;
    expect(r.label).toBe(label);
    expect(r.data).toMatchObject(data);
  });
  it('não adivinha: sem número ou com vários números → null', () => {
    expect(parseTextToValue('reunião amanhã')).toBeNull();
    expect(parseTextToValue('Janeiro 2027 custou 300')).toBeNull();
  });
});

describe('7–11. fórmulas', () => {
  const vars = [v('receitas', money('3000', 'BRL', 'income')), v('despesas', money('1512', 'BRL', 'expense')), v('salario', money('3000')), v('bonus', money('500')), v('janeiro', money('1488')), v('fevereiro', money('1200')), v('marco', money('900')), v('reserva', percentValue(parseDec('0.2')!)), v('qtd', numberValue(parseDec('4')!))];
  it.each([
    ['=receitas - despesas', 'R$ 1.488,00'],
    ['=salario * 0.20', 'R$ 600,00'],
    ['=salario * reserva', 'R$ 600,00'],
    ['=salario * 20%', 'R$ 600,00'],
    ['=janeiro + fevereiro', 'R$ 2.688,00'],
    ['=SOMA(salario, bonus)', 'R$ 3.500,00'],
    ['=soma(salario; bonus)', 'R$ 3.500,00'],
    ['=MEDIA(janeiro, fevereiro, marco)', 'R$ 1.196,00'],
    ['=MÉDIA(janeiro, fevereiro, marco)', 'R$ 1.196,00'],
    ['=MAXIMO(janeiro, fevereiro)', 'R$ 1.488,00'],
    ['=MINIMO(janeiro, fevereiro, marco)', 'R$ 900,00'],
    ['=ABS(fevereiro - janeiro)', 'R$ 288,00'],
    ['=(despesas / receitas) * 100', '50,4'],
    ['=despesas / receitas', '0,504'],
    ['=ARRED(10 / 3, 2)', '3,33'],
    ['=-(2 + 3) * 4', '-20'],
    ['=qtd * 2.5 + 1', '11'],
    ['=50% + 10%', '60%'],
    ['=salario + 100', 'R$ 3.100,00'],
    ['  = RECEITAS - Despesas ', 'R$ 1.488,00'],
  ])('%s = %s', (expr, out) => {
    expect(formatScalar(ok(expr, vars)).replace(/ /g, ' ')).toBe(out);
  });
  it.each([
    ['=', 'empty'],
    ['=salario +', 'syntax'],
    ['=(salario', 'syntax'],
    ['=salario $ 2', 'syntax'],
    ['=1,5', 'syntax'],
    ['=desconhecido * 2', 'unknown-variable'],
    ['=FOO(1)', 'unknown-function'],
    ['=salario / 0', 'div-zero'],
    ['=salario * salario', 'type'],
    ['=salario + reserva', 'type'],
    ['=ABS(1, 2)', 'args'],
    ['=SOMA()', 'args'],
    ['=salario%', 'type'],
  ])('erro: %s → %s', (expr, code) => {
    expect(err(expr, vars).code).toBe(code);
  });
  it('9. divisão por zero não propaga NaN/Infinity', () => {
    const r = evaluateFormula('=a / (b - b)', [v('a', 10), v('b', 5)]);
    expect(r.ok).toBe(false);
  });
  it('10. moedas incompatíveis nunca são somadas', () => {
    expect(err('=a + b', [v('a', money('10', 'BRL')), v('b', money('10', 'USD'))]).code).toBe('currency');
    expect(err('=SOMA(a, b)', [v('a', money('10', 'EUR')), v('b', money('10', 'BRL'))]).code).toBe('currency');
    expect(err('=a / b', [v('a', money('10', 'EUR')), v('b', money('10', 'BRL'))]).code).toBe('currency');
  });
  it('segurança: nada de JavaScript, limites de tamanho e profundidade', () => {
    for (const e of ['=constructor', '=globalThis', '=alert(1)', '=process.exit(1)', '=a[0]', '="x"', '=`x`', '={}', '=a=1']) expect(evaluateFormula(e, []).ok).toBe(false);
    expect(err('=' + '1+'.repeat(600) + '1').code).toBe('limit');
    expect(err('=' + '('.repeat(60) + '1' + ')'.repeat(60)).code).toBe('limit');
    expect(() => parseFormula('=' + '-'.repeat(100) + '1')).toThrow();
  });
  it('11. referência ausente fica visível como erro', () => {
    const e = err('=saldo_marco * 2');
    expect(e.code).toBe('unknown-variable');
    expect(e.message).toContain('saldo_marco');
  });
  it('nomes estáveis a partir do título', () => {
    expect(slugVariable('Saldo de Março 2027')).toBe('saldo_de_marco_2027');
    expect(slugVariable('2027')).toBe('v_2027');
    expect(slugVariable('***')).toBe('valor');
  });
});

describe('17–19. meses, parcelas e duplicidade', () => {
  const inp = (value: unknown, edgeId: string, sourceTitle = edgeId) => ({ value, edgeId, sourceId: edgeId, sourceTitle });
  const d = sanitizePeriod({ period: '2027-01', currency: 'BRL' });
  it('exemplo do enunciado: receitas, despesas, saldo, comprometimento', () => {
    const r = computePeriod(d, [
      inp(moneyValue(300000, 'BRL', { role: 'income', key: 'sal' }), 'e1'),
      inp(moneyValue(71200, 'BRL', { role: 'expense', key: 'fin' }), 'e2'),
      inp(moneyValue(50000, 'BRL', { role: 'expense', key: 'ali', category: 'Mercado' }), 'e3'),
      inp(moneyValue(30000, 'BRL', { role: 'expense', key: 'out' }), 'e4'),
    ], 'Janeiro');
    expect(r.summary).toMatchObject({ incomeCents: 300000, expenseCents: 151200, balanceCents: 148800, commitment: '0.504', count: 4 });
    expect(r.summary.byCategory.find((c) => c.category === 'Mercado')?.expenseCents).toBe(50000);
  });
  it('sem receitas: comprometimento indefinido (não é 0% nem Infinity)', () => {
    const r = computePeriod(d, [inp(moneyValue(1000, 'BRL', { role: 'expense', key: 'x' }), 'e1')], 'J');
    expect(r.summary.commitment).toBeNull();
    expect(computePeriod(d, [], 'J').summary).toMatchObject({ incomeCents: 0, expenseCents: 0, balanceCents: 0, commitment: null });
  });
  it('mesmo lançamento duas vezes conta uma vez, com aviso', () => {
    const val = moneyValue(1000, 'BRL', { role: 'expense', key: 'mesmo' });
    const r = computePeriod(d, [inp(val, 'e1'), inp(val, 'e2')], 'J');
    expect(r.summary.expenseCents).toBe(1000);
    expect(r.issues).toEqual([expect.objectContaining({ edgeId: 'e2', status: 'duplicate' })]);
  });
  it('moeda diferente e competência diferente são sinalizadas sem alterar dados', () => {
    const r = computePeriod(d, [inp(moneyValue(1000, 'USD', { role: 'income', key: 'a' }), 'e1'), inp(moneyValue(500, 'BRL', { role: 'income', key: 'b', period: '2027-02' }), 'e2'), inp(numberValue(5n * ONE), 'e3')], 'J');
    expect(r.summary.incomeCents).toBe(0);
    expect(r.issues.map((i) => i.status)).toEqual(['currency', 'period', 'incompatible']);
  });
  it('neutros não entram no saldo', () => {
    const r = computePeriod(d, [inp(moneyValue(1000, 'BRL', { role: 'neutral', key: 'n' }), 'e1')], 'J');
    expect(r.summary).toMatchObject({ balanceCents: 0, neutralCents: 1000 });
  });
  it('parcelas do Finanças caem na competência certa, centavos distribuídos', () => {
    const entry: FinanceEntry = { id: 'tv', description: 'TV', amountCents: 100000, kind: 'expense', category: 'Casa', date: '2027-01-31', paid: false, installments: 3, installmentMode: 'split' };
    const set: OccurrenceSet = { t: 'occurrences', sourceId: 'fin', source: 'Finanças', currency: 'BRL', items: expandEntry(entry) };
    const totals = ['2027-01', '2027-02', '2027-03', '2027-04'].map((p) => computePeriod(sanitizePeriod({ period: p }), [inp(set, 'e1')], p).summary.expenseCents);
    expect(totals).toEqual([33334, 33333, 33333, 0]);
    expect(expandEntry(entry).map((o) => o.date)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    // A mesma ocorrência chegando por duas conexões não duplica.
    const dup = computePeriod(sanitizePeriod({ period: '2027-01' }), [inp(set, 'e1'), inp(set, 'e2')], 'J');
    expect(dup.summary.expenseCents).toBe(33334);
    expect(dup.issues[0].status).toBe('duplicate');
  });
});

describe('13–16. portas, conexões legadas, ciclos e fluxo reativo', () => {
  it('14. conexões antigas (sem portas) resolvem como antes', () => {
    const fin = createWidget(WIDGET.finance, '1.0.0', 'Fin', 0, 0, 300, 300, {});
    const fin2 = createWidget(WIDGET.finance, '1.0.0', 'Fin2', 0, 0, 300, 300, {});
    const chart = createWidget(WIDGET.chart, '1.0.0', 'G', 0, 0, 300, 300, {});
    const ai = createWidget(WIDGET.ai, '1.0.0', 'IA', 0, 0, 300, 300, {});
    const r = computeDataflow([fin, fin2, chart, ai, link(fin, chart), link(fin, fin2), link(fin, ai)], dataflowSpec);
    expect([...r.edges.values()].map((e) => [e.fromPort?.id, e.toPort?.id, e.explicit])).toEqual([
      ['ledger', 'ledger', false],
      ['summary', 'in', false],
      ['summary', 'context', false],
    ]);
  });
  it('fixture congelada: fluxo do formato atual inalterado', () => {
    const b = parseImport(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'), 'ws').boards[0];
    const r = computeDataflow(b.elements, dataflowSpec);
    const statuses = [...r.edges.values()].map((e) => e.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'ok')).toBe(true);
    for (const e of r.edges.values()) expect(e.explicit).toBe(false);
  });
  it('13. portas explícitas escolhem exatamente o valor; porta inexistente e tipo incompatível', () => {
    const sal = value('Salário', 3000, 'income'), jan = month('2027-01'), f = formula('=x');
    const els = [sal, jan, f, link(sal, jan), link(jan, f, { sourcePort: 'income', targetPort: 'in', variable: 'x' })];
    let r = computeDataflow(els, dataflowSpec);
    expect(r.outputs.get(f.id)!.result).toMatchObject({ t: 'money', cents: 300000 });
    const bad = link(jan, f, { sourcePort: 'nao-existe', targetPort: 'in' });
    const inc = link(jan, f, { sourcePort: 'summary', targetPort: 'in' });
    r = computeDataflow([...els, bad, inc], dataflowSpec);
    expect(r.edges.get(bad.id)!.status).toBe('missing-port');
    expect(r.edges.get(inc.id)!.status).toBe('incompatible');
  });
  it('seta visual nunca calcula', () => {
    const sal = value('Salário', 3000, 'income'), jan = month('2027-01');
    const vis = link(sal, jan);
    vis.connection.kind = 'visual';
    const r = computeDataflow([sal, jan, vis], dataflowSpec);
    expect(r.edges.size).toBe(0);
    expect((r.outputs.get(jan.id)!.summary as { incomeCents: number }).incomeCents).toBe(0);
  });
  it('sugestão de portas para conexões novas segue o tipo preferido do destino', () => {
    const spec = (w: WidgetElement) => dataflowSpec(w.widgetType, w)!;
    const fin = createWidget(WIDGET.finance, '1.0.0', 'Fin', 0, 0, 1, 1, {});
    const jan = month('2027-01'), f = formula(''), ch = createWidget(WIDGET.chart, '1.0.0', 'G', 0, 0, 1, 1, {});
    expect(suggestPorts(spec(fin), spec(f))?.from.id).toBe('balanceMoney');
    expect(findPortPair(spec(fin), spec(f))?.from.id).toBe('balance'); // legado
    expect(suggestPorts(spec(fin), spec(jan))?.from.id).toBe('occurrences');
    expect(suggestPorts(spec(jan), spec(f))?.from.id).toBe('balance');
    expect(suggestPorts(spec(jan), spec(ch))?.from.id).toBe('summary');
  });
  it('finalizeDataEdges fixa portas e nome lógico só nas conexões indicadas', () => {
    const sal = value('Salário', 3000, 'income'), jan = month('Janeiro'), f = formula('');
    const old = link(sal, f), novo = link(jan, f);
    const out = finalizeDataEdges([sal, jan, f, old, novo], new Set([novo.id]), dataflowSpec);
    const n = out.find((e) => e.id === novo.id) as LinearElement;
    expect(n.connection).toMatchObject({ sourcePort: 'balance', targetPort: 'in', variable: 'saldo_janeiro' });
    expect((out.find((e) => e.id === old.id) as LinearElement).connection.variable).toBeUndefined();
  });
  it('15. ciclo entre fórmulas é desativado, sem laço infinito', () => {
    const a = formula('=b + 1', 'A'), b = formula('=a + 1', 'B');
    const r = computeDataflow([a, b, link(a, b, { variable: 'a' }), link(b, a, { variable: 'b' })], dataflowSpec);
    expect([...r.edges.values()].map((e) => e.status)).toEqual(['cycle', 'cycle']);
  });
  it('16. fluxo reativo: só recalcula o que mudou e mantém referências estáveis', () => {
    const sal = value('Salário', 3000, 'income'), ali = value('Alimentação', 500, 'expense');
    const jan = month('2027-01'), feb = month('2027-02'), other = value('Outro', 10, 'income');
    const f = formula('=saldo_2027_01 + 0');
    const ch = createWidget(WIDGET.chart, '1.0.0', 'G', 0, 0, 1, 1, { mode: 'sources' });
    let els: AuroraElement[] = [sal, ali, jan, feb, other, f, ch, link(sal, jan), link(ali, jan), link(jan, f, { sourcePort: 'balance', targetPort: 'in', variable: 'saldo_2027_01' }), link(jan, ch), link(other, feb)];
    const r1 = computeDataflow(els, dataflowSpec);
    expect(r1.outputs.get(f.id)!.result).toMatchObject({ cents: 250000 });
    // Alimentação de 500 → 600: janeiro, fórmula e gráfico mudam; fevereiro mantém o mesmo objeto.
    els = els.map((e) => (e.id === ali.id ? { ...e, data: { ...(e as WidgetElement).data as object, amountCents: 60000 } } as AuroraElement : e));
    const r2 = computeDataflow(els, dataflowSpec, r1);
    expect(r2.outputs.get(f.id)!.result).toMatchObject({ cents: 240000 });
    expect((r2.inputs.get(ch.id)!.series[0].value as { balanceCents: number }).balanceCents).toBe(240000);
    expect(r2.outputs.get(feb.id)).toBe(r1.outputs.get(feb.id));
    expect(r2.outputs.get(sal.id)).toBe(r1.outputs.get(sal.id));
    expect(r2.outputs.get(jan.id)).not.toBe(r1.outputs.get(jan.id));
  });
  it('gráfico compara vários meses em ordem cronológica e avisa moedas diferentes', () => {
    const s = (period: string, bal: number, currency: 'BRL' | 'USD' = 'BRL') => ({ t: 'period' as const, period, label: period, currency, incomeCents: 0, expenseCents: 0, balanceCents: bal, neutralCents: 0, commitment: null, count: 0, byCategory: [] });
    const out = buildSeries({ mode: 'sources', chartType: 'line' }, [], [], { periods: [s('2027-02', 2000), s('2027-01', 1000)] });
    expect(out.series.map((x) => x.value)).toEqual([10, 20]);
    expect(buildSeries({ mode: 'sources', chartType: 'bar' }, [], [], { periods: [s('2027-01', 1), s('2027-02', 1, 'USD')] }).warning).toBeTruthy();
  });
});

describe('12, 20. renomear, duplicar, excluir, importar e exportar (store)', () => {
  beforeEach(() => setState({ ...initialEditorState, boardId: 'b', status: 'ready', history: {}, elements: [], boards: [] }));
  const flowOf = () => computeDataflow(getState().elements, dataflowSpec);

  it('conexão criada no quadro recebe portas e nome; renomear o bloco não quebra a fórmula', () => {
    const sal = value('Salário', 3000, 'income'), f = formula('=salario * 2');
    addElements([sal, f]);
    addElements([link(sal, f)]);
    const edge = getState().elements.find((e) => e.type === 'arrow') as LinearElement;
    expect(edge.connection).toMatchObject({ sourcePort: 'value', targetPort: 'in', variable: 'salario' });
    updateElements(new Set([sal.id]), (e) => ({ ...e, title: 'Renda principal' }));
    expect(flowOf().outputs.get(f.id)!.result).toMatchObject({ cents: 600000 });
  });

  it('12. renomear a variável atualiza a fórmula (e desfazer volta tudo)', () => {
    const sal = value('Salário', 3000, 'income'), f = formula('=salario * 2 + SOMA(salario)');
    addElements([sal, f]);
    addElements([link(sal, f)]);
    const edge = getState().elements.find((e) => e.type === 'arrow')!;
    expect(renameVariable(f.id, edge.id, 'renda')).toBeNull();
    const ff = getState().elements.find((e) => e.id === f.id) as WidgetElement;
    expect((ff.data as { expression: string }).expression).toBe('=renda * 2 + SOMA(renda)');
    expect(flowOf().outputs.get(f.id)!.result).toMatchObject({ cents: 900000 });
    expect(renameVariable(f.id, edge.id, '2x')).toMatch(/letras/);
    expect(renameVariable(f.id, edge.id, 'SOMA')).toMatch(/função/);
    undo();
    expect((getState().elements.find((e) => e.id === f.id) as WidgetElement).data).toMatchObject({ expression: '=salario * 2 + SOMA(salario)' });
    redo();
    expect((getState().elements.find((e) => e.id === f.id) as WidgetElement).data).toMatchObject({ expression: '=renda * 2 + SOMA(renda)' });
  });

  it('duplicar estrutura conectada remapeia referências; cópia isolada mostra dependência ausente', () => {
    const sal = value('Salário', 3000, 'income'), jan = month('2027-01'), f = formula('=saldo_2027_01');
    addElements([sal, jan, f]);
    addElements([link(sal, jan), link(jan, f)]);
    const all = getState().elements;
    const copies = cloneElements(all, { x: 500, y: 0 });
    const r = computeDataflow([...all, ...copies], dataflowSpec);
    const fCopy = copies.find((e) => e.type === 'widget' && e.widgetType === WIDGET.formula)!;
    expect(r.outputs.get(fCopy.id)!.result).toMatchObject({ cents: 300000 });
    const edgeCopy = copies.find((e) => e.type === 'arrow' && (e as LinearElement).endBinding?.elementId === fCopy.id) as LinearElement;
    expect(edgeCopy.startBinding?.elementId).not.toBe(jan.id);
    const lone = cloneElements([f], { x: 0, y: 300 })[0];
    const r2 = computeDataflow([...all, lone], dataflowSpec);
    expect((r2.outputs.get(lone.id)!.$formula as { ok: boolean; error: { code: string } }).error.code).toBe('unknown-variable');
  });

  it('excluir um valor usado por fórmula mostra erro sem corromper o documento', () => {
    const sal = value('Salário', 3000, 'income'), f = formula('=salario');
    addElements([sal, f]);
    addElements([link(sal, f)]);
    setSelection([sal.id], false);
    deleteSelected();
    const r = flowOf();
    expect((r.outputs.get(f.id)!.$formula as { ok: boolean }).ok).toBe(false);
    expect([...r.edges.values()][0]?.status ?? 'unbound').toBe('unbound');
    expect(getState().elements.find((e) => e.id === f.id)).toBeTruthy();
  });

  it('converter texto em valor mantém id e setas; texto sem número não converte', () => {
    const t = createText(0, 0, 'Salário 3000');
    const r = createShape('rectangle', 300, 0, 100, 100);
    const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
    arrow.startBinding = { elementId: t.id, fixedPoint: null };
    arrow.endBinding = { elementId: r.id, fixedPoint: null };
    addElements([t, r, arrow]);
    expect(convertTextToValue(t.id)).toBe(true);
    const conv = getState().elements.find((e) => e.id === t.id) as WidgetElement;
    expect(conv).toMatchObject({ type: 'widget', widgetType: WIDGET.value, title: 'Salário' });
    expect(sanitizeValue(conv.data).amountCents).toBe(300000);
    expect((getState().elements.find((e) => e.id === arrow.id) as LinearElement).startBinding?.elementId).toBe(t.id);
    undo();
    expect(getState().elements.find((e) => e.id === t.id)?.type).toBe('text');
  });

  it('20. exportar e importar JSON preserva valores, meses, fórmulas, portas e nomes', async () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Finanças');
    const sal = value('Salário', 3000, 'income', { category: 'Trabalho', period: '2027-01' }), jan = month('2027-01', { displayMode: 'detailed' }), f = formula('=saldo * 12', 'Projeção anual');
    board.elements = [sal, jan, f, link(sal, jan, { sourcePort: 'value', targetPort: 'entries', variable: 'salario' }), link(jan, f, { sourcePort: 'balance', targetPort: 'in', variable: 'saldo' })];
    const parsed = parseImport(buildExport([board], [], ws), ws.id);
    expect(parsed.warnings).toEqual([]);
    const adapter = new MemoryAdapter();
    await adapter.saveBoard(board); // o original existe: a importação cria um quadro novo, sem sobrescrever
    const { boardIds } = await applyImport(adapter, parsed, ws, () => 'novo');
    expect(boardIds).toEqual(['novo']);
    const loaded = (await adapter.loadBoard('novo'))!;
    expect(loaded.elements.map((e) => (e.type === 'arrow' ? (e as LinearElement).connection : (e as WidgetElement).data))).toEqual(board.elements.map((e) => (e.type === 'arrow' ? (e as LinearElement).connection : (e as WidgetElement).data)));
    const r = computeDataflow(loaded.elements, dataflowSpec);
    expect(r.outputs.get(f.id)!.result).toMatchObject({ t: 'money', cents: 3600000 });
  });

  it('migração preserva campos novos e quadros antigos (sem portas) continuam válidos', () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Q');
    const sal = value('S', 1, 'income'), f = formula('=s');
    board.elements = [sal, f, link(sal, f, { sourcePort: 'value', targetPort: 'in', variable: 's' })];
    const m = migrateBoard(JSON.parse(JSON.stringify(board)), ws.id).board;
    expect((m.elements[2] as LinearElement).connection).toMatchObject({ sourcePort: 'value', targetPort: 'in', variable: 's' });
    const legacy = parseImport(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'), 'ws');
    expect(legacy.warnings).toEqual([]);
  });

  it('widgets registrados com contrato completo e moldura compacta', () => {
    for (const id of [WIDGET.value, WIDGET.financePeriod, WIDGET.formula]) {
      const p = getWidget(id)!;
      expect(p.frame).toBe('bare');
      expect(p.librarySection).toBe('Finanças visuais');
      expect(p.exportSVG).toBeTypeOf('function');
      expect(p.sanitize(p.createData())).toEqual(p.createData());
    }
  });
});
