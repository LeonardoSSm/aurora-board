/**
 * Estado do razão financeiro na memória (carregado sob demanda do repositório) e as operações do usuário.
 *
 * Toda alteração passa pelo repositório ANTES de mudar a memória: se a gravação falhar, a memória continua
 * igual ao disco (sem perda silenciosa nem estado fantasma). `version` aumenta a cada mudança: o canvas usa
 * esse número para recalcular as consultas bancárias.
 */
import { create } from 'zustand';
import type { Currency } from '../core/finance';
import type { AccountType, BankTransaction, Category, CategoryRule, ConsentRecord, FinanceSnapshot, FinancialAccount, FinancialInstitution, ImportOrigin, ImportSession, MovementKind, ReportedBalance } from './model';
import { DEFAULT_CATEGORIES, MAX_AI_GRANTS, UNCATEGORIZED, cleanText, isSafeCents, isValidDate, maskIdentifier, normalizeDesc } from './model';
import type { ParsedStatement } from './drafts';
import { materializePlan, planImport, safeImportFileName, type ImportPlan } from './importPlan';
import { applyPairs, findPairs, unlinkPair, type PairSuggestion } from './reconcile';
import { applyRules, classifyNew } from './classify';
import { MemoryFinanceRepository, type FinanceRepository } from './repository';
import { planRestore, type FinanceBackup } from './backup';

export type LedgerStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FinanceState extends FinanceSnapshot {
  status: LedgerStatus;
  error: string | null;
  version: number;
  /** Ambiente de testes (provedor fictício) habilitado na interface. */
  testMode: boolean;
  /** Registros do disco ignorados por estarem corrompidos (mantidos no disco, nunca apagados em silêncio). */
  integrityIssues: number;
}

const emptySnapshot = (): FinanceSnapshot => ({ ledgerId: '', institutions: [], accounts: [], transactions: [], imports: [], consents: [], categories: [], rules: [], aiGrants: [] });

export const useFinance = create<FinanceState>(() => ({ ...emptySnapshot(), status: 'idle', error: null, version: 0, testMode: false, integrityIssues: 0 }));
export const getFinance = () => useFinance.getState();
const set = (p: Partial<FinanceState>) => useFinance.setState((s) => ({ ...p, version: s.version + 1 }));

let repo: FinanceRepository | null = null;
let loading: Promise<void> | null = null;
let repoFactory: () => FinanceRepository = () => new MemoryFinanceRepository();

export function setFinanceRepositoryFactory(f: () => FinanceRepository) { repoFactory = f; }
export function financeRepository(): FinanceRepository {
  if (!repo) repo = repoFactory();
  return repo;
}
/** Testes: troca o repositório e zera o estado. */
export function resetFinanceForTests(r: FinanceRepository) {
  repo = r;
  loading = null;
  useFinance.setState({ ...emptySnapshot(), status: 'idle', error: null, version: 0, testMode: false, integrityIssues: 0 });
}

export function newFinanceId(prefix: string): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `${prefix}${r}`;
}

/** Carrega o razão uma vez (idempotente). */
export function ensureFinanceLoaded(): Promise<void> {
  if (getFinance().status === 'ready') return Promise.resolve();
  if (loading) return loading;
  set({ status: 'loading', error: null });
  loading = (async () => {
    try {
      const r = financeRepository();
      const snap = await r.load();
      if (!snap.categories.length) {
        const cats: Category[] = DEFAULT_CATEGORIES.map((c, i) => ({ id: `cat_default_${i}`, name: c.name, scope: c.scope, builtin: true }));
        await r.putCategories(cats);
        snap.categories = cats;
      }
      set({ ...checked(snap), status: 'ready', error: null });
    } catch (e) {
      // Mensagem genérica: nunca ecoa conteúdo financeiro.
      set({ status: 'error', error: (e as Error)?.name === 'FinanceStorageError' ? (e as Error).message : 'Não foi possível abrir o armazenamento financeiro local.' });
      loading = null;
    }
  })();
  return loading;
}

function requireReady() {
  if (getFinance().status !== 'ready') throw new Error('Razão financeiro ainda não carregado.');
}

/**
 * Integridade ao carregar: um registro corrompido (edição manual do IndexedDB, extensão, falha de disco) não
 * derruba a interface nem entra nos cálculos — fica fora da memória, contado em `integrityIssues`, e intacto no disco.
 */
