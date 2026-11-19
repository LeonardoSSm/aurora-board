/**
 * Persistência do razão financeiro — banco IndexedDB SEPARADO (`aurora-finance`), independente dos quadros.
 *
 * - Escritas compostas (importação, reversão, exclusão de conta, apagar tudo) numa única transação: ou tudo,
 *   ou nada. O adaptador em memória clona tudo antes de alterar, com o mesmo efeito (usado nos testes).
 * - Índices: transações por conta, por conta+data, por importação e por conta+chave de deduplicação.
 * - Limites de armazenamento explícitos; exceder recusa a gravação inteira (sem truncar).
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { BankTransaction, Category, CategoryRule, ConsentRecord, FinanceSnapshot, FinancialAccount, FinancialInstitution, ImportSession } from './model';
import { FINANCE_SCHEMA_VERSION } from './model';

export const FINANCE_DB_NAME = 'aurora-finance';
const DB_VERSION = 1;

export const STORAGE_LIMITS = { maxTransactions: 250_000, maxAccounts: 200, maxImports: 5_000 };

export class FinanceStorageError extends Error {}

export interface ImportCommit {
  session: ImportSession;
  add: BankTransaction[];
  update: BankTransaction[];
  institutions?: FinancialInstitution[];
  accounts?: FinancialAccount[];
}

export interface FinanceRepository {
  readonly name: string;
  load(): Promise<FinanceSnapshot>;
  putInstitution(i: FinancialInstitution): Promise<void>;
  putAccount(a: FinancialAccount): Promise<void>;
  putCategories(c: Category[]): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  putRule(r: CategoryRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
  putConsent(c: ConsentRecord): Promise<void>;
  deleteConsent(id: string): Promise<void>;
  /** Atômica. */
  commitImport(c: ImportCommit): Promise<void>;
  /** Atômica (classificação local, conciliação, status). */
  updateTransactions(txs: BankTransaction[]): Promise<void>;
  /** Atômica: remove o que a importação criou e restaura o que ela atualizou. */
  revertImport(importId: string): Promise<{ removed: number; restored: number }>;
  /** Atômica: conta + transações + importações dela. */
  deleteAccount(accountId: string): Promise<{ removed: number }>;
  deleteTransactions(ids: string[]): Promise<void>;
  /** Apaga todos os dados financeiros locais (mantém só o identificador do razão). */
  wipe(): Promise<void>;
}

interface FinanceDB extends DBSchema {
  meta: { key: string; value: { key: string; value: unknown } };
  institutions: { key: string; value: FinancialInstitution };
  accounts: { key: string; value: FinancialAccount };
  transactions: { key: string; value: BankTransaction; indexes: { byAccount: string; byAccountDate: [string, string]; byImport: string; byDedupe: [string, string] } };
  imports: { key: string; value: ImportSession; indexes: { byAccount: string } };
  consents: { key: string; value: ConsentRecord };
  categories: { key: string; value: Category };
  rules: { key: string; value: CategoryRule };
}

function newLedgerId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `ledger_${r.replace(/-/g, '').slice(0, 20)}`;
}

/** Pré-condições comuns: limites e coerência mínima antes de qualquer escrita. */
function checkCommit(current: { transactions: number; imports: number; accounts: number }, c: ImportCommit) {
  if (current.transactions + c.add.length > STORAGE_LIMITS.maxTransactions) throw new FinanceStorageError(`Limite local de ${STORAGE_LIMITS.maxTransactions} movimentações atingido. Nada foi gravado.`);
  if (current.imports + 1 > STORAGE_LIMITS.maxImports) throw new FinanceStorageError('Limite de histórico de importações atingido. Nada foi gravado.');
  if (current.accounts + (c.accounts?.length ?? 0) > STORAGE_LIMITS.maxAccounts) throw new FinanceStorageError('Limite de contas atingido. Nada foi gravado.');
  for (const t of [...c.add, ...c.update]) if (!Number.isSafeInteger(t.amountCents)) throw new FinanceStorageError('Valor monetário inválido. Nada foi gravado.');
  structuredClone(c); // estrutura não clonável aborta antes de abrir a transação
}

