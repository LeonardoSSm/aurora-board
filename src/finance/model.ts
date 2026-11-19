/**
 * Modelo canônico das finanças pessoais (ciclo F1).
 *
 * Independente do canvas: nada aqui conhece quadros, elementos ou widgets. O canvas consulta este domínio
 * (src/finance/query.ts) e guarda apenas a consulta, nunca as transações.
 *
 * Invariantes:
 * - Dinheiro em centavos inteiros seguros (|c| ≤ 10¹⁵). `amountCents` tem SINAL do ponto de vista da conta:
 *   crédito (+) aumenta o saldo; débito (−) diminui. Num cartão, compra é − (aumenta a dívida) e pagamento é +.
 * - Moeda explícita em conta e transação; nada é convertido.
 * - Datas como texto `AAAA-MM-DD` (data civil do extrato): nunca passam por `Date` com fuso.
 * - O registro de origem (campos de `BankTransaction` fora de `local`) não é alterado depois de gravado;
 *   a interpretação (tipo de movimento, categoria, vínculos) vive em `local`, editável e reversível.
 * - Toda transação aponta para sua origem (`source`) e, se importada, para a sessão de importação.
 */
import type { Currency } from '../core/finance';

export const FINANCE_SCHEMA_VERSION = 1;
/** Limite de |centavos| (igual ao motor financeiro do canvas). */
export const MAX_CENTS = 10 ** 15;

export type DataOrigin = 'manual' | 'csv' | 'ofx' | 'provider' | 'backup';
export type InstitutionType = 'bank' | 'payment' | 'broker' | 'card_issuer' | 'other';
export type AccountType = 'checking' | 'savings' | 'payment' | 'investment' | 'credit_card' | 'other';
export type RecordStatus = 'active' | 'archived';

export interface ProviderRef {
  providerId: string;
  /** Identificador opaco no provedor (nunca um segredo). */
  externalId: string;
}

export interface FinancialInstitution {
  id: string;
  name: string;
  /** Código opcional (COMPE/ISPB/BANKID do OFX). Não é segredo. */
  code?: string;
  type: InstitutionType;
  status: RecordStatus;
  origin: DataOrigin;
  providerRef?: ProviderRef;
  createdAt: number;
  updatedAt: number;
}

export interface ReportedBalance {
  /** Saldo informado pela FONTE (fotografia), nunca calculado aqui. */
  cents: number;
  /** Data (AAAA-MM-DD) ou data-hora ISO da referência. */
  asOf: string;
  origin: DataOrigin;
  /** Saldo disponível, quando a fonte informa separadamente. */
  availableCents?: number;
}

export interface CardInfo {
  /** Limite total informado (centavos), se houver. */
  limitCents?: number;
  /** Limite disponível informado (centavos), se houver. NUNCA é somado a saldos bancários. */
  availableLimitCents?: number;
  /** Dia do fechamento da fatura (1–31). */
  closingDay?: number;
  /** Dia do vencimento da fatura (1–31). */
  dueDay?: number;
}

export interface FinancialAccount {
  id: string;
  institutionId: string;
  name: string;
  type: AccountType;
  currency: Currency;
  /** Somente os últimos dígitos, ex.: "•••• 1234". Nunca o número completo. */
  maskedNumber: string;
  status: RecordStatus;
  reportedBalance?: ReportedBalance;
  /** Saldo inicial declarado pelo usuário (âncora do saldo estimado), opcional. */
  openingBalance?: { cents: number; date: string };
  card?: CardInfo;
  origin: DataOrigin;
  providerRef?: ProviderRef;
  createdAt: number;
  lastUpdatedAt: number;
}

/** Tipo de movimento (interpretação). */
export type MovementKind =
  | 'income' // receita externa
  | 'expense' // despesa de consumo (compra, conta)
  | 'transfer' // entre contas próprias
  | 'card_payment' // pagamento de fatura (nos dois lados)
  | 'refund' // estorno de compra
  | 'reimbursement' // reembolso de terceiro
  | 'investment' // aplicação ou resgate
  | 'fee' // tarifa
  | 'interest' // juros (pagos ou recebidos, conforme o sinal)
  | 'unclassified'; // ainda não classificada

export const MOVEMENT_KINDS: MovementKind[] = ['income', 'expense', 'transfer', 'card_payment', 'refund', 'reimbursement', 'investment', 'fee', 'interest', 'unclassified'];

export const KIND_LABELS: Record<MovementKind, string> = {
  income: 'Receita',
  expense: 'Despesa',
  transfer: 'Transferência entre contas',
  card_payment: 'Pagamento de fatura',
  refund: 'Estorno',
  reimbursement: 'Reembolso',
  investment: 'Aplicação/resgate',
  fee: 'Tarifa',
  interest: 'Juros',
  unclassified: 'Não classificada',
};

export type ClassificationSource = 'default' | 'rule' | 'user' | 'reconcile' | 'provider';

export interface LocalClassification {
  kind: MovementKind;
  category: string;
  kindSource: ClassificationSource;
  categorySource: ClassificationSource;
  /** Grupo de conciliação (par transferência/pagamento de fatura). */
  linkId?: string;
  /** Transação do outro lado do par. */
  linkedTxId?: string;
  note?: string;
  updatedAt?: number;
}

export interface TransactionSource {
  kind: DataOrigin;
  importId?: string;
  providerId?: string;
  /** Nome do arquivo saneado (sem caminho). */
  fileName?: string;
}

