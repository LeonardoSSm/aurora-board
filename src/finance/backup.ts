/**
 * Backups financeiros — SEPARADOS dos backups visuais.
 *
 * - `aurora-finance`: dados financeiros explicitamente escolhidos (todas as contas ou algumas). Contém dados
 *   sensíveis; a interface avisa antes de gerar.
 * - `aurora-finance-encrypted`: o mesmo conteúdo cifrado com AES-GCM (256 bits) e chave derivada da senha por
 *   PBKDF2-SHA-256 (600.000 iterações, sal aleatório de 16 bytes, IV de 12 bytes) — Web Crypto, nada inventado.
 *   A senha nunca é gravada; perder a senha torna o arquivo irrecuperável.
 * - `aurora-personal-backup`: quadros + finanças num arquivo só (operação explícita; também pode ser cifrado).
 *
 * Consentimentos de provedores NÃO entram em backups (são vínculos com o ambiente/navegador, sem valor fora dele).
 * A restauração só ACRESCENTA: nada existente é sobrescrito e registros repetidos são ignorados.
 */
import type { BankTransaction, Category, CategoryRule, FinanceSnapshot, FinancialAccount, FinancialInstitution, ImportSession } from './model';
import { FINANCE_SCHEMA_VERSION, MOVEMENT_KINDS, cleanText, isSafeCents, isValidDate } from './model';
import type { RestoreBatch } from './repository';

export const BACKUP_LIMITS = { maxBytes: 150 * 1024 * 1024, maxTransactions: 250_000, maxAccounts: 200, maxImports: 5_000, maxRules: 2_000, maxCategories: 500 };
export const PBKDF2_ITERATIONS = 600_000;

export class BackupError extends Error {}

export interface FinanceBackup {
  format: 'aurora-finance';
  schemaVersion: number;
  exportedAt: number;
  sensitive: true;
  institutions: FinancialInstitution[];
  accounts: FinancialAccount[];
  transactions: BankTransaction[];
  imports: ImportSession[];
  categories: Category[];
  rules: CategoryRule[];
}

export interface EncryptedBackup {
  format: 'aurora-finance-encrypted';
  version: 1;
  /** Conteúdo cifrado: 'finance' ou 'personal'. Não revela dados. */
  content: 'finance' | 'personal';
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

export interface PersonalBackup {
  format: 'aurora-personal-backup';
  version: 1;
  exportedAt: number;
  sensitive: true;
  /** Backup visual no formato `aurora-board` (objeto). */
  boards: unknown;
  finance: FinanceBackup;
}

export function buildFinanceBackup(s: FinanceSnapshot, accountIds?: string[]): FinanceBackup {
  const keep = accountIds?.length ? new Set(accountIds) : null;
  const accounts = s.accounts.filter((a) => !keep || keep.has(a.id));
  const accIds = new Set(accounts.map((a) => a.id));
  const instIds = new Set(accounts.map((a) => a.institutionId));
  return {
    format: 'aurora-finance',
    schemaVersion: FINANCE_SCHEMA_VERSION,
    exportedAt: Date.now(),
    sensitive: true,
    institutions: s.institutions.filter((i) => instIds.has(i.id)),
    accounts,
    transactions: s.transactions.filter((t) => accIds.has(t.accountId)),
    imports: s.imports.filter((i) => accIds.has(i.accountId)),
    categories: s.categories,
    rules: s.rules.filter((r) => !r.accountId || accIds.has(r.accountId)),
  };
}

/* ------------------------------ Validação de backups ------------------------------ */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 200) => (typeof v === 'string' ? cleanText(v, max) : '');
const arr = (v: unknown, max: number, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new BackupError(`Backup inválido: ${what} não é uma lista.`);
  if (v.length > max) throw new BackupError(`Backup recusado: mais de ${max} ${what}.`);
  return v;
};
const id = (v: unknown) => {
  const s = typeof v === 'string' ? v : '';
  if (!/^[\w-]{1,80}$/.test(s)) throw new BackupError('Backup inválido: identificador malformado.');
  return s;
};
const currency = (v: unknown) => (v === 'BRL' || v === 'USD' || v === 'EUR' ? v : (() => { throw new BackupError('Backup inválido: moeda não suportada.'); })());
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const ts = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function vInstitution(r: unknown): FinancialInstitution {
  const o = obj(r);
  return { id: id(o.id), name: str(o.name, 80) || 'Instituição', code: str(o.code, 20) || undefined, type: oneOf(o.type, ['bank', 'payment', 'broker', 'card_issuer', 'other'] as const, 'bank'), status: oneOf(o.status, ['active', 'archived'] as const, 'active'), origin: 'backup', createdAt: ts(o.createdAt), updatedAt: ts(o.updatedAt) };
}