export class IndexedDBFinanceRepository implements FinanceRepository {
  readonly name = 'indexeddb';
  private dbp: Promise<IDBPDatabase<FinanceDB>>;

  constructor(dbName = FINANCE_DB_NAME) {
    this.dbp = openDB<FinanceDB>(dbName, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('institutions', { keyPath: 'id' });
          db.createObjectStore('accounts', { keyPath: 'id' });
          const tx = db.createObjectStore('transactions', { keyPath: 'id' });
          tx.createIndex('byAccount', 'accountId');
          tx.createIndex('byAccountDate', ['accountId', 'postedDate']);
          tx.createIndex('byImport', 'source.importId');
          tx.createIndex('byDedupe', ['accountId', 'dedupeKey']);
          const im = db.createObjectStore('imports', { keyPath: 'id' });
          im.createIndex('byAccount', 'accountId');
          db.createObjectStore('consents', { keyPath: 'id' });
          db.createObjectStore('categories', { keyPath: 'id' });
          db.createObjectStore('rules', { keyPath: 'id' });
        }
        // Próximas versões: migrações aditivas aqui (nunca apagar stores com dados).
      },
    });
  }

  private async ledgerId(db: IDBPDatabase<FinanceDB>): Promise<string> {
    const cur = await db.get('meta', 'ledgerId');
    if (typeof cur?.value === 'string') return cur.value;
    const id = newLedgerId();
    await db.put('meta', { key: 'ledgerId', value: id });
    await db.put('meta', { key: 'schemaVersion', value: FINANCE_SCHEMA_VERSION });
    return id;
  }

  async load(): Promise<FinanceSnapshot> {
    const db = await this.dbp;
    const ledgerId = await this.ledgerId(db);
    const tx = db.transaction(['institutions', 'accounts', 'transactions', 'imports', 'consents', 'categories', 'rules'], 'readonly');
    const [institutions, accounts, transactions, imports, consents, categories, rules] = await Promise.all([
      tx.objectStore('institutions').getAll(),
      tx.objectStore('accounts').getAll(),
      tx.objectStore('transactions').getAll(),
      tx.objectStore('imports').getAll(),
      tx.objectStore('consents').getAll(),
      tx.objectStore('categories').getAll(),
      tx.objectStore('rules').getAll(),
    ]);
    await tx.done;
    return { ledgerId, institutions, accounts, transactions, imports, consents, categories, rules };
  }

  async putInstitution(i: FinancialInstitution) { await (await this.dbp).put('institutions', i); }
  async putAccount(a: FinancialAccount) { await (await this.dbp).put('accounts', a); }
  async putCategories(cs: Category[]) {
    const db = await this.dbp;
    const tx = db.transaction('categories', 'readwrite');
    await Promise.all([...cs.map((c) => tx.store.put(c)), tx.done]);
  }
  async deleteCategory(id: string) { await (await this.dbp).delete('categories', id); }
  async putRule(r: CategoryRule) { await (await this.dbp).put('rules', r); }
  async deleteRule(id: string) { await (await this.dbp).delete('rules', id); }
  async putConsent(c: ConsentRecord) { await (await this.dbp).put('consents', c); }
  async deleteConsent(id: string) { await (await this.dbp).delete('consents', id); }

  /** Executa `fn` numa transação readwrite; qualquer erro aborta tudo e é relançado. */
  private async atomic<T>(stores: StoreNames<FinanceDB>[], fn: (tx: IDBPTransaction<FinanceDB, StoreNames<FinanceDB>[], 'readwrite'>) => Promise<T>): Promise<T> {
    const db = await this.dbp;
    const tx = db.transaction(stores, 'readwrite');
    tx.done.catch(() => undefined);
    try {
      const r = await fn(tx);
      await tx.done;
      return r;
    } catch (e) {
      try { tx.abort(); } catch { /* já abortada */ }
      throw e;
    }
  }

  async commitImport(c: ImportCommit) {
    const db = await this.dbp;
    const [transactions, imports, accounts] = await Promise.all([db.count('transactions'), db.count('imports'), db.count('accounts')]);
    checkCommit({ transactions, imports, accounts }, c);
    await this.atomic(['transactions', 'imports', 'institutions', 'accounts'], async (tx) => {
      const ts = tx.objectStore('transactions');
      for (const t of c.add) {
        // Defesa em profundidade: a mesma chave na mesma conta nunca entra duas vezes.
        const dup = await ts.index('byDedupe').getKey([t.accountId, t.dedupeKey]);
        if (dup) throw new FinanceStorageError('Movimentação duplicada detectada na gravação. Nada foi gravado.');
        await ts.add(t);
      }
      for (const t of c.update) await ts.put(t);
      for (const i of c.institutions ?? []) await tx.objectStore('institutions').put(i);
      for (const a of c.accounts ?? []) await tx.objectStore('accounts').put(a);
      await tx.objectStore('imports').put(c.session);
    });
  }

  async updateTransactions(txs: BankTransaction[]) {
    if (!txs.length) return;
    structuredClone(txs);
    await this.atomic(['transactions'], async (tx) => {
      for (const t of txs) {
        const cur = await tx.objectStore('transactions').get(t.id);
        if (!cur) throw new FinanceStorageError('Movimentação inexistente. Nada foi gravado.');
        await tx.objectStore('transactions').put(t);
      }
    });
  }

  async revertImport(importId: string) {
    return this.atomic(['transactions', 'imports'], async (tx) => {
      const session = await tx.objectStore('imports').get(importId);
      if (!session) throw new FinanceStorageError('Importação não encontrada.');
      if (session.status === 'reverted') return { removed: 0, restored: 0 };
      const ts = tx.objectStore('transactions');
      const keys = await ts.index('byImport').getAllKeys(importId);
      for (const k of keys) await ts.delete(k);
      let restored = 0;
      for (const u of session.updatedTx ?? []) {
        const t = await ts.get(u.id);
        if (!t) continue;
        await ts.put({ ...t, status: u.prevStatus, postedDate: u.prevPostedDate, dedupeKey: u.prevDedupeKey, externalId: u.prevExternalId });
        restored++;
      }
      await tx.objectStore('imports').put({ ...session, status: 'reverted', revertedAt: Date.now() });
      return { removed: keys.length, restored };
    });
  }

  async deleteAccount(accountId: string) {
    return this.atomic(['transactions', 'imports', 'accounts'], async (tx) => {
      const ts = tx.objectStore('transactions');
      const keys = await ts.index('byAccount').getAllKeys(accountId);
      for (const k of keys) await ts.delete(k);
      const imps = await tx.objectStore('imports').index('byAccount').getAllKeys(accountId);
      for (const k of imps) await tx.objectStore('imports').delete(k);
      await tx.objectStore('accounts').delete(accountId);
      return { removed: keys.length };
    });
  }

  async deleteTransactions(ids: string[]) {
    await this.atomic(['transactions'], async (tx) => { for (const id of ids) await tx.objectStore('transactions').delete(id); });
  }

  async wipe() {
    await this.atomic(['institutions', 'accounts', 'transactions', 'imports', 'consents', 'categories', 'rules'], async (tx) => {
      for (const s of ['institutions', 'accounts', 'transactions', 'imports', 'consents', 'categories', 'rules'] as const) await tx.objectStore(s).clear();
    });
  }
}

