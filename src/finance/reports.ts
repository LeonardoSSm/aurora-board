/**
 * Relatórios do razão: fluxos do período, saldos e consolidado.
 *
 * Três conceitos que NUNCA se misturam:
 * - Saldo informado: fotografia da fonte numa data (`account.reportedBalance`).
 * - Fluxo calculado: soma das movimentações disponíveis no intervalo (não é saldo).
 * - Saldo estimado: âncora (saldo informado ou inicial declarado) + movimentações posteriores. Sem âncora
 *   não há saldo, só fluxo — e o consolidado diz quais contas ficaram de fora.
 *
 * Resultado do período (receita externa × despesa de consumo):
 * - Transferências entre contas próprias, pagamentos de fatura e aplicações/resgates ficam FORA.
 * - Despesa de consumo líquida = despesas − estornos. Tarifas e juros pagos aparecem à parte.
 * - Limite de cartão nunca entra em saldo nem patrimônio.
 */
import type { Currency } from '../core/finance';
import type { BankTransaction, FinancialAccount, MovementKind } from './model';
import { UNCATEGORIZED, isCardAccount } from './model';
import { monthOf } from './parsing';

export interface LedgerFilter {
  accountIds?: string[];
  from?: string;
  to?: string;
  categories?: string[];
  kinds?: MovementKind[];
  /** Incluir pendentes (padrão: sim, contadas à parte em `pendingCount`). */
  includePending?: boolean;
  text?: string;
  origin?: BankTransaction['source']['kind'];
  status?: 'posted' | 'pending';
}

export function matchesFilter(t: BankTransaction, f: LedgerFilter): boolean {
  if (f.accountIds?.length && !f.accountIds.includes(t.accountId)) return false;
  if (f.from && t.postedDate < f.from) return false;
  if (f.to && t.postedDate > f.to) return false;
  if (f.categories?.length && !f.categories.includes(t.local.category || UNCATEGORIZED)) return false;
  if (f.kinds?.length && !f.kinds.includes(t.local.kind)) return false;
  if (f.includePending === false && t.status === 'pending') return false;
  if (f.status && t.status !== f.status) return false;
  if (f.origin && t.source.kind !== f.origin) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    if (!t.description.toLowerCase().includes(q) && !(t.memo ?? '').toLowerCase().includes(q)) return false;
  }
  return true;
}

export interface FlowSummary {
  currency: Currency;
  count: number;
  pendingCount: number;
  incomeCents: number;
  reimbursementCents: number;
  expenseCents: number;
  refundCents: number;
  /** Despesa de consumo líquida (despesas − estornos). */
  netExpenseCents: number;
  feeCents: number;
  interestPaidCents: number;
  interestEarnedCents: number;
  transferInCents: number;
  transferOutCents: number;
  cardPaymentCents: number;
  investmentOutCents: number;
  investmentInCents: number;
  unclassifiedInCents: number;
  unclassifiedOutCents: number;
  /** Receitas externas − (consumo líquido + tarifas + juros pagos) + juros recebidos + reembolsos. */
  resultCents: number;
  /** Soma bruta dos valores (variação de caixa do conjunto filtrado). */
  netFlowCents: number;
  byCategory: { category: string; incomeCents: number; expenseCents: number }[];
  byMonth: { period: string; incomeCents: number; expenseCents: number; resultCents: number }[];
  warnings: string[];
}

function empty(currency: Currency): FlowSummary {
  return { currency, count: 0, pendingCount: 0, incomeCents: 0, reimbursementCents: 0, expenseCents: 0, refundCents: 0, netExpenseCents: 0, feeCents: 0, interestPaidCents: 0, interestEarnedCents: 0, transferInCents: 0, transferOutCents: 0, cardPaymentCents: 0, investmentOutCents: 0, investmentInCents: 0, unclassifiedInCents: 0, unclassifiedOutCents: 0, resultCents: 0, netFlowCents: 0, byCategory: [], byMonth: [], warnings: [] };
}