function vAccount(r: unknown, institutions: Set<string>): FinancialAccount {
  const o = obj(r);
  const inst = id(o.institutionId);
  if (!institutions.has(inst)) throw new BackupError('Backup inválido: conta sem instituição.');
  const rb = obj(o.reportedBalance), ob = obj(o.openingBalance), card = obj(o.card);
  const day = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 31 ? v : undefined);
  const cents = (v: unknown) => (isSafeCents(v) ? v : undefined);
  const type = oneOf(o.type, ['checking', 'savings', 'payment', 'investment', 'credit_card', 'other'] as const, 'other');
  return {
    id: id(o.id), institutionId: inst, name: str(o.name, 80) || 'Conta', type, currency: currency(o.currency),
    // Só a forma mascarada é aceita: um número completo vindo de arquivo é reduzido aos 4 últimos dígitos.
    maskedNumber: str(o.maskedNumber, 20).replace(/^.*?(\w{0,4})$/, (_m, last: string) => (last ? `•••• ${last}` : '')),
    status: oneOf(o.status, ['active', 'archived'] as const, 'active'),
    reportedBalance: isSafeCents(rb.cents) && typeof rb.asOf === 'string' && isValidDate(rb.asOf.slice(0, 10)) ? { cents: rb.cents, asOf: rb.asOf.slice(0, 25), origin: 'backup', availableCents: cents(rb.availableCents) } : undefined,
    openingBalance: isSafeCents(ob.cents) && isValidDate(ob.date) ? { cents: ob.cents, date: ob.date } : undefined,
    card: type === 'credit_card' ? { limitCents: cents(card.limitCents), availableLimitCents: cents(card.availableLimitCents), closingDay: day(card.closingDay), dueDay: day(card.dueDay) } : undefined,
    origin: 'backup', createdAt: ts(o.createdAt), lastUpdatedAt: ts(o.lastUpdatedAt),
  };
}

function vTransaction(r: unknown, accounts: Map<string, FinancialAccount>): BankTransaction {
  const o = obj(r);
  const acc = accounts.get(id(o.accountId));
  if (!acc) throw new BackupError('Backup inválido: movimentação de conta inexistente.');
  if (!isSafeCents(o.amountCents) || o.amountCents === 0) throw new BackupError('Backup inválido: valor monetário fora do padrão.');
  if (!isValidDate(o.postedDate)) throw new BackupError('Backup inválido: data inválida.');
  if (o.currency !== acc.currency) throw new BackupError('Backup inválido: moeda da movimentação difere da conta.');
  const loc = obj(o.local), src = obj(o.source), inst = obj(o.installment);
  const dedupeKey = typeof o.dedupeKey === 'string' && o.dedupeKey.length <= 300 ? o.dedupeKey : '';
  if (!dedupeKey) throw new BackupError('Backup inválido: chave de deduplicação ausente.');
  const srcKind = oneOf(src.kind, ['manual', 'csv', 'ofx', 'provider', 'backup'] as const, 'backup');
  const sources = ['default', 'rule', 'user', 'reconcile', 'provider'] as const;
  return {
    id: id(o.id), accountId: acc.id,
    source: { kind: srcKind, importId: typeof src.importId === 'string' ? id(src.importId) : undefined, fileName: str(src.fileName, 120) || undefined, providerId: str(src.providerId, 60) || undefined },
    externalId: str(o.externalId, 120) || undefined, dedupeKey,
    operationDate: isValidDate(o.operationDate) ? o.operationDate : undefined, postedDate: o.postedDate,
    description: str(o.description, 300) || '(sem descrição)', memo: str(o.memo, 300) || undefined,
    amountCents: o.amountCents, currency: acc.currency, direction: o.amountCents >= 0 ? 'credit' : 'debit',
    rawType: str(o.rawType, 40) || undefined, status: o.status === 'pending' ? 'pending' : 'posted', reference: str(o.reference, 60) || undefined,
    installment: Number.isInteger(inst.index) && Number.isInteger(inst.count) && (inst.count as number) <= 120 ? { index: inst.index as number, count: inst.count as number } : undefined,
    importedAt: ts(o.importedAt),
    local: {
      kind: oneOf(loc.kind, MOVEMENT_KINDS, 'unclassified'), category: str(loc.category, 60) || 'Sem categoria',
      kindSource: oneOf(loc.kindSource, sources, 'default'), categorySource: oneOf(loc.categorySource, sources, 'default'),
      linkId: typeof loc.linkId === 'string' ? id(loc.linkId) : undefined, linkedTxId: typeof loc.linkedTxId === 'string' ? id(loc.linkedTxId) : undefined,
      note: str(loc.note, 300) || undefined, updatedAt: ts(loc.updatedAt) || undefined,
    },
  };
}