/** Mesmo contrato em memória (testes e fallback quando o IndexedDB não abre). */
export class MemoryFinanceRepository implements FinanceRepository {
  readonly name = 'memory';
  ledgerIdValue = newLedgerId();
  institutions = new Map<string, FinancialInstitution>();
  accounts = new Map<string, FinancialAccount>();
  transactions = new Map<string, BankTransaction>();
  imports = new Map<string, ImportSession>();
  consents = new Map<string, ConsentRecord>();
  categories = new Map<string, Category>();
  rules = new Map<string, CategoryRule>();
  /** Para testes: a próxima gravação composta falha no meio. */
  failNextWrite = false;

  private maybeFail() {
    if (this.failNextWrite) { this.failNextWrite = false; throw new FinanceStorageError('Falha simulada de gravação.'); }
  }

  async load(): Promise<FinanceSnapshot> {
    const c = <T,>(m: Map<string, T>) => [...m.values()].map((v) => structuredClone(v));
    return { ledgerId: this.ledgerIdValue, institutions: c(this.institutions), accounts: c(this.accounts), transactions: c(this.transactions), imports: c(this.imports), consents: c(this.consents), categories: c(this.categories), rules: c(this.rules) };
  }
  async putInstitution(i: FinancialInstitution) { this.institutions.set(i.id, structuredClone(i)); }
  async putAccount(a: FinancialAccount) { this.accounts.set(a.id, structuredClone(a)); }
  async putCategories(cs: Category[]) { for (const c of cs) this.categories.set(c.id, structuredClone(c)); }
  async deleteCategory(id: string) { this.categories.delete(id); }
  async putRule(r: CategoryRule) { this.rules.set(r.id, structuredClone(r)); }
  async deleteRule(id: string) { this.rules.delete(id); }
  async putConsent(c: ConsentRecord) { this.consents.set(c.id, structuredClone(c)); }
  async deleteConsent(id: string) { this.consents.delete(id); }