function checked(snap: FinanceSnapshot): FinanceSnapshot & { integrityIssues: number } {
  const accounts = snap.accounts.filter((a) => a && typeof a.id === 'string' && (a.currency === 'BRL' || a.currency === 'USD' || a.currency === 'EUR'));
  const accIds = new Set(accounts.map((a) => a.id));
  const transactions = snap.transactions.filter((t) => t && typeof t.id === 'string' && accIds.has(t.accountId) && isSafeCents(t.amountCents) && isValidDate(t.postedDate) && typeof t.description === 'string' && typeof t.dedupeKey === 'string' && !!t.local && typeof t.local.kind === 'string' && typeof t.local.category === 'string');
  const integrityIssues = snap.accounts.length - accounts.length + snap.transactions.length - transactions.length;
  return { ...snap, accounts, transactions, integrityIssues };
}

export const categoryNames = () => getFinance().categories.map((c) => c.name);

/* ------------------------------ Instituições e contas ------------------------------ */

export async function upsertInstitution(name: string, opts: { code?: string; origin?: FinancialInstitution['origin']; type?: FinancialInstitution['type']; providerRef?: FinancialInstitution['providerRef'] } = {}): Promise<FinancialInstitution> {
  requireReady();
  const clean = cleanText(name, 80) || 'Instituição';
  const found = getFinance().institutions.find((i) => (opts.providerRef ? i.providerRef?.providerId === opts.providerRef.providerId && i.providerRef.externalId === opts.providerRef.externalId : normalizeDesc(i.name) === normalizeDesc(clean)));
  if (found) return found;
  const now = Date.now();
  const inst: FinancialInstitution = { id: newFinanceId('inst_'), name: clean, code: opts.code ? cleanText(opts.code, 20) : undefined, type: opts.type ?? 'bank', status: 'active', origin: opts.origin ?? 'manual', providerRef: opts.providerRef, createdAt: now, updatedAt: now };
  await financeRepository().putInstitution(inst);
  set({ institutions: [...getFinance().institutions, inst] });
  return inst;
}

export interface NewAccountInput {
  institutionName: string;
  name: string;
  type: AccountType;
  currency?: Currency;
  number?: string;
  openingBalance?: { cents: number; date: string };
  card?: FinancialAccount['card'];
  origin?: FinancialAccount['origin'];
  providerRef?: FinancialAccount['providerRef'];
  institutionProviderRef?: FinancialInstitution['providerRef'];
}

export async function createAccount(input: NewAccountInput): Promise<FinancialAccount> {
  requireReady();
  if (input.openingBalance && (!isSafeCents(input.openingBalance.cents) || !isValidDate(input.openingBalance.date))) throw new Error('Saldo inicial inválido.');
  const inst = await upsertInstitution(input.institutionName, { origin: input.origin, providerRef: input.institutionProviderRef });
  const now = Date.now();
  const acc: FinancialAccount = {
    id: newFinanceId('acc_'),
    institutionId: inst.id,
    name: cleanText(input.name, 80) || 'Conta',
    type: input.type,
    currency: input.currency ?? 'BRL',
    maskedNumber: maskIdentifier(input.number),
    status: 'active',
    openingBalance: input.openingBalance,
    card: input.type === 'credit_card' ? sanitizeCard(input.card) : undefined,
    origin: input.origin ?? 'manual',
    providerRef: input.providerRef,
    createdAt: now,
    lastUpdatedAt: now,
  };
  await financeRepository().putAccount(acc);
  set({ accounts: [...getFinance().accounts, acc] });
  return acc;
}

function sanitizeCard(c: FinancialAccount['card']): FinancialAccount['card'] {
  if (!c) return {};
  const day = (d?: number) => (d && Number.isInteger(d) && d >= 1 && d <= 31 ? d : undefined);
  const cents = (v?: number) => (isSafeCents(v) && v >= 0 ? v : undefined);
  return { limitCents: cents(c.limitCents), availableLimitCents: cents(c.availableLimitCents), closingDay: day(c.closingDay), dueDay: day(c.dueDay) };
}

export async function updateAccount(id: string, patch: Partial<Pick<FinancialAccount, 'name' | 'status' | 'openingBalance' | 'card' | 'reportedBalance' | 'currency'>>): Promise<void> {
  requireReady();
  const cur = getFinance().accounts.find((a) => a.id === id);
  if (!cur) throw new Error('Conta não encontrada.');
  if (patch.currency && patch.currency !== cur.currency && getFinance().transactions.some((t) => t.accountId === id)) throw new Error('A moeda de uma conta com movimentações não pode mudar.');
  const next: FinancialAccount = { ...cur, ...patch, name: patch.name !== undefined ? cleanText(patch.name, 80) || cur.name : cur.name, card: patch.card ? sanitizeCard(patch.card) : cur.card, lastUpdatedAt: Date.now() };
  await financeRepository().putAccount(next);
  set({ accounts: getFinance().accounts.map((a) => (a.id === id ? next : a)) });
}

