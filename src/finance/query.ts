/**
 * Consultas do canvas ao razão financeiro (ciclo F1).
 *
 * O widget guarda só a CONSULTA (filtros, apresentação, referência ao razão local). O resultado é calculado
 * na hora a partir do razão: nada de extratos no JSON do quadro. Se o razão não está disponível (outro
 * navegador, dados apagados, conta excluída), o resultado é “indisponível” — nunca um valor inventado.
 *
 * Identidade estável para deduplicação no canvas: cada movimentação vira `bank:tx:<id>`; totais carregam
 * `members` com essas chaves, e o Mês financeiro recusa contar o mesmo lançamento por duas conexões.
 */
import type { Currency } from '../core/finance';
import type { Occurrence } from '../core/finance';
import type { OccurrenceSet, PeriodSummary } from '../core/financePeriod';
import { moneyValue, periodLabel, shiftPeriod, type MoneyValue } from '../core/scalar';
import { decToString, divRound, ONE } from '../core/decimal';
import type { BankTransaction, FinanceSnapshot } from './model';
import { UNCATEGORIZED } from './model';
import { accountBalance, matchesFilter, resultEffect, summarizeFlows, type FlowSummary, type LedgerFilter } from './reports';
import { monthOf } from './parsing';

export type BankMetric = 'income' | 'expense' | 'result' | 'balance' | 'transfers' | 'fees';
export type PeriodMode = 'month' | 'range' | 'last-n';
export type AIShareMode = 'none' | 'aggregate' | 'detail';

export interface AIShare {
  mode: AIShareMode;
  includeCategories: boolean;
  includeMonths: boolean;
  includeAccountNames: boolean;
  includeDescriptions: boolean;
  includeDates: boolean;
  /** Máximo de movimentações no modo detalhado. */
  maxItems: number;
  /** Resumo da configuração confirmada pelo usuário; se a consulta mudar, a autorização cai. */
  confirmedDigest: string;
  confirmedAt: number;
}

export interface BankQueryData {
  ledgerId: string;
  accountIds: string[];
  metric: BankMetric;
  category: string;
  periodMode: PeriodMode;
  period: string;
  from: string;
  to: string;
  months: number;
  currency: Currency;
  displayMode: 'compact' | 'normal' | 'detailed';
  aiShare: AIShare;
}

export const METRIC_LABELS: Record<BankMetric, string> = {
  income: 'Receitas',
  expense: 'Despesas (consumo líquido)',
  result: 'Resultado (receitas − despesas)',
  balance: 'Saldo estimado',
  transfers: 'Transferências entre contas',
  fees: 'Tarifas e juros pagos',
};

export const DEFAULT_AI_SHARE: AIShare = { mode: 'none', includeCategories: true, includeMonths: true, includeAccountNames: false, includeDescriptions: false, includeDates: true, maxItems: 50, confirmedDigest: '', confirmedAt: 0 };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function sanitizeBankQuery(raw: unknown, fallbackPeriod: string): BankQueryData {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = d.aiShare && typeof d.aiShare === 'object' ? (d.aiShare as Record<string, unknown>) : {};
  const b = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const ids = Array.isArray(d.accountIds) ? d.accountIds.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,80}$/.test(x)).slice(0, 50) : [];
  return {
    ledgerId: typeof d.ledgerId === 'string' && /^[\w-]{0,80}$/.test(d.ledgerId) ? d.ledgerId : '',
    accountIds: ids,
    metric: oneOf(d.metric, ['income', 'expense', 'result', 'balance', 'transfers', 'fees'] as const, 'expense'),
    category: typeof d.category === 'string' ? d.category.slice(0, 60) : '',
    periodMode: oneOf(d.periodMode, ['month', 'range', 'last-n'] as const, 'month'),
    period: typeof d.period === 'string' && PERIOD_RE.test(d.period) ? d.period : fallbackPeriod,
    from: typeof d.from === 'string' && DATE_RE.test(d.from) ? d.from : '',
    to: typeof d.to === 'string' && DATE_RE.test(d.to) ? d.to : '',
    months: typeof d.months === 'number' && Number.isInteger(d.months) ? Math.min(36, Math.max(1, d.months)) : 6,
    currency: d.currency === 'USD' || d.currency === 'EUR' ? d.currency : 'BRL',
    displayMode: oneOf(d.displayMode, ['compact', 'normal', 'detailed'] as const, 'normal'),
    aiShare: {
      mode: oneOf(s.mode, ['none', 'aggregate', 'detail'] as const, 'none'),
      includeCategories: b(s.includeCategories, true),
      includeMonths: b(s.includeMonths, true),
      includeAccountNames: b(s.includeAccountNames, false),
      includeDescriptions: b(s.includeDescriptions, false),
      includeDates: b(s.includeDates, true),
      maxItems: typeof s.maxItems === 'number' && Number.isInteger(s.maxItems) ? Math.min(200, Math.max(1, s.maxItems)) : 50,
      confirmedDigest: typeof s.confirmedDigest === 'string' ? s.confirmedDigest.slice(0, 40) : '',
      confirmedAt: typeof s.confirmedAt === 'number' && Number.isFinite(s.confirmedAt) ? s.confirmedAt : 0,
    },
  };
}