  async commitImport(c: ImportCommit) {
    checkCommit({ transactions: this.transactions.size, imports: this.imports.size, accounts: this.accounts.size }, c);
    const staged = structuredClone(c);
    const keys = new Set([...this.transactions.values()].map((t) => `${t.accountId}|${t.dedupeKey}`));
    for (const t of staged.add) {
      const k = `${t.accountId}|${t.dedupeKey}`;
      if (keys.has(k) || this.transactions.has(t.id)) throw new FinanceStorageError('Movimentação duplicada detectada na gravação. Nada foi gravado.');
      keys.add(k);
    }
    this.maybeFail();
    for (const t of staged.add) this.transactions.set(t.id, t);
    for (const t of staged.update) this.transactions.set(t.id, t);
    for (const i of staged.institutions ?? []) this.institutions.set(i.id, i);
    for (const a of staged.accounts ?? []) this.accounts.set(a.id, a);
    this.imports.set(staged.session.id, staged.session);
  }
  async updateTransactions(txs: BankTransaction[]) {
    for (const t of txs) if (!this.transactions.has(t.id)) throw new FinanceStorageError('Movimentação inexistente. Nada foi gravado.');
    const staged = structuredClone(txs);
    this.maybeFail();
    for (const t of staged) this.transactions.set(t.id, t);
  }
  async revertImport(importId: string) {
    const s = this.imports.get(importId);
    if (!s) throw new FinanceStorageError('Importação não encontrada.');
    if (s.status === 'reverted') return { removed: 0, restored: 0 };
    this.maybeFail();
    let removed = 0, restored = 0;
    for (const [id, t] of this.transactions) if (t.source.importId === importId) { this.transactions.delete(id); removed++; }
    for (const u of s.updatedTx ?? []) {
      const t = this.transactions.get(u.id);
      if (!t) continue;
      this.transactions.set(u.id, { ...t, status: u.prevStatus, postedDate: u.prevPostedDate, dedupeKey: u.prevDedupeKey, externalId: u.prevExternalId });
      restored++;
    }
    this.imports.set(importId, { ...s, status: 'reverted', revertedAt: Date.now() });
    return { removed, restored };
  }
  async deleteAccount(accountId: string) {
    this.maybeFail();
    let removed = 0;
    for (const [id, t] of this.transactions) if (t.accountId === accountId) { this.transactions.delete(id); removed++; }
    for (const [id, s] of this.imports) if (s.accountId === accountId) this.imports.delete(id);
    this.accounts.delete(accountId);
    return { removed };
  }
  async deleteTransactions(ids: string[]) { this.maybeFail(); for (const id of ids) this.transactions.delete(id); }
  async wipe() {
    this.maybeFail();
    for (const m of [this.institutions, this.accounts, this.transactions, this.imports, this.consents, this.categories, this.rules]) (m as Map<string, unknown>).clear();
  }
}