/** Efeito de UMA movimentação no resultado: receita (+), despesa (+) ou nada. */
export function resultEffect(t: BankTransaction): { income: number; expense: number } {
  const a = t.amountCents;
  switch (t.local.kind) {
    case 'income': return a >= 0 ? { income: a, expense: 0 } : { income: 0, expense: -a }; // receita negativa = devolução
    case 'reimbursement': return { income: Math.max(a, 0), expense: Math.max(-a, 0) };
    case 'expense': return { income: 0, expense: -a }; // crédito numa despesa reduz o consumo
    case 'refund': return { income: 0, expense: -a }; // estorno (+) reduz a despesa
    case 'fee': return { income: 0, expense: -a };
    case 'interest': return a >= 0 ? { income: a, expense: 0 } : { income: 0, expense: -a };
    default: return { income: 0, expense: 0 };
  }
}

export function summarizeFlows(txs: BankTransaction[], accounts: FinancialAccount[], filter: LedgerFilter = {}, currency: Currency = 'BRL'): FlowSummary {
  const s = empty(currency);
  const cats = new Map<string, { incomeCents: number; expenseCents: number }>();
  const months = new Map<string, { incomeCents: number; expenseCents: number }>();
  const acc = new Map(accounts.map((a) => [a.id, a]));
  let otherCurrency = 0, orphanCardPayments = 0;
  const hasCard = accounts.some((a) => isCardAccount(a) && (!filter.accountIds?.length || filter.accountIds.includes(a.id)));
  for (const t of txs) {
    if (!matchesFilter(t, filter)) continue;
    if (t.currency !== currency) { otherCurrency++; continue; }
    s.count++;
    if (t.status === 'pending') s.pendingCount++;
    s.netFlowCents += t.amountCents;
    const a = t.amountCents;
    switch (t.local.kind) {
      case 'income': if (a >= 0) s.incomeCents += a; else s.expenseCents += -a; break;
      case 'reimbursement': if (a >= 0) s.reimbursementCents += a; else s.expenseCents += -a; break;
      case 'expense': if (a <= 0) s.expenseCents += -a; else s.refundCents += a; break;
      case 'refund': if (a >= 0) s.refundCents += a; else s.expenseCents += -a; break;
      case 'fee': if (a <= 0) s.feeCents += -a; else s.refundCents += a; break;
      case 'interest': if (a >= 0) s.interestEarnedCents += a; else s.interestPaidCents += -a; break;
      case 'transfer': if (a >= 0) s.transferInCents += a; else s.transferOutCents += -a; break;
      case 'card_payment': {
        const account = acc.get(t.accountId);
        if (account && !isCardAccount(account) && a < 0) { s.cardPaymentCents += -a; if (!t.local.linkId) orphanCardPayments += -a; }
        break;
      }
      case 'investment': if (a < 0) s.investmentOutCents += -a; else s.investmentInCents += a; break;
      case 'unclassified': if (a >= 0) s.unclassifiedInCents += a; else s.unclassifiedOutCents += -a; break;
    }
    const eff = resultEffect(t);
    if (eff.income || eff.expense) {
      const name = t.local.category || UNCATEGORIZED;
      const c = cats.get(name) ?? { incomeCents: 0, expenseCents: 0 };
      c.incomeCents += eff.income;
      c.expenseCents += eff.expense;
      cats.set(name, c);
      const m = months.get(monthOf(t.postedDate)) ?? { incomeCents: 0, expenseCents: 0 };
      m.incomeCents += eff.income;
      m.expenseCents += eff.expense;
      months.set(monthOf(t.postedDate), m);
    }
  }
  s.netExpenseCents = s.expenseCents - s.refundCents;
  s.resultCents = s.incomeCents + s.reimbursementCents + s.interestEarnedCents - s.netExpenseCents - s.feeCents - s.interestPaidCents;
  s.byCategory = [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.expenseCents + b.incomeCents - (a.expenseCents + a.incomeCents));
  s.byMonth = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, v]) => ({ period, ...v, resultCents: v.incomeCents - v.expenseCents }));
  if (otherCurrency) s.warnings.push(`${otherCurrency} movimentação(ões) em outra moeda fora deste resumo (sem conversão).`);
  if (orphanCardPayments && !hasCard) s.warnings.push('Há pagamentos de fatura sem o cartão importado: as compras do cartão não estão neste razão, então o consumo do período pode estar subestimado.');
  if (s.unclassifiedInCents || s.unclassifiedOutCents) s.warnings.push('Há movimentações não classificadas fora de receitas e despesas.');
  if (s.pendingCount) s.warnings.push(`${s.pendingCount} movimentação(ões) pendente(s) incluída(s).`);
  return s;
}

