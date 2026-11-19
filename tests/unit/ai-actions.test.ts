/** Contrato v2 de ações da IA: validação, dinheiro exato, destinos, plano atômico, desfazer/refazer e compatibilidade. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiEntryId,
  amountToCents,
  buildApplyPlan,
  centsToDecimalText,
  crossCheck,
  destinationOptions,
  financeTargets,
  interpretFinancialRequest,
  isValidDate,
  localizedAmountToCents,
  localMoneyAction,
  parseAIProposal,
  proposalKey,
  resolveMoney,
  suggestedDestination,
  targetWarning,
  type Destination,
  type MoneyAction,
  type ProposedAction,
} from '../../src/integrations/aiActions';
import { buildSystemPrompt, parseProposal } from '../../src/integrations/aiContext';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { createLinear, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import { sanitizeAI } from '../../src/core/widgetData';
import { sanitizeFinance, type FinanceEntry } from '../../src/core/finance';
import { sanitizeValue } from '../../src/core/valueTile';
import type { AuroraElement, LinkKind, WidgetElement } from '../../src/core/schema';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { applyBatch, redo, undo } from '../../src/store/actions';

beforeAll(() => registerBuiltinWidgets());

const PEDIDO = 'Crie um bloco de receita de R$ 2.000,00';
const reply = (json: unknown, prefix = 'Certo.') => `${prefix}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
const REPLY_RECEITA = reply({ version: 2, actions: [{ type: 'create_value', role: 'income', currency: 'BRL', amount: '2000.00' }] });

function link(a: AuroraElement, b: AuroraElement, kind: LinkKind) {
  const l = createLinear('arrow', 0, 0, [[0, 0], [10, 10]], {}, kind);
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  return l;
}
const entry = (p: Partial<FinanceEntry> = {}): FinanceEntry => ({ id: 'e1', description: 'Aluguel', amountCents: 150000, kind: 'expense', category: 'Moradia', date: '', paid: false, installments: 1, installmentMode: 'split', ...p });
const ai = () => createWidget(WIDGET.ai, '1.0.0', 'IA', 0, 0, 380, 480, {}) as WidgetElement;
const fin = (title: string, data: object = {}) => createWidget(WIDGET.finance, '1.0.0', title, 600, 0, 360, 420, { currency: 'BRL', entries: [], ...data }) as WidgetElement;
const money = (p: Partial<MoneyAction> = {}): MoneyAction => ({
  type: 'money', origin: 'create_value', role: 'income', roleGiven: true, amountCents: 200000, currency: 'BRL', title: '', category: '', period: '', date: '', note: '',
  paid: false, installments: 1, installmentMode: 'split', target: null, ambiguous: false, ...p,
});
const moneyOf = (actions: ProposedAction[]) => actions.filter((a): a is MoneyAction => a.type === 'money');

function resetStore(elements: AuroraElement[] = []) {
  setState({ ...initialEditorState, boardId: 'b', status: 'ready', history: {}, elements, boards: [] });
}

describe('dinheiro sem ponto flutuante', () => {
  it('converte texto decimal e números exatos para centavos inteiros', () => {
    expect(amountToCents('2000.00')).toBe(200000);
    expect(amountToCents('2000')).toBe(200000);
    expect(amountToCents('2000.5')).toBe(200050);
    expect(amountToCents('0.01')).toBe(1);
    expect(amountToCents(2000)).toBe(200000);
    expect(amountToCents(1234.56)).toBe(123456);
    expect(amountToCents('9999999999999.99')).toBe(999999999999999);
    expect(centsToDecimalText(200000)).toBe('2000.00');
  });
  it('recusa formatos ambíguos, imprecisos ou fora do limite', () => {
    for (const bad of ['2.000,00', '2,000.00', '2000,00', '-5', '1e3', '2000.005', '', ' ', 'R$ 2000', '10000000000000.00', 'abc'])
      expect(amountToCents(bad), bad).toBeNull();
    for (const bad of [2000.005, 0.1 + 0.2, NaN, Infinity, -1, 1e21]) expect(amountToCents(bad), String(bad)).toBeNull();
    expect(amountToCents(null)).toBeNull();
    expect(amountToCents({})).toBeNull();
  });
  it('valores do pedido em formato brasileiro', () => {
    expect(localizedAmountToCents('2.000,00')).toBe(200000);
    expect(localizedAmountToCents('2.000')).toBe(200000);
    expect(localizedAmountToCents('2000,5')).toBe(200050);
    expect(localizedAmountToCents('19.90')).toBe(1990);
    expect(localizedAmountToCents('1.234.567,89')).toBe(123456789);
  });
  it('datas civis reais', () => {
    expect(isValidDate('2026-11-19')).toBe(true);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('19/11/2026')).toBe(false);
  });
});

describe(`pedido exato: "${PEDIDO}"`, () => {
  it('a resposta v2 vira um aurora.value de receita BRL com exatamente 200000 centavos', () => {
    const p = parseAIProposal(REPLY_RECEITA, new Set())!;
    expect(p.version).toBe(2);
    expect(p.rejected).toEqual([]);
    const [a] = moneyOf(p.actions);
    expect(a).toMatchObject({ origin: 'create_value', role: 'income', currency: 'BRL', amountCents: 200000, date: '', category: '', period: '' });

    const el = ai();
    resetStore([el]);
    const r = buildApplyPlan({ actions: p.actions, include: [true], destinations: [suggestedDestination(a, [])], elements: [el], ai: el, applyKey: 'm1', validIds: new Set() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.financial).toBe(true);
    expect(r.plan.add).toHaveLength(1);
    const tile = r.plan.add[0] as WidgetElement;
    expect(tile.widgetType).toBe(WIDGET.value);
    expect(tile.title).toBe('Receita');
    expect(tile.data).toEqual(sanitizeValue(tile.data));
    expect(tile.data).toMatchObject({ valueType: 'money', financialRole: 'income', currency: 'BRL', amountCents: 200000, category: '', period: '' });
    expect(r.plan.lines[0]).toContain('aurora.value');
    expect(r.plan.lines[0]).toMatch(/R\$\s2\.000,00/);
    // Nenhuma nota é criada.
    expect(r.plan.add.some((e) => e.type === 'widget' && e.widgetType === WIDGET.notes)).toBe(false);
  });

  it('a interpretação local lê o pedido sem depender do modelo', () => {
    const req = interpretFinancialRequest(PEDIDO);
    expect(req).toEqual({ role: 'income', amountCents: 200000, currency: 'BRL', intent: 'value' });
    expect(localMoneyAction(req)).toMatchObject({ origin: 'create_value', role: 'income', amountCents: 200000, currency: 'BRL', title: '' });
  });

  it('[reprodução] a IA propõe uma Nota "Receita": nenhuma ação financeira, a interpretação local cobre o pedido', () => {
    const bug = reply({ notes: [{ title: 'Receita', content: 'R$ 2.000,00' }], tasks: [], connections: [] });
    const p = parseAIProposal(bug, new Set())!;
    expect(p.actions).toEqual([{ type: 'note', title: 'Receita', content: 'R$ 2.000,00' }]);
    expect(moneyOf(p.actions)).toHaveLength(0);
    const local = localMoneyAction(interpretFinancialRequest(PEDIDO));
    expect(local).not.toBeNull();
    const el = ai();
    const r = buildApplyPlan({ actions: [local!], include: [true], destinations: [{ kind: 'value' }], elements: [el], ai: el, applyKey: 'm1:local', validIds: new Set() });
    expect(r.ok && (r.plan.add[0] as WidgetElement).data).toMatchObject({ financialRole: 'income', amountCents: 200000, currency: 'BRL' });
  });

  it('o prompt estruturado ensina o contrato v2 com o exemplo exato', () => {
    const s = buildSystemPrompt('', '', 'structure');
    expect(s).toContain('"version":2');
    expect(s).toContain('create_value');
    expect(s).toContain('add_finance_entry');
    expect(s).toContain(PEDIDO);
    expect(s).toContain('"amount":"2000.00"');
    expect(buildSystemPrompt('', '', 'chat')).not.toContain('create_value');
  });
});

describe('validação de propostas (modelo externo não confiável)', () => {
  it('aceita as válidas, recusa as inválidas com motivo, ação por ação', () => {
    const p = parseAIProposal(
      reply({
        version: 2,
        actions: [
          { type: 'create_value', role: 'expense', amount: '19.90' },
          { type: 'create_value', role: 'income', amount: 2000.005 },
          { type: 'create_value', role: 'income', amount: '2.000,00' },
          { type: 'create_value', role: 'income', amount: '10', amountCents: 999 },
          { type: 'create_value', role: 'income', amount: '0' },
          { type: 'create_value', role: 'income' },
          { type: 'create_value', role: 'lucro', amount: '1' },
          { type: 'add_finance_entry', kind: 'income', amount: '1', date: '2026-02-30' },
          { type: 'add_finance_entry', kind: 'expense', amount: '300', installments: 3 },
          { type: 'delete_everything' },
          { type: '__proto__' },
          { type: 'constructor' },
          'texto solto',
          null,
          { type: 'create_value', role: 'income', currency: 'JPY', amount: '1' },
        ],
      }),
      new Set(),
    )!;
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ type: 'money', role: 'expense', amountCents: 1990, currency: null });
    expect(p.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(p.rejected.find((r) => r.index === 3)!.reason).toContain('divergem');
    expect(p.rejected.find((r) => r.index === 4)!.reason).toContain('maior que zero');
    expect(p.rejected.find((r) => r.index === 8)!.reason).toContain('parcelas');
    expect(p.rejected.find((r) => r.index === 9)!.reason).toContain('desconhecido');
  });

  it('json ausente, inválido ou sem ações → sem proposta', () => {
    expect(parseAIProposal('sem json', new Set())).toBeNull();
    expect(parseAIProposal('```json\n{inválido\n```', new Set())).toBeNull();
    expect(parseAIProposal(reply([1, 2]), new Set())).toBeNull();
    expect(parseAIProposal(reply({ outra: 1 }), new Set())).toBeNull();
    expect(parseAIProposal(reply({ version: 2, actions: [] }), new Set())).toBeNull();
  });

  it('ações repetidas na mesma proposta não viram lançamento duplicado', () => {
    const a = { type: 'add_finance_entry', kind: 'income', amount: '2000.00', description: 'Salário' };
    const p = parseAIProposal(reply({ version: 2, actions: [a, a, { ...a }] }), new Set())!;
    expect(p.actions).toHaveLength(1);
    expect(p.notices.join(' ')).toContain('repetida');
  });

  it('limite de ações por proposta', () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ type: 'create_note', title: `N${i}`, content: '' }));
    const p = parseAIProposal(reply({ version: 2, actions: many }), new Set())!;
    expect(p.actions).toHaveLength(80);
    expect(p.rejected).toHaveLength(10);
  });

  it('versão desconhecida gera aviso, mas as ações são validadas pelo v2', () => {
    const p = parseAIProposal(reply({ version: 9, actions: [{ type: 'create_note', title: 'A' }] }), new Set())!;
    expect(p.actions).toHaveLength(1);
    expect(p.notices[0]).toContain('não reconhecida');
  });
});

describe('compatibilidade com propostas antigas (v1)', () => {
  it('notas, tarefas e conexões viram ações; conexões fora do contexto são recusadas com motivo', () => {
    const p = parseAIProposal(
      'ok\n```json\n{"notes":[{"title":"A","content":"x"}],"tasks":[{"text":"t","priority":"high"}],"connections":[{"from":"a","to":"b"},{"from":"a","to":"zzz"}]}\n```',
      new Set(['a', 'b']),
    )!;
    expect(p.version).toBe(1);
    expect(p.actions).toEqual([
      { type: 'note', title: 'A', content: 'x' },
      { type: 'tasks', title: 'Tarefas sugeridas', tasks: [{ text: 't', priority: 'high' }] },
      { type: 'connect', from: 'a', to: 'b', label: '' },
    ]);
    expect(p.rejected).toEqual([{ index: 3, type: 'connect', reason: 'conexão cita bloco fora do contexto autorizado' }]);
    // A função antiga continua disponível e com o mesmo resultado de antes.
    expect(parseProposal('ok\n```json\n{"notes":[{"title":"A","content":"x"}]}\n```', new Set())?.notes).toHaveLength(1);
  });

  it('dados antigos do bloco de IA (sem "applied") continuam válidos', () => {
    const d = sanitizeAI({ provider: 'openai', model: '', instruction: 'x', messages: [], authorized: {} });
    expect(d.applied).toEqual({});
    expect(sanitizeAI({ applied: { m1: 123, m2: 'x', m3: NaN, m4: Infinity } }).applied).toEqual({ m1: 123 });
    expect(Object.getPrototypeOf(sanitizeAI(JSON.parse('{"applied":{"__proto__":1}}')).applied)).toBe(Object.prototype);
  });

  it('a marca de aplicação sobrevive a ids de mensagem longos (quadros importados)', () => {
    const longId = 'x'.repeat(5000);
    const key = proposalKey(longId, 'local');
    expect(key.length).toBeLessThanOrEqual(200);
    const a = createWidget(WIDGET.ai, '1.0.0', 'IA', 0, 0, 380, 480, { applied: { [key]: 1 } }) as WidgetElement;
    expect(sanitizeAI(a.data).applied[key]).toBe(1);
    const r = buildApplyPlan({ actions: [money()], include: [true], destinations: [{ kind: 'value' }], elements: [a], ai: a, applyKey: key, validIds: new Set() });
    expect(r).toEqual({ ok: false, errors: ['Esta proposta já foi aplicada.'] });
  });
});

describe('destinos: bloco independente × lançamento em Finanças', () => {
  const setup = () => {
    const a = ai();
    const ctx = fin('Casa');
    const exec = fin('Empresa');
    const usd = fin('Viagem', { currency: 'USD' });
    const solto = fin('Solto');
    const els = [a, ctx, exec, usd, solto, link(ctx, a, 'context'), link(a, exec, 'execution'), link(usd, a, 'context')];
    const validIds = new Set([ctx.id, usd.id]);
    return { a, ctx, exec, usd, solto, els, validIds, targets: financeTargets(els, a.id, validIds) };
  };

  it('só blocos de Finanças do contexto autorizado ou ligados por execução são destinos', () => {
    const { targets, ctx, exec, usd } = setup();
    expect(targets.map((t) => [t.id, t.via])).toEqual([[ctx.id, 'context'], [usd.id, 'context'], [exec.id, 'execution']]);
  });

  it('pré-seleção e ambiguidade', () => {
    const { targets, ctx, solto } = setup();
    expect(suggestedDestination(money(), targets)).toEqual({ kind: 'value' });
    expect(suggestedDestination(money({ ambiguous: true }), targets)).toBeNull();
    expect(suggestedDestination(money({ origin: 'add_finance_entry', target: ctx.id }), targets)).toEqual({ kind: 'entry', targetId: ctx.id });
    // Duas opções em BRL e nenhum destino indicado → o usuário escolhe.
    expect(suggestedDestination(money({ origin: 'add_finance_entry' }), targets)).toBeNull();
    // Destino inventado/fora do contexto → escolha obrigatória + aviso.
    const fora = money({ origin: 'add_finance_entry', target: solto.id });
    expect(suggestedDestination(fora, targets)).toBeNull();
    expect(targetWarning(fora, targets)).toContain('não está no contexto');
    // Um único destino compatível → pré-selecionado (ainda confirmado pelo usuário).
    expect(suggestedDestination(money({ origin: 'add_finance_entry', currency: 'USD' }), targets)).toMatchObject({ kind: 'entry' });
  });

  it('opções indisponíveis explicam o motivo', () => {
    const { targets, usd } = setup();
    const opts = destinationOptions(money({ currency: 'BRL' }), targets);
    expect(opts.find((o) => o.key === `entry:${usd.id}`)).toMatchObject({ disabled: true, reason: expect.stringContaining('sem conversão') });
    const neutral = destinationOptions(money({ role: 'neutral' }), targets);
    expect(neutral.filter((o) => o.key !== 'value').every((o) => o.disabled)).toBe(true);
    const parcelado = destinationOptions(money({ origin: 'add_finance_entry', installments: 3, date: '2026-12-10' }), targets);
    expect(parcelado.find((o) => o.key === 'value')).toMatchObject({ disabled: true });
  });

  it('lançamento: padrões do sistema, nada inventado, efeito no saldo', () => {
    const { targets, ctx } = setup();
    const r = resolveMoney(money({ origin: 'add_finance_entry', currency: null }), { kind: 'entry', targetId: ctx.id }, targets, 'ai-m-0');
    expect(r.errors).toEqual([]);
    expect(r.entry).toEqual({ id: 'ai-m-0', description: '', amountCents: 200000, kind: 'income', category: '', date: '', paid: false, installments: 1, installmentMode: 'split' });
    expect(r.currency).toBe('BRL');
    expect(r.defaults.join(' | ')).toMatch(/do bloco de destino.*sem vencimento.*Sem categoria/);
    expect(r.effect).toMatch(/R\$\s0,00 → R\$\s2\.000,00/);
  });

  it('bloco de valor sem dados extras usa os padrões e não inventa competência/categoria', () => {
    const r = resolveMoney(money({ currency: null }), { kind: 'value' }, [], 'x');
    expect(r.valueData).toMatchObject({ currency: 'BRL', period: '', category: '', note: '' });
    expect(r.defaults).toEqual(expect.arrayContaining(['Moeda: BRL (padrão do sistema)', 'Competência: do mês conectado (padrão)']));
    // Data informada vira competência do mesmo mês (derivação, não invenção).
    expect(resolveMoney(money({ date: '2026-11-05' }), { kind: 'value' }, [], 'x').valueData!.period).toBe('2026-11');
  });

  it('avisa lançamento parecido já existente e recusa reaplicar o mesmo id', () => {
    const a = ai();
    const f = fin('Casa', { entries: [entry({ id: 'ai-m-0', kind: 'income', amountCents: 200000, description: '' })] });
    const targets = financeTargets([a, f], a.id, new Set([f.id]));
    const dup = resolveMoney(money({ origin: 'add_finance_entry' }), { kind: 'entry', targetId: f.id }, targets, 'ai-m-0');
    expect(dup.errors[0]).toContain('já foi aplicado');
    const similar = resolveMoney(money({ origin: 'add_finance_entry' }), { kind: 'entry', targetId: f.id }, targets, 'ai-m-1');
    expect(similar.errors).toEqual([]);
    expect(similar.warnings[0]).toContain('duplicado');
  });

  it('conferência com o pedido aponta divergências do modelo', () => {
    const req = interpretFinancialRequest(PEDIDO);
    expect(crossCheck(money(), req)).toEqual([]);
    expect(crossCheck(money({ amountCents: 20000 }), req)[0]).toContain('Valor diferente');
    expect(crossCheck(money({ role: 'expense' }), req)[0]).toContain('Classificação diferente');
    expect(crossCheck(money({ currency: 'USD' }), req)[0]).toContain('Moeda diferente');
  });
});

describe('interpretação local do pedido', () => {
  it.each([
    ['Lance uma despesa de R$ 150,00 nas finanças', { role: 'expense', amountCents: 15000, currency: 'BRL', intent: 'entry' }],
    ['adicionar lançamento de receita 2000 reais', { role: 'income', amountCents: 200000, currency: 'BRL', intent: 'entry' }],
    ['Crie um bloco de despesa de US$ 19.90', { role: 'expense', amountCents: 1990, currency: 'USD', intent: 'value' }],
    ['Registre uma receita de R$ 2.000,00', { role: 'income', amountCents: 200000, currency: 'BRL', intent: null }],
    ['Crie um bloco de receita de 2000', { role: 'income', amountCents: null, currency: null, intent: 'value' }],
    ['Receita de R$ 10 e despesa de R$ 5', { role: null, amountCents: null, currency: null, intent: null }],
  ])('%s', (text, expected) => {
    expect(interpretFinancialRequest(text)).toEqual(expected);
  });
  it('sem sinal financeiro → nada; incompleto → sem ação local', () => {
    expect(interpretFinancialRequest('Resuma o contexto')).toBeNull();
    expect(localMoneyAction(interpretFinancialRequest('Registre uma receita de R$ 2.000,00'))).toBeNull();
    expect(localMoneyAction(interpretFinancialRequest('Crie um bloco de receita de 2000'))).toBeNull();
  });
});

describe('aplicação: uma operação, desfazer/refazer, sem duplicar', () => {
  beforeEach(() => resetStore());

  it('cria bloco de valor + lançamento + marca de aplicação numa única entrada de histórico', () => {
    const a = ai();
    const f = fin('Casa', { entries: [entry()] });
    const els: AuroraElement[] = [a, f, link(f, a, 'context')];
    resetStore(els);
    const validIds = new Set([f.id]);
    const p = parseAIProposal(
      reply({
        version: 2,
        actions: [
          { type: 'create_value', role: 'income', currency: 'BRL', amount: '2000.00' },
          { type: 'add_finance_entry', target: f.id, kind: 'income', currency: 'BRL', amount: '2000.00', description: 'Salário' },
        ],
      }),
      validIds,
    )!;
    const targets = financeTargets(els, a.id, validIds);
    const dests = p.actions.map((x) => (x.type === 'money' ? suggestedDestination(x, targets) : null));
    const r = buildApplyPlan({ actions: p.actions, include: [true, true], destinations: dests, elements: getState().elements, ai: a, applyKey: 'm1', validIds });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const historyBefore = getState().history.b?.undo.length ?? 0;
    applyBatch(r.plan.add, r.plan.updates, true);
    const s = getState();
    expect(s.history.b.undo.length).toBe(historyBefore + 1);
    const tile = s.elements.find((e) => e.type === 'widget' && e.widgetType === WIDGET.value) as WidgetElement;
    expect(tile.data).toMatchObject({ financialRole: 'income', amountCents: 200000, currency: 'BRL' });
    const finNow = sanitizeFinance((s.elements.find((e) => e.id === f.id) as WidgetElement).data);
    expect(finNow.entries.map((e) => [e.id, e.kind, e.amountCents, e.description])).toEqual([['e1', 'expense', 150000, 'Aluguel'], [aiEntryId('m1', 1), 'income', 200000, 'Salário']]);
    expect(sanitizeAI((s.elements.find((e) => e.id === a.id) as WidgetElement).data).applied.m1).toBeTypeOf('number');
    expect(s.selectedIds).toEqual([tile.id]);

    // Reaplicar a mesma proposta é recusado.
    const again = buildApplyPlan({ actions: p.actions, include: [true, true], destinations: dests, elements: s.elements, ai: s.elements.find((e) => e.id === a.id) as WidgetElement, applyKey: 'm1', validIds });
    expect(again).toEqual({ ok: false, errors: ['Esta proposta já foi aplicada.'] });

    // Desfazer remove tudo de uma vez (inclusive a marca); refazer devolve.
    undo();
    let u = getState();
    expect(u.elements.some((e) => e.id === tile.id)).toBe(false);
    expect(sanitizeFinance((u.elements.find((e) => e.id === f.id) as WidgetElement).data).entries).toHaveLength(1);
    expect(sanitizeAI((u.elements.find((e) => e.id === a.id) as WidgetElement).data).applied).toEqual({});
    redo();
    u = getState();
    expect(u.elements.some((e) => e.id === tile.id)).toBe(true);
    expect(sanitizeFinance((u.elements.find((e) => e.id === f.id) as WidgetElement).data).entries).toHaveLength(2);
    expect(sanitizeAI((u.elements.find((e) => e.id === a.id) as WidgetElement).data).applied.m1).toBeTypeOf('number');
  });

  it('o atualizador do lançamento é idempotente (id determinístico)', () => {
    const a = ai();
    const f = fin('Casa');
    const validIds = new Set([f.id]);
    const r = buildApplyPlan({ actions: [money({ origin: 'add_finance_entry', target: f.id })], include: [true], destinations: [{ kind: 'entry', targetId: f.id }], elements: [a, f], ai: a, applyKey: 'm9', validIds });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const upd = r.plan.updates.find((u) => u.id === f.id)!;
    const once = upd.update(f.data);
    expect(sanitizeFinance(upd.update(once)).entries).toHaveLength(1);
  });

  it('valor sem destino, destino removido ou conexão fora do contexto bloqueiam o plano', () => {
    const a = ai();
    const f = fin('Casa');
    const validIds = new Set([f.id]);
    const base = { elements: [a, f] as AuroraElement[], ai: a, applyKey: 'm', validIds };
    expect(buildApplyPlan({ ...base, actions: [money()], include: [true], destinations: [null] })).toEqual({ ok: false, errors: ['Escolha o destino de cada valor financeiro.'] });
    const gone: Destination = { kind: 'entry', targetId: 'nao-existe' };
    const r = buildApplyPlan({ ...base, actions: [money()], include: [true], destinations: [gone] });
    expect(r.ok).toBe(false);
    const c = buildApplyPlan({ ...base, actions: [{ type: 'connect', from: f.id, to: 'x', label: '' }], include: [true], destinations: [null] });
    expect(c.ok).toBe(false);
    expect(buildApplyPlan({ ...base, actions: [money()], include: [false], destinations: [{ kind: 'value' }] })).toEqual({ ok: false, errors: ['Nenhuma ação selecionada.'] });
  });

  it('novo bloco de Finanças com o lançamento', () => {
    const a = ai();
    const r = buildApplyPlan({ actions: [money({ origin: 'add_finance_entry', role: 'expense', amountCents: 1990, currency: 'USD' })], include: [true], destinations: [{ kind: 'new-finance' }], elements: [a], ai: a, applyKey: 'm', validIds: new Set() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.plan.add[0] as WidgetElement;
    expect(f.widgetType).toBe(WIDGET.finance);
    expect(sanitizeFinance(f.data)).toMatchObject({ currency: 'USD', entries: [{ kind: 'expense', amountCents: 1990, date: '', category: '' }] });
  });

  it('notas, tarefas e conexões continuam sendo criadas', () => {
    const a = ai();
    const n1 = createWidget(WIDGET.notes, '1.0.0', 'Plano', 0, 600, 200, 200, {});
    const n2 = createWidget(WIDGET.notes, '1.0.0', 'Riscos', 300, 600, 200, 200, {});
    const validIds = new Set([n1.id, n2.id]);
    const p = parseAIProposal(reply({ version: 2, actions: [
      { type: 'create_note', title: 'Resumo', content: '# ok' },
      { type: 'create_tasks', tasks: [{ text: 'Revisar', priority: 'high' }] },
      { type: 'connect', from: n1.id, to: n2.id, label: 'depende' },
    ] }), validIds)!;
    const r = buildApplyPlan({ actions: p.actions, include: [true, true, true], destinations: [null, null, null], elements: [a, n1, n2], ai: a, applyKey: 'm', validIds });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.financial).toBe(false);
    expect(r.plan.add.map((e) => (e.type === 'widget' ? e.widgetType : e.type))).toEqual([WIDGET.notes, WIDGET.tasks, 'arrow']);
  });
});