function vImport(r: unknown, accounts: Map<string, FinancialAccount>): ImportSession {
  const o = obj(r), c = obj(o.counts);
  const accountId = id(o.accountId);
  if (!accounts.has(accountId)) throw new BackupError('Backup inválido: importação de conta inexistente.');
  const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
  return {
    id: id(o.id), origin: oneOf(o.origin, ['csv', 'ofx', 'provider', 'backup', 'manual'] as const, 'backup'), fileName: str(o.fileName, 120) || undefined,
    createdAt: ts(o.createdAt), accountId, status: o.status === 'reverted' ? 'reverted' : 'committed',
    counts: { read: n(c.read), accepted: n(c.accepted), duplicate: n(c.duplicate), ignored: n(c.ignored), conflict: n(c.conflict), invalid: n(c.invalid), updated: n(c.updated) },
    warnings: (Array.isArray(o.warnings) ? o.warnings : []).slice(0, 50).map((w) => str(w, 300)),
    errors: (Array.isArray(o.errors) ? o.errors : []).slice(0, 50).map((w) => str(w, 300)),
  };
}

/** Valida e saneia um backup financeiro (já decifrado). Nunca confia no arquivo. */
export function validateFinanceBackup(raw: unknown): FinanceBackup {
  const o = obj(raw);
  if (o.format !== 'aurora-finance') throw new BackupError('Não é um backup financeiro do Aurora Board.');
  const v = typeof o.schemaVersion === 'number' ? o.schemaVersion : 0;
  if (!Number.isInteger(v) || v < 1) throw new BackupError('Backup financeiro com versão inválida.');
  if (v > FINANCE_SCHEMA_VERSION) throw new BackupError(`Backup gerado por uma versão mais nova do módulo financeiro (${v}). Atualize o Aurora Board antes de restaurar.`);
  const institutions = arr(o.institutions, BACKUP_LIMITS.maxAccounts, 'instituições').map(vInstitution);
  const instIds = new Set(institutions.map((i) => i.id));
  const accounts = arr(o.accounts, BACKUP_LIMITS.maxAccounts, 'contas').map((a) => vAccount(a, instIds));
  const accMap = new Map(accounts.map((a) => [a.id, a]));
  const transactions = arr(o.transactions, BACKUP_LIMITS.maxTransactions, 'movimentações').map((t) => vTransaction(t, accMap));
  const imports = arr(o.imports, BACKUP_LIMITS.maxImports, 'importações').map((i) => vImport(i, accMap));
  const categories = arr(o.categories, BACKUP_LIMITS.maxCategories, 'categorias').map((c) => { const x = obj(c); return { id: id(x.id), name: str(x.name, 60) || 'Categoria', scope: oneOf(x.scope, ['expense', 'income', 'any'] as const, 'any'), builtin: x.builtin === true }; });
  const rules = arr(o.rules, BACKUP_LIMITS.maxRules, 'regras').map((r) => {
    const x = obj(r);
    const accountId = typeof x.accountId === 'string' ? id(x.accountId) : undefined;
    return { id: id(x.id), match: str(x.match, 80), category: str(x.category, 60) || undefined, kind: x.kind ? oneOf(x.kind, MOVEMENT_KINDS, 'unclassified') : undefined, accountId: accountId && accMap.has(accountId) ? accountId : undefined, enabled: x.enabled !== false, createdAt: ts(x.createdAt) };
  }).filter((r) => r.match);
  return { format: 'aurora-finance', schemaVersion: FINANCE_SCHEMA_VERSION, exportedAt: ts(o.exportedAt), sensitive: true, institutions, accounts, transactions, imports, categories, rules };
}