/** Intervalo de datas da consulta (AAAA-MM-DD, inclusivo). */
export function queryRange(q: Pick<BankQueryData, 'periodMode' | 'period' | 'from' | 'to' | 'months'>): { from: string; to: string } {
  const lastDay = (p: string) => { const [y, m] = p.split('-').map(Number); return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
  if (q.periodMode === 'range' && q.from && q.to) return q.from <= q.to ? { from: q.from, to: q.to } : { from: q.to, to: q.from };
  if (q.periodMode === 'last-n') return { from: `${shiftPeriod(q.period, -(q.months - 1))}-01`, to: lastDay(q.period) };
  return { from: `${q.period}-01`, to: lastDay(q.period) };
}

export function rangeLabel(q: BankQueryData): string {
  if (q.periodMode === 'month') return periodLabel(q.period);
  const r = queryRange(q);
  if (q.periodMode === 'last-n') return `${q.months} meses até ${periodLabel(q.period, 'short')}`;
  return `${r.from.split('-').reverse().join('/')} a ${r.to.split('-').reverse().join('/')}`;
}

export type QueryStatus = 'ok' | 'loading' | 'unavailable' | 'no-accounts';

export interface BankQueryResult {
  status: QueryStatus;
  message: string;
  range: { from: string; to: string };
  accountIds: string[];
  flows?: FlowSummary;
  /** Valor principal (centavos) ou null quando não pode ser calculado (ex.: saldo sem âncora). */
  valueCents: number | null;
  /** Movimentações consideradas (para ocorrências/IA). */
  txs: BankTransaction[];
  monthly: PeriodSummary[];
  balanceNote?: string;
}

export const txKey = (t: Pick<BankTransaction, 'id'>) => `bank:tx:${t.id}`;

/** Executa a consulta sobre o razão em memória. Pura e determinística. */
export function runBankQuery(state: Pick<FinanceSnapshot, 'ledgerId' | 'accounts' | 'transactions'> & { status: string }, q: BankQueryData): BankQueryResult {
  const range = queryRange(q);
  const base = { range, accountIds: [] as string[], valueCents: null, txs: [] as BankTransaction[], monthly: [] as PeriodSummary[] };
  if (state.status !== 'ready') return { ...base, status: 'loading', message: 'Carregando dados financeiros locais…' };
  if (q.ledgerId && q.ledgerId !== state.ledgerId) return { ...base, status: 'unavailable', message: 'Referência indisponível: os dados desta consulta estão em outro navegador ou foram apagados.' };
  const active = state.accounts.filter((a) => a.currency === q.currency);
  let accounts = q.accountIds.length ? active.filter((a) => q.accountIds.includes(a.id)) : active.filter((a) => a.status === 'active');
  if (q.accountIds.length && accounts.length < q.accountIds.length) return { ...base, status: 'unavailable', message: 'Referência indisponível: uma conta desta consulta não existe mais neste navegador.' };
  if (!accounts.length) return { ...base, status: 'no-accounts', message: state.accounts.length ? `Nenhuma conta em ${q.currency}.` : 'Nenhuma conta cadastrada em Minhas contas.' };
  accounts = [...accounts];
  const accountIds = accounts.map((a) => a.id);
  const filter: LedgerFilter = { accountIds, from: range.from, to: range.to, categories: q.category ? [q.category] : undefined };
  const flows = summarizeFlows(state.transactions, state.accounts, filter, q.currency);
  const inScope = state.transactions.filter((t) => t.currency === q.currency && matchesFilter(t, filter));
  let valueCents: number | null = null;
  let txs: BankTransaction[] = [];
  let balanceNote: string | undefined;
  switch (q.metric) {
    case 'income': valueCents = flows.incomeCents + flows.reimbursementCents + flows.interestEarnedCents; txs = inScope.filter((t) => resultEffect(t).income > 0); break;
    case 'expense': valueCents = flows.netExpenseCents + flows.feeCents + flows.interestPaidCents; txs = inScope.filter((t) => resultEffect(t).expense !== 0); break;
    case 'result': valueCents = flows.resultCents; txs = inScope.filter((t) => { const e = resultEffect(t); return e.income > 0 || e.expense !== 0; }); break;
    case 'transfers': valueCents = flows.transferOutCents; txs = inScope.filter((t) => t.local.kind === 'transfer' && t.amountCents < 0); break;
    case 'fees': valueCents = flows.feeCents + flows.interestPaidCents; txs = inScope.filter((t) => (t.local.kind === 'fee' || t.local.kind === 'interest') && t.amountCents < 0); break;
    case 'balance': {
      let sum = 0, ok = true;
      const notes: string[] = [];
      for (const a of accounts) {
        const b = accountBalance(a, state.transactions);
        if (b.estimatedCents === null) { ok = false; notes.push(`${a.name}: sem saldo informado`); } else sum += b.estimatedCents;
      }
      valueCents = ok ? sum : null;
      balanceNote = ok ? 'Saldo estimado (âncora informada + movimentações posteriores).' : `Saldo indisponível — ${notes.join('; ')}.`;
      break;
    }
  }
  // Série mensal (para gráficos): resultado por mês dentro do intervalo.
  const monthly: PeriodSummary[] = [];
  const first = range.from.slice(0, 7), last = range.to.slice(0, 7);
  for (let p = first, n = 0; p <= last && n < 60; p = shiftPeriod(p, 1), n++) {
    const m = flows.byMonth.find((x) => x.period === p);
    const inc = m?.incomeCents ?? 0, exp = m?.expenseCents ?? 0;
    const cats = new Map<string, { incomeCents: number; expenseCents: number }>();
    for (const t of inScope) {
      if (monthOf(t.postedDate) !== p) continue;
      const e = resultEffect(t);
      if (!e.income && !e.expense) continue;
      const c = cats.get(t.local.category || UNCATEGORIZED) ?? { incomeCents: 0, expenseCents: 0 };
      c.incomeCents += e.income; c.expenseCents += e.expense;
      cats.set(t.local.category || UNCATEGORIZED, c);
    }
    monthly.push({ t: 'period', period: p, label: periodLabel(p, 'short'), currency: q.currency, incomeCents: inc, expenseCents: exp, balanceCents: inc - exp, neutralCents: 0, commitment: inc > 0 ? decToString(divRound(BigInt(exp) * ONE, BigInt(inc))) : null, count: inScope.filter((t) => monthOf(t.postedDate) === p).length, byCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })) });
  }
  return { status: 'ok', message: '', range, accountIds, flows, valueCents, txs, monthly, balanceNote };
}