export type BalanceBasis = 'reported' | 'estimated-from-reported' | 'estimated-from-opening' | 'none';

export interface AccountBalance {
  accountId: string;
  currency: Currency;
  reported?: { cents: number; asOf: string };
  /** Saldo estimado hoje (âncora + movimentações posteriores). */
  estimatedCents: number | null;
  basis: BalanceBasis;
  /** Fluxo calculado no intervalo pedido (não é saldo). */
  flowCents: number;
  lastTransactionDate?: string;
  /** Movimentações posteriores ao saldo informado mais antigas que ele? (extrato desatualizado). */
  stale: boolean;
  note: string;
}

export function accountBalance(account: FinancialAccount, txs: BankTransaction[], filter: LedgerFilter = {}, today?: string): AccountBalance {
  const own = txs.filter((t) => t.accountId === account.id && t.currency === account.currency);
  let last: string | undefined;
  for (const t of own) if (!last || t.postedDate > last) last = t.postedDate;
  const flowCents = own.filter((t) => matchesFilter(t, { ...filter, accountIds: [account.id] })).reduce((n, t) => n + t.amountCents, 0);
  const rb = account.reportedBalance;
  if (rb) {
    const asOf = rb.asOf.slice(0, 10);
    const after = own.filter((t) => t.postedDate > asOf && t.status === 'posted').reduce((n, t) => n + t.amountCents, 0);
    const stale = !!today && asOf < today && (!last || last <= asOf);
    return {
      accountId: account.id, currency: account.currency, reported: { cents: rb.cents, asOf: rb.asOf }, flowCents, lastTransactionDate: last,
      estimatedCents: rb.cents + after,
      basis: after ? 'estimated-from-reported' : 'reported',
      stale,
      note: after ? `Saldo informado em ${asOf} + movimentações posteriores (estimado).` : `Saldo informado pela fonte em ${asOf}.`,
    };
  }
  if (account.openingBalance) {
    const ob = account.openingBalance;
    const sum = own.filter((t) => t.postedDate >= ob.date && t.status === 'posted').reduce((n, t) => n + t.amountCents, 0);
    return { accountId: account.id, currency: account.currency, flowCents, lastTransactionDate: last, estimatedCents: ob.cents + sum, basis: 'estimated-from-opening', stale: false, note: `Saldo inicial declarado em ${ob.date} + movimentações (estimado).` };
  }
  return { accountId: account.id, currency: account.currency, flowCents, lastTransactionDate: last, estimatedCents: null, basis: 'none', stale: false, note: 'Sem saldo informado nem saldo inicial: só o fluxo das movimentações importadas é conhecido.' };
}

export interface Consolidated {
  currency: Currency;
  /** Soma dos saldos estimados das contas incluídas (cartões entram com o saldo devedor negativo). */
  totalCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  included: string[];
  missing: string[];
  complete: boolean;
}

export function consolidate(accounts: FinancialAccount[], txs: BankTransaction[], currency: Currency = 'BRL', today?: string): Consolidated {
  const out: Consolidated = { currency, totalCents: 0, assetsCents: 0, liabilitiesCents: 0, included: [], missing: [], complete: true };
  for (const a of accounts) {
    if (a.status !== 'active' || a.currency !== currency) continue;
    const b = accountBalance(a, txs, {}, today);
    if (b.estimatedCents === null) { out.missing.push(a.id); out.complete = false; continue; }
    out.included.push(a.id);
    out.totalCents += b.estimatedCents;
    if (b.estimatedCents >= 0) out.assetsCents += b.estimatedCents;
    else out.liabilitiesCents += -b.estimatedCents;
  }
  return out;
}

