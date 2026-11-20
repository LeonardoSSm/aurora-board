/**
 * Classificação local (não destrutiva) de movimentações.
 *
 * Ordem: regra do usuário → pista da fonte (tipo OFX) → palavras-chave conservadoras → sinal do valor.
 * O resultado vai para `transaction.local`; o registro original nunca é alterado. Classificações feitas pelo
 * usuário (`kindSource/categorySource = 'user'`) nunca são sobrescritas por regras ou conciliação automática.
 */
import type { BankTransaction, CategoryRule, FinancialAccount, LocalClassification, MovementKind } from './model';
import { UNCATEGORIZED, isCardAccount, normalizeDesc } from './model';

type Hint = { kind: MovementKind; re: RegExp };

/** Pagamento de fatura: forte o bastante para classificar mesmo sem o cartão importado. */
export const CARD_PAYMENT_RE = /\b(pagamento (de )?fatura|pagto fatura|pag fatura|pgto fatura|pagamento cartao|pgto cartao|pagto cartao|fatura (do )?cartao|pagamento recebido|pagamento efetuado|pag boleto cartao)\b/;
/** Indício de transferência (só vale com o par na outra conta própria). */
export const TRANSFER_HINT_RE = /\b(transf|transferencia|ted|doc|pix|entre contas|mesma titularidade|tev|transfer)\b/;
const HINTS: Hint[] = [
  { kind: 'refund', re: /\b(estorno|estornad[oa]|chargeback|cancelamento de compra|devolucao de compra|credito de estorno)\b/ },
  { kind: 'fee', re: /\b(tarifa|tar pacote|anuidade|cesta de servicos|taxa de manutencao|iof)\b/ },
  { kind: 'interest', re: /\b(juros|encargos|mora|rendimento|rend pago|rendimentos)\b/ },
  { kind: 'investment', re: /\b(aplicacao|aplic|resgate|cdb|lci|lca|tesouro direto|invest)\b/ },
  { kind: 'reimbursement', re: /\b(reembolso)\b/ },
];

const CATEGORY_HINTS: { category: string; re: RegExp }[] = [
  { category: 'Salário', re: /\b(salario|folha|proventos|pagamento de salario)\b/ },
  { category: 'Transporte', re: /\b(uber|99 ?app|99pop|cabify|combustivel|posto|estacionamento|metro|onibus|pedagio|sem parar)\b/ },
  { category: 'Alimentação', re: /\b(ifood|rappi|restaurante|lanchonete|padaria|pizzaria|burger|cafe)\b/ },
  { category: 'Mercado', re: /\b(mercado|supermercado|atacadao|assai|carrefour|hortifruti)\b/ },
  { category: 'Assinaturas', re: /\b(netflix|spotify|youtube premium|disney|prime video|hbo|max|apple com bill|google one|icloud)\b/ },
  { category: 'Moradia', re: /\b(aluguel|condominio|iptu)\b/ },
  { category: 'Contas e serviços', re: /\b(energia|luz|enel|cemig|copel|sabesp|agua|internet|vivo|claro|tim|oi fibra|gas)\b/ },
  { category: 'Saúde', re: /\b(farmacia|drogaria|drogasil|raia|hospital|clinica|laboratorio|plano de saude|unimed)\b/ },
  { category: 'Educação', re: /\b(escola|faculdade|curso|udemy|alura|livraria)\b/ },
];

const SOURCE_TYPES: Record<string, MovementKind> = { FEE: 'fee', SRVCHG: 'fee', INT: 'interest', DIV: 'income' };

export interface ClassifyInput {
  description: string;
  amountCents: number;
  rawType?: string;
  categoryHint?: string;
}

export function ruleMatches(rule: CategoryRule, desc: string, accountId: string): boolean {
  if (!rule.enabled || !rule.match.trim()) return false;
  if (rule.accountId && rule.accountId !== accountId) return false;
  return normalizeDesc(desc).includes(normalizeDesc(rule.match));
}

/** Classificação inicial de uma movimentação nova. */
export function classifyNew(input: ClassifyInput, account: Pick<FinancialAccount, 'id' | 'type'>, rules: CategoryRule[], categories: string[] = []): LocalClassification {
  const desc = normalizeDesc(input.description);
  const card = isCardAccount(account);
  let kind: MovementKind;
  let kindSource: LocalClassification['kindSource'] = 'default';
  const typeHint = input.rawType ? SOURCE_TYPES[input.rawType.toUpperCase()] : undefined;
  const hint = HINTS.find((h) => h.re.test(desc));
  if (CARD_PAYMENT_RE.test(desc) && (card ? input.amountCents > 0 : input.amountCents < 0)) kind = 'card_payment';
  else if (hint && !(hint.kind === 'refund' && input.amountCents < 0)) kind = hint.kind;
  else if (typeHint) kind = typeHint;
  else if (card) kind = input.amountCents < 0 ? 'expense' : 'unclassified'; // crédito no cartão sem pista: não adivinha
  else kind = input.amountCents >= 0 ? 'income' : 'expense';

  let category = '';
  let categorySource: LocalClassification['categorySource'] = 'default';
  if (input.categoryHint) {
    const match = categories.find((c) => normalizeDesc(c) === normalizeDesc(input.categoryHint!));
    if (match) { category = match; categorySource = 'provider'; }
  }
  if (!category) category = CATEGORY_HINTS.find((h) => h.re.test(desc))?.category ?? '';
  if (kind === 'card_payment' || kind === 'transfer') category = 'Transferências';
  else if (kind === 'investment') category = 'Investimentos';
  else if (kind === 'fee') category = category || 'Impostos e taxas';
  if (!category) category = UNCATEGORIZED;

  for (const rule of rules) {
    if (!ruleMatches(rule, input.description, account.id)) continue;
    if (rule.kind) { kind = rule.kind; kindSource = 'rule'; }
    if (rule.category) { category = rule.category; categorySource = 'rule'; }
    break; // primeira regra que casa vence (ordem de criação)
  }
  return { kind, category, kindSource, categorySource };
}

/** Reaplica regras a transações existentes sem tocar no que o usuário definiu à mão. */
export function applyRules(txs: BankTransaction[], rules: CategoryRule[]): BankTransaction[] {
  const changed: BankTransaction[] = [];
  for (const t of txs) {
    const rule = rules.find((r) => ruleMatches(r, t.description, t.accountId));
    if (!rule) continue;
    const local = { ...t.local };
    let dirty = false;
    if (rule.kind && local.kindSource !== 'user' && local.kindSource !== 'reconcile' && local.kind !== rule.kind) { local.kind = rule.kind; local.kindSource = 'rule'; dirty = true; }
    if (rule.category && local.categorySource !== 'user' && local.category !== rule.category) { local.category = rule.category; local.categorySource = 'rule'; dirty = true; }
    if (dirty) changed.push({ ...t, local: { ...local, updatedAt: Date.now() } });
  }
  return changed;
}

/** Tipos que representam consumo/receita externa (o que entra no resultado do período). */
export function affectsResult(kind: MovementKind): boolean {
  return kind !== 'transfer' && kind !== 'card_payment' && kind !== 'investment';
}