/** Calcula o que a restauração acrescenta (registros já existentes são ignorados; nada é sobrescrito). */
export function planRestore(current: FinanceSnapshot, b: FinanceBackup): { batch: RestoreBatch; skipped: number } {
  const has = <T extends { id: string }>(list: T[]) => new Set(list.map((x) => x.id));
  const ins = has(current.institutions), acc = has(current.accounts), tx = has(current.transactions), imp = has(current.imports), rul = has(current.rules);
  const catNames = new Set(current.categories.map((c) => c.name.toLowerCase()));
  const keys = new Set(current.transactions.map((t) => `${t.accountId}|${t.dedupeKey}`));
  let skipped = 0;
  const pick = <T,>(list: T[], keep: (x: T) => boolean) => list.filter((x) => (keep(x) ? true : (skipped++, false)));
  const transactions = pick(b.transactions, (t) => {
    const k = `${t.accountId}|${t.dedupeKey}`;
    if (tx.has(t.id) || keys.has(k)) return false;
    keys.add(k);
    return true;
  });
  return {
    batch: {
      institutions: pick(b.institutions, (i) => !ins.has(i.id)),
      accounts: pick(b.accounts, (a) => !acc.has(a.id)),
      transactions,
      imports: pick(b.imports, (i) => !imp.has(i.id)),
      categories: b.categories.filter((c) => !catNames.has(c.name.toLowerCase()) && !current.categories.some((x) => x.id === c.id)),
      rules: pick(b.rules, (r) => !rul.has(r.id)),
    },
    skipped,
  };
}

/* ------------------------------ Cifra (Web Crypto) ------------------------------ */

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function checkPassword(password: string): string | null {
  if (password.length < 10) return 'Use uma senha com pelo menos 10 caracteres.';
  if (password.length > 512) return 'Senha longa demais.';
  return null;
}

export async function encryptBackup(plaintext: string, password: string, content: EncryptedBackup['content'], iterations = PBKDF2_ITERATIONS): Promise<EncryptedBackup> {
  const err = checkPassword(password);
  if (err) throw new BackupError(err);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  return { format: 'aurora-finance-encrypted', version: 1, content, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv) }, data: b64(data) };
}

export async function decryptBackup(file: unknown, password: string): Promise<{ content: EncryptedBackup['content']; plaintext: string }> {
  const o = obj(file);
  const kdf = obj(o.kdf), cipher = obj(o.cipher);
  if (o.format !== 'aurora-finance-encrypted' || o.version !== 1 || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || cipher.name !== 'AES-GCM') throw new BackupError('Arquivo cifrado em formato desconhecido.');
  const iterations = kdf.iterations;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) throw new BackupError('Parâmetros de cifra fora do padrão.');
  if (typeof kdf.salt !== 'string' || typeof cipher.iv !== 'string' || typeof o.data !== 'string') throw new BackupError('Arquivo cifrado incompleto.');
  try {
    const key = await deriveKey(password, unb64(kdf.salt), iterations);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(cipher.iv) as BufferSource }, key, unb64(o.data) as BufferSource);
    return { content: o.content === 'personal' ? 'personal' : 'finance', plaintext: new TextDecoder().decode(plain) };
  } catch {
    // Mesma mensagem para senha errada e arquivo alterado (AES-GCM autentica o conteúdo).
    throw new BackupError('Senha incorreta ou arquivo corrompido.');
  }
}

/** Lê um arquivo de backup (texto) e devolve o backup financeiro e, se for completo, a parte visual. */
export async function readBackupFile(text: string, password?: string): Promise<{ finance: FinanceBackup; boards?: unknown; encrypted: boolean }> {
  if (text.length > BACKUP_LIMITS.maxBytes) throw new BackupError('Arquivo grande demais.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new BackupError('O arquivo não é um JSON válido.'); }
  let encrypted = false;
  if (obj(data).format === 'aurora-finance-encrypted') {
    if (!password) throw new BackupError('Este backup é cifrado: informe a senha.');
    const { plaintext } = await decryptBackup(data, password);
    encrypted = true;
    try { data = JSON.parse(plaintext); } catch { throw new BackupError('Conteúdo cifrado inválido.'); }
  }
  const o = obj(data);
  if (o.format === 'aurora-personal-backup') return { finance: validateFinanceBackup(o.finance), boards: o.boards, encrypted };
  if (o.format === 'aurora-board') throw new BackupError('Este é um backup visual (quadros): use Importar → Arquivo JSON na barra superior.');
  return { finance: validateFinanceBackup(data), encrypted };
}