/** Mês da fatura (vencimento) de uma compra no cartão, dado o dia de fechamento. */
export function billMonth(postedDate: string, closingDay?: number): string {
  const [y, m, d] = postedDate.split('-').map(Number);
  // Compra depois do fechamento entra na fatura do mês seguinte; o vencimento é no mês seguinte ao fechamento.
  let t = y * 12 + (m - 1) + 1;
  if (closingDay && d > closingDay) t += 1;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export interface CardSummary {
  accountId: string;
  purchasesCents: number;
  refundsCents: number;
  paymentsCents: number;
  feesCents: number;
  interestCents: number;
  installmentsCount: number;
  /** Saldo devedor estimado (positivo = dívida), se houver âncora. */
  debtCents: number | null;
  limitCents?: number;
  availableLimitCents?: number;
  bills: { month: string; purchasesCents: number; refundsCents: number; paymentsCents: number }[];
}

export function cardSummary(account: FinancialAccount, txs: BankTransaction[], filter: LedgerFilter = {}): CardSummary {
  const own = txs.filter((t) => t.accountId === account.id && matchesFilter(t, { ...filter, accountIds: [account.id] }));
  const s: CardSummary = { accountId: account.id, purchasesCents: 0, refundsCents: 0, paymentsCents: 0, feesCents: 0, interestCents: 0, installmentsCount: 0, debtCents: null, limitCents: account.card?.limitCents, availableLimitCents: account.card?.availableLimitCents, bills: [] };
  const bills = new Map<string, { purchasesCents: number; refundsCents: number; paymentsCents: number }>();
  for (const t of own) {
    const month = billMonth(t.postedDate, account.card?.closingDay);
    const b = bills.get(month) ?? { purchasesCents: 0, refundsCents: 0, paymentsCents: 0 };
    const k = t.local.kind;
    if (k === 'card_payment' || (k === 'transfer' && t.amountCents > 0)) { s.paymentsCents += t.amountCents; b.paymentsCents += t.amountCents; }
    else if (k === 'fee') s.feesCents += -t.amountCents;
    else if (k === 'interest') s.interestCents += -t.amountCents;
    else if (t.amountCents < 0) { s.purchasesCents += -t.amountCents; b.purchasesCents += -t.amountCents; }
    else { s.refundsCents += t.amountCents; b.refundsCents += t.amountCents; }
    if (t.installment) s.installmentsCount++;
    bills.set(month, b);
  }
  const bal = accountBalance(account, txs);
  s.debtCents = bal.estimatedCents === null ? null : -bal.estimatedCents;
  s.bills = [...bills.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, ...v }));
  return s;
}

/** Recorrências prováveis: mesma descrição normalizada e valor em ≥ 3 meses distintos. */
export function recurring(txs: BankTransaction[], filter: LedgerFilter = {}): { description: string; amountCents: number; months: number; accountId: string }[] {
  const map = new Map<string, { description: string; amountCents: number; months: Set<string>; accountId: string }>();
  for (const t of txs) {
    if (!matchesFilter(t, filter) || t.amountCents >= 0) continue;
    const key = `${t.accountId}|${t.amountCents}|${t.description.toLowerCase().replace(/\d+/g, '').trim()}`;
    const r = map.get(key) ?? { description: t.description, amountCents: t.amountCents, months: new Set<string>(), accountId: t.accountId };
    r.months.add(monthOf(t.postedDate));
    map.set(key, r);
  }
  return [...map.values()].filter((r) => r.months.size >= 3).map((r) => ({ description: r.description, amountCents: r.amountCents, months: r.months.size, accountId: r.accountId })).sort((a, b) => a.amountCents - b.amountCents);
}