export interface BankTransaction {
  id: string;
  accountId: string;
  source: TransactionSource;
  /** ID original da fonte (FITID do OFX, id do provedor), quando existir. */
  externalId?: string;
  /** Chave de deduplicação dentro da conta: `ext:<id>` ou `fp:<impressão>#<ocorrência>`. */
  dedupeKey: string;
  /** Data da operação (DTUSER), se diferente da contabilização. */
  operationDate?: string;
  /** Data de contabilização (AAAA-MM-DD). */
  postedDate: string;
  description: string;
  memo?: string;
  amountCents: number;
  currency: Currency;
  direction: 'credit' | 'debit';
  /** Tipo informado pela fonte (TRNTYPE, coluna "tipo"), apenas para auditoria. */
  rawType?: string;
  status: 'posted' | 'pending';
  /** Número de documento / referência externa. */
  reference?: string;
  installment?: { index: number; count: number };
  importedAt: number;
  local: LocalClassification;
}

export type ImportOrigin = 'csv' | 'ofx' | 'provider' | 'backup' | 'manual';
export type ImportStatus = 'committed' | 'reverted';

export interface ImportCounts {
  read: number;
  accepted: number;
  duplicate: number;
  ignored: number;
  conflict: number;
  invalid: number;
  /** Pendentes que viraram contabilizadas (atualizadas sem duplicar). */
  updated: number;
}

export interface ImportSession {
  id: string;
  origin: ImportOrigin;
  fileName?: string;
  providerId?: string;
  createdAt: number;
  accountId: string;
  counts: ImportCounts;
  status: ImportStatus;
  range?: { from: string; to: string };
  reportedBalance?: ReportedBalance;
  warnings: string[];
  errors: string[];
  revertedAt?: number;
  /** Transações cujo status foi atualizado por esta importação (para reverter). */
  updatedTx?: { id: string; prevStatus: 'posted' | 'pending'; prevPostedDate: string; prevDedupeKey: string; prevExternalId?: string }[];
}

export type ConsentStatus = 'awaiting' | 'active' | 'expired' | 'revoked' | 'error';
export type ProviderEnvironment = 'mock' | 'sandbox' | 'production';

/** Somente quando há integração (fictícia ou real). Nunca contém segredos, tokens ou senhas. */
export interface ConsentRecord {
  id: string;
  providerId: string;
  environment: ProviderEnvironment;
  /** Identificador opaco do consentimento no provedor. */
  consentRef: string;
  institutionId?: string;
  scopes: string[];
  status: ConsentStatus;
  grantedAt?: number;
  expiresAt?: number;
  lastSyncAt?: number;
  revokedAt?: number;
  lastError?: string;
}

export interface Category {
  id: string;
  name: string;
  /** Sugestão de uso; não restringe. */
  scope: 'expense' | 'income' | 'any';
  builtin: boolean;
}

export interface CategoryRule {
  id: string;
  /** Texto procurado na descrição (sem acentos, minúsculas). */
  match: string;
  accountId?: string;
  kind?: MovementKind;
  category?: string;
  enabled: boolean;
  createdAt: number;
}

export interface FinanceSnapshot {
  ledgerId: string;
  institutions: FinancialInstitution[];
  accounts: FinancialAccount[];
  transactions: BankTransaction[];
  imports: ImportSession[];
  consents: ConsentRecord[];
  categories: Category[];
  rules: CategoryRule[];
}

export const DEFAULT_CATEGORIES: { name: string; scope: Category['scope'] }[] = [
  { name: 'Salário', scope: 'income' },
  { name: 'Outras receitas', scope: 'income' },
  { name: 'Moradia', scope: 'expense' },
  { name: 'Alimentação', scope: 'expense' },
  { name: 'Mercado', scope: 'expense' },
  { name: 'Transporte', scope: 'expense' },
  { name: 'Saúde', scope: 'expense' },
  { name: 'Educação', scope: 'expense' },
  { name: 'Lazer', scope: 'expense' },
  { name: 'Assinaturas', scope: 'expense' },
  { name: 'Compras', scope: 'expense' },
  { name: 'Contas e serviços', scope: 'expense' },
  { name: 'Impostos e taxas', scope: 'expense' },
  { name: 'Transferências', scope: 'any' },
  { name: 'Investimentos', scope: 'any' },
  { name: 'Sem categoria', scope: 'any' },
];

export const UNCATEGORIZED = 'Sem categoria';

export function isSafeCents(c: unknown): c is number {
  return typeof c === 'number' && Number.isSafeInteger(c) && Math.abs(c) <= MAX_CENTS;
}

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last && y >= 1900 && y <= 2200;
}

/** Mascara um identificador de conta/cartão: mantém só os últimos 4 caracteres alfanuméricos. */
export function maskIdentifier(raw: string | undefined | null): string {
  const clean = String(raw ?? '').replace(/[^0-9a-z]/gi, '');
  if (!clean) return '';
  return `•••• ${clean.slice(-4)}`;
}

/** Remove caracteres de controle e limita o tamanho de textos vindos de arquivos ou provedores. */
export function cleanText(s: unknown, max = 300): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Normaliza para comparação: sem acentos, minúsculas, espaços simples. */
export function normalizeDesc(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isCardAccount(a: Pick<FinancialAccount, 'type'>): boolean {
  return a.type === 'credit_card';
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  payment: 'Conta de pagamento',
  investment: 'Investimentos',
  credit_card: 'Cartão de crédito',
  other: 'Outra',
};