/** Exclui a conta e SEUS dados locais. Não revoga nada numa instituição externa (ver revokeConsent). */
export async function deleteAccountData(id: string): Promise<number> {
  requireReady();
  const { removed } = await financeRepository().deleteAccount(id);
  const s = getFinance();
  set({ accounts: s.accounts.filter((a) => a.id !== id), transactions: s.transactions.filter((t) => t.accountId !== id), imports: s.imports.filter((i) => i.accountId !== id) });
  return removed;
}

/* ------------------------------ Importação ------------------------------ */

export function prepareImport(accountId: string, parsed: Pick<ParsedStatement, 'drafts' | 'invalid' | 'ignored' | 'warnings'>): ImportPlan {
  requireReady();
  const account = getFinance().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Conta não encontrada.');
  return planImport({ account, drafts: parsed.drafts, existing: getFinance().transactions, invalid: parsed.invalid, ignored: parsed.ignored, warnings: parsed.warnings });
}

export interface CommitResult { session: ImportSession; added: number; updated: number; paired: number }

export async function commitImportPlan(plan: ImportPlan, ctx: { origin: ImportOrigin; fileName?: string; providerId?: string; reportedBalance?: ReportedBalance }): Promise<CommitResult> {
  requireReady();
  const s = getFinance();
  const account = s.accounts.find((a) => a.id === plan.accountId);
  if (!account) throw new Error('Conta não encontrada.');
  const { add, update, session } = materializePlan(plan, {
    account,
    origin: ctx.origin,
    importId: newFinanceId('imp_'),
    fileName: ctx.fileName ? safeImportFileName(ctx.fileName) : undefined,
    providerId: ctx.providerId,
    now: Date.now(),
    newId: () => newFinanceId('tx_'),
    rules: s.rules,
    categories: s.categories.map((c) => c.name),
    existing: s.transactions,
    reportedBalance: ctx.reportedBalance,
  });
  // Saldo informado mais recente que o atual atualiza a conta (na mesma transação da importação).
  let accounts: FinancialAccount[] | undefined;
  if (ctx.reportedBalance && (!account.reportedBalance || ctx.reportedBalance.asOf >= account.reportedBalance.asOf)) {
    accounts = [{ ...account, reportedBalance: ctx.reportedBalance, lastUpdatedAt: Date.now() }];
  }
  await financeRepository().commitImport({ session, add, update, accounts });
  const updatedIds = new Map(update.map((t) => [t.id, t]));
  const nextAccounts = accounts ? s.accounts.map((a) => (a.id === account.id ? accounts![0] : a)) : s.accounts;
  set({ transactions: [...s.transactions.map((t) => updatedIds.get(t.id) ?? t), ...add], imports: [...s.imports, session], accounts: nextAccounts });
  const paired = await autoReconcile();
  return { session, added: add.length, updated: update.length, paired };
}

export async function revertImport(importId: string): Promise<{ removed: number; restored: number }> {
  requireReady();
  const r = await financeRepository().revertImport(importId);
  // Recarrega do disco: a reversão restaura registros atualizados e desfaz pares que apontavam para removidos.
  const snap = await financeRepository().load();
  const removedIds = new Set(getFinance().transactions.filter((t) => !snap.transactions.some((x) => x.id === t.id)).map((t) => t.id));
  const orphans = snap.transactions.filter((t) => t.local.linkedTxId && removedIds.has(t.local.linkedTxId));
  if (orphans.length) {
    const fixed = orphans.flatMap((t) => unlinkPair([t], t.local.linkId!, snap.accounts));
    await financeRepository().updateTransactions(fixed);
    const m = new Map(fixed.map((t) => [t.id, t]));
    snap.transactions = snap.transactions.map((t) => m.get(t.id) ?? t);
  }
  set({ ...checked(snap) });
  return r;
}

/* ------------------------------ Classificação e conciliação ------------------------------ */

async function writeTxs(changed: BankTransaction[]) {
  if (!changed.length) return;
  await financeRepository().updateTransactions(changed);
  const m = new Map(changed.map((t) => [t.id, t]));
  set({ transactions: getFinance().transactions.map((t) => m.get(t.id) ?? t) });
}

