/**
 * Conciliação entre contas próprias: transferências e pagamentos de fatura.
 *
 * Um par é: débito numa conta própria + crédito do MESMO valor absoluto em outra conta própria, mesma moeda,
 * datas próximas (≤ 3 dias para transferências; ≤ 7 para pagamento de fatura, por compensação de boleto).
 * - Par aplicado automaticamente só quando é ÚNICO (nenhum outro candidato igualmente próximo) e há evidência
 *   textual em pelo menos um lado (TED/PIX/transferência, ou pagamento de fatura). Senão vira sugestão.
 * - Classificações do usuário nunca são alteradas; pares podem ser desfeitos.
 */
import type { BankTransaction, FinancialAccount, MovementKind } from './model';
import { isCardAccount, normalizeDesc } from './model';
import { daysBetween } from './parsing';
import { CARD_PAYMENT_RE, TRANSFER_HINT_RE } from './classify';

export interface PairSuggestion {
  debitId: string;
  creditId: string;
  kind: Extract<MovementKind, 'transfer' | 'card_payment'>;
  days: number;
  /** Único e com evidência textual: pode ser aplicado sem perguntar. */
  confident: boolean;
  reason: string;
}

const PAIRABLE: MovementKind[] = ['income', 'expense', 'transfer', 'card_payment', 'unclassified', 'investment'];

function eligible(t: BankTransaction): boolean {
  return !t.local.linkId && PAIRABLE.includes(t.local.kind) && t.local.kindSource !== 'user';
}

export function findPairs(txs: BankTransaction[], accounts: FinancialAccount[]): PairSuggestion[] {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const credits = new Map<string, BankTransaction[]>(); // por |valor|
  for (const t of txs) {
    if (t.amountCents > 0 && eligible(t)) credits.set(`${t.currency}:${t.amountCents}`, [...(credits.get(`${t.currency}:${t.amountCents}`) ?? []), t]);
  }
  const out: PairSuggestion[] = [];
  const usedCredit = new Set<string>();
  const debits = txs.filter((t) => t.amountCents < 0 && eligible(t)).sort((a, b) => a.postedDate.localeCompare(b.postedDate));
  for (const d of debits) {
    const from = acc.get(d.accountId);
    if (!from) continue;
    const pool = (credits.get(`${d.currency}:${-d.amountCents}`) ?? []).filter((c) => c.accountId !== d.accountId && !usedCredit.has(c.id) && acc.has(c.accountId));
    const scored = pool
      .map((c) => {
        const to = acc.get(c.accountId)!;
        const kind: PairSuggestion['kind'] = isCardAccount(to) || isCardAccount(from) ? 'card_payment' : 'transfer';
        return { c, kind, days: Math.abs(daysBetween(d.postedDate, c.postedDate)), max: kind === 'card_payment' ? 7 : 3 };
      })
      .filter((x) => x.days <= x.max)
      .sort((a, b) => a.days - b.days);
    if (!scored.length) continue;
    const best = scored[0];
    const unique = scored.length === 1 || scored[1].days > best.days;
    const dn = normalizeDesc(d.description), cn = normalizeDesc(best.c.description);
    const evidence = best.kind === 'card_payment'
      ? CARD_PAYMENT_RE.test(dn) || CARD_PAYMENT_RE.test(cn) || d.local.kind === 'card_payment' || best.c.local.kind === 'card_payment'
      : TRANSFER_HINT_RE.test(dn) || TRANSFER_HINT_RE.test(cn) || d.local.kind === 'transfer' || best.c.local.kind === 'transfer';
    usedCredit.add(best.c.id);
    out.push({
      debitId: d.id,
      creditId: best.c.id,
      kind: best.kind,
      days: best.days,
      confident: unique && evidence,
      reason: `${best.kind === 'card_payment' ? 'Pagamento de fatura' : 'Transferência'}: mesmo valor em contas próprias, ${best.days} dia(s) de diferença${unique ? '' : ' (há outros candidatos)'}${evidence ? '' : ' (sem indicação na descrição)'}.`,
    });
  }
  return out;
}

/** Aplica pares: devolve as transações alteradas (as duas pontas de cada par). */
export function applyPairs(txs: BankTransaction[], pairs: PairSuggestion[], newId: () => string, now = Date.now()): BankTransaction[] {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const out: BankTransaction[] = [];
  for (const p of pairs) {
    const d = byId.get(p.debitId), c = byId.get(p.creditId);
    if (!d || !c || d.local.linkId || c.local.linkId) continue;
    const linkId = newId();
    for (const [t, other] of [[d, c], [c, d]] as const) {
      const keepCategory = t.local.categorySource === 'user';
      const next = { ...t, local: { ...t.local, kind: p.kind, kindSource: 'reconcile' as const, linkId, linkedTxId: other.id, category: keepCategory ? t.local.category : 'Transferências', categorySource: keepCategory ? t.local.categorySource : ('reconcile' as const), updatedAt: now } };
      byId.set(t.id, next);
      out.push(next);
    }
  }
  return out;
}

/** Desfaz um par (volta à classificação padrão pelo sinal; o usuário pode reclassificar). */
export function unlinkPair(txs: BankTransaction[], linkId: string, accounts: FinancialAccount[], now = Date.now()): BankTransaction[] {
  const acc = new Map(accounts.map((a) => [a.id, a]));
  return txs
    .filter((t) => t.local.linkId === linkId)
    .map((t) => {
      const card = acc.get(t.accountId) && isCardAccount(acc.get(t.accountId)!);
      const kind: MovementKind = card ? (t.amountCents < 0 ? 'expense' : 'unclassified') : t.amountCents >= 0 ? 'income' : 'expense';
      return { ...t, local: { ...t.local, kind, kindSource: 'default' as const, linkId: undefined, linkedTxId: undefined, category: t.local.categorySource === 'user' ? t.local.category : 'Sem categoria', categorySource: t.local.categorySource === 'user' ? ('user' as const) : ('default' as const), updatedAt: now } };
    });
}