/** Saídas tipadas para o motor de conexões (contratos existentes: money, finance.occurrences, finance.period). */
export function queryOutputs(r: BankQueryResult, q: BankQueryData, ctx: { elementId: string; title: string }): Record<string, unknown> {
  if (r.status !== 'ok') return {};
  const members = r.txs.map(txKey);
  const period = q.periodMode === 'month' ? q.period : `${r.range.from}..${r.range.to}`;
  const meta = (k: string, role: MoneyValue['role'], label: string, mem?: string[]) => ({ role, key: `bank:agg:${ctx.elementId}:${k}`, label: `${label} · ${ctx.title}`, period, category: q.category || undefined, members: mem });
  const f = r.flows!;
  const roleOf: Record<BankMetric, MoneyValue['role']> = { income: 'income', expense: 'expense', result: 'neutral', balance: 'neutral', transfers: 'neutral', fees: 'expense' };
  const out: Record<string, unknown> = {
    income: moneyValue(f.incomeCents + f.reimbursementCents + f.interestEarnedCents, q.currency, meta('income', 'income', 'Receitas', r.txs.filter((t) => resultEffect(t).income > 0).map(txKey))),
    expenses: moneyValue(f.netExpenseCents + f.feeCents + f.interestPaidCents, q.currency, meta('expenses', 'expense', 'Despesas', r.txs.filter((t) => resultEffect(t).expense !== 0).map(txKey))),
    monthly: r.monthly,
  };
  if (r.valueCents !== null) out.value = moneyValue(r.valueCents, q.currency, meta('value', roleOf[q.metric], q.metric === 'balance' ? 'Saldo' : 'Valor', q.metric === 'balance' ? undefined : members));
  // Lançamentos individuais (para o Mês): só os que afetam o resultado, com chave global estável.
  if (q.metric !== 'balance' && q.metric !== 'transfers') {
    const items: Occurrence[] = [];
    for (const t of r.txs) {
      const e = resultEffect(t);
      if (e.income > 0) items.push({ entryId: t.id, description: t.description, kind: 'income', category: t.local.category || UNCATEGORIZED, date: t.postedDate, paid: t.status === 'posted', index: 1, count: 1, amountCents: e.income, key: txKey(t) });
      else if (e.expense !== 0) items.push({ entryId: t.id, description: t.description, kind: 'expense', category: t.local.category || UNCATEGORIZED, date: t.postedDate, paid: t.status === 'posted', index: 1, count: 1, amountCents: e.expense, key: txKey(t) });
    }
    const set: OccurrenceSet = { t: 'occurrences', sourceId: `bank:${ctx.elementId}`, source: ctx.title, currency: q.currency, items };
    out.occurrences = set;
  }
  return out;
}