/** Classificação manual (fonte "user": regras e conciliação automática não sobrescrevem). */
export async function classifyTransaction(id: string, patch: { kind?: MovementKind; category?: string; note?: string }): Promise<void> {
  requireReady();
  const t = getFinance().transactions.find((x) => x.id === id);
  if (!t) throw new Error('Movimentação não encontrada.');
  const local = { ...t.local, updatedAt: Date.now() };
  if (patch.kind && patch.kind !== local.kind) { local.kind = patch.kind; local.kindSource = 'user'; }
  if (patch.category !== undefined) { local.category = cleanText(patch.category, 60) || UNCATEGORIZED; local.categorySource = 'user'; }
  if (patch.note !== undefined) local.note = cleanText(patch.note, 300) || undefined;
  const changed: BankTransaction[] = [{ ...t, local }];
  // Mudar o tipo de uma ponta de par desfaz o par (a outra ponta volta ao padrão).
  if (patch.kind && t.local.linkId && patch.kind !== t.local.kind) {
    const other = getFinance().transactions.find((x) => x.id === t.local.linkedTxId);
    if (other) changed.push(...unlinkPair([other], t.local.linkId, getFinance().accounts));
    changed[0] = { ...changed[0], local: { ...changed[0].local, linkId: undefined, linkedTxId: undefined } };
  }
  await writeTxs(changed);
}

export function pairSuggestions(): PairSuggestion[] {
  const s = getFinance();
  return findPairs(s.transactions, s.accounts);
}

/** Aplica os pares confiáveis (únicos e com evidência na descrição). */
export async function autoReconcile(): Promise<number> {
  const confident = pairSuggestions().filter((p) => p.confident);
  if (!confident.length) return 0;
  const changed = applyPairs(getFinance().transactions, confident, () => newFinanceId('link_'));
  await writeTxs(changed);
  return confident.length;
}

export async function acceptPair(p: PairSuggestion): Promise<void> {
  await writeTxs(applyPairs(getFinance().transactions, [p], () => newFinanceId('link_')));
}

export async function unlink(linkId: string): Promise<void> {
  const s = getFinance();
  await writeTxs(unlinkPair(s.transactions, linkId, s.accounts));
}

/* ------------------------------ Lançamentos manuais ------------------------------ */

export async function addManualTransaction(accountId: string, input: { date: string; description: string; amountCents: number; kind?: MovementKind; category?: string }): Promise<BankTransaction> {
  requireReady();
  const s = getFinance();
  const account = s.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Conta não encontrada.');
  if (!isValidDate(input.date)) throw new Error('Data inválida.');
  if (!isSafeCents(input.amountCents) || input.amountCents === 0) throw new Error('Valor inválido.');
  const description = cleanText(input.description);
  if (!description) throw new Error('Informe a descrição.');
  const now = Date.now();
  const local = classifyNew({ description, amountCents: input.amountCents }, account, s.rules, s.categories.map((c) => c.name));
  if (input.kind) { local.kind = input.kind; local.kindSource = 'user'; }
  if (input.category) { local.category = cleanText(input.category, 60); local.categorySource = 'user'; }
  const id = newFinanceId('tx_');
  const tx: BankTransaction = { id, accountId, source: { kind: 'manual', importId: undefined }, dedupeKey: `manual:${id}`, postedDate: input.date, description, amountCents: input.amountCents, currency: account.currency, direction: input.amountCents >= 0 ? 'credit' : 'debit', status: 'posted', importedAt: now, local };
  // Registro de auditoria do lançamento manual (origem 'manual'; fora do histórico de arquivos na interface).
  const session: ImportSession = { id: `manual_${id}`, origin: 'manual', createdAt: now, accountId, counts: { read: 1, accepted: 1, duplicate: 0, ignored: 0, conflict: 0, invalid: 0, updated: 0 }, status: 'committed', warnings: [], errors: [] };
  await financeRepository().commitImport({ session, add: [tx], update: [] });
  set({ transactions: [...s.transactions, tx], imports: [...s.imports, session] });
  return tx;
}

export async function deleteManualTransaction(id: string): Promise<void> {
  const t = getFinance().transactions.find((x) => x.id === id);
  if (!t || t.source.kind !== 'manual') throw new Error('Só lançamentos manuais podem ser excluídos individualmente.');
  await financeRepository().deleteTransactions([id]);
  set({ transactions: getFinance().transactions.filter((x) => x.id !== id) });
}

/* ------------------------------ Categorias e regras ------------------------------ */

export async function addCategory(name: string, scope: Category['scope'] = 'any'): Promise<void> {
  const clean = cleanText(name, 60);
  if (!clean) throw new Error('Informe o nome.');
  if (getFinance().categories.some((c) => normalizeDesc(c.name) === normalizeDesc(clean))) throw new Error('Categoria já existe.');
  const c: Category = { id: newFinanceId('cat_'), name: clean, scope, builtin: false };
  await financeRepository().putCategories([c]);
  set({ categories: [...getFinance().categories, c] });
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const cat = getFinance().categories.find((c) => c.id === id);
  const clean = cleanText(name, 60);
  if (!cat || !clean) throw new Error('Categoria inválida.');
  await financeRepository().putCategories([{ ...cat, name: clean }]);
  // Renomeia a classificação local (não toca no registro original do banco).
  const changed = getFinance().transactions.filter((t) => t.local.category === cat.name).map((t) => ({ ...t, local: { ...t.local, category: clean, updatedAt: Date.now() } }));
  set({ categories: getFinance().categories.map((c) => (c.id === id ? { ...c, name: clean } : c)) });
  await writeTxs(changed);
}

export async function addRule(input: { match: string; category?: string; kind?: MovementKind; accountId?: string }): Promise<CategoryRule> {
  const match = cleanText(input.match, 80);
  if (!match) throw new Error('Informe o texto a procurar.');
  if (!input.category && !input.kind) throw new Error('A regra precisa definir categoria ou tipo.');
  const r: CategoryRule = { id: newFinanceId('rule_'), match, category: input.category ? cleanText(input.category, 60) : undefined, kind: input.kind, accountId: input.accountId, enabled: true, createdAt: Date.now() };
  await financeRepository().putRule(r);
  set({ rules: [...getFinance().rules, r] });
  return r;
}

export async function deleteRule(id: string): Promise<void> {
  await financeRepository().deleteRule(id);
  set({ rules: getFinance().rules.filter((r) => r.id !== id) });
}

/** Reaplica as regras às movimentações existentes (sem tocar em classificações manuais). */
export async function applyRulesNow(): Promise<number> {
  const s = getFinance();
  const changed = applyRules(s.transactions, s.rules);
  await writeTxs(changed);
  return changed.length;
}

/* ------------------------------ Consentimentos e limpeza ------------------------------ */

export async function saveConsent(c: ConsentRecord): Promise<void> {
  await financeRepository().putConsent(c);
  const list = getFinance().consents;
  set({ consents: list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c] });
}

export async function removeConsentRecord(id: string): Promise<void> {
  await financeRepository().deleteConsent(id);
  set({ consents: getFinance().consents.filter((c) => c.id !== id) });
}

/** Apaga TODOS os dados financeiros locais. Não revoga consentimentos em instituições externas. */
export async function wipeFinanceData(): Promise<void> {
  await financeRepository().wipe();
  const snap = await financeRepository().load();
  set({ ...checked(snap), status: 'ready' });
  loading = null;
  // Categorias padrão voltam na próxima abertura.
  const cats: Category[] = DEFAULT_CATEGORIES.map((c, i) => ({ id: `cat_default_${i}`, name: c.name, scope: c.scope, builtin: true }));
  await financeRepository().putCategories(cats);
  set({ categories: cats });
}

export function setTestMode(on: boolean) { set({ testMode: on }); }

/* ------------------------------ Autorizações de IA (locais) ------------------------------ */

export async function grantAI(key: string): Promise<void> {
  requireReady();
  const list = [...getFinance().aiGrants.filter((g) => g !== key && !g.startsWith(`${key.split(':')[0]}:`)), key].slice(-MAX_AI_GRANTS);
  await financeRepository().putAIGrants(list);
  set({ aiGrants: list });
}

/** Revoga todas as autorizações de um bloco (qualquer configuração). */
export async function revokeAI(elementId: string): Promise<void> {
  requireReady();
  const list = getFinance().aiGrants.filter((g) => !g.startsWith(`${elementId}:`));
  await financeRepository().putAIGrants(list);
  set({ aiGrants: list });
}

/** Restaura um backup financeiro já validado: só acrescenta, numa transação. */
export async function restoreFinanceBackup(b: FinanceBackup): Promise<{ added: number; skipped: number }> {
  requireReady();
  const { batch, skipped } = planRestore(getFinance(), b);
  await financeRepository().commitRestore(batch);
  await reloadFinance();
  return { added: batch.transactions.length, skipped };
}

/** Substitui o estado a partir do disco (após restaurar backup, por exemplo). */
export async function reloadFinance(): Promise<void> {
  const snap = await financeRepository().load();
  set({ ...checked(snap), status: 'ready', error: null });
}
