/**
 * Planejamento de importação: decide, SEM gravar nada, o que cada linha do arquivo vira.
 *
 * Identidade de uma movimentação dentro da conta (`dedupeKey`):
 * - com ID da fonte (FITID/id do provedor): `ext:<id>`;
 * - sem ID: `fp:<data>|<centavos>|<descrição normalizada>#<n>`, onde `n` é a ocorrência dessa impressão
 *   digital dentro do arquivo. Duas compras legítimas iguais no mesmo dia viram `#1` e `#2` (as duas entram);
 *   reimportar o arquivo gera as mesmas chaves (nenhuma entra de novo); um arquivo sobreposto com o mesmo
 *   dia gera as mesmas chaves para as ocorrências já vistas.
 *
 * Valor + data, sozinhos, nunca descartam uma linha: com descrição diferente é só um alerta (“possível
 * duplicidade”) e a linha continua marcada para importar. Com a mesma descrição vinda de OUTRO esquema de
 * identidade (ex.: OFX já importado e agora CSV do mesmo período) a linha vai para revisão desmarcada.
 * Lançamentos manuais nunca são tocados.
 */
import type { Currency } from '../core/finance';
import type { BankTransaction, CategoryRule, FinancialAccount, ImportCounts, ImportOrigin, ImportSession, ReportedBalance } from './model';
import { cleanText, normalizeDesc } from './model';
import type { InvalidRow, IgnoredRow, TransactionDraft } from './drafts';
import { rangeOf } from './drafts';
import { daysBetween } from './parsing';
import { classifyNew } from './classify';

export type PlanStatus = 'new' | 'duplicate' | 'conflict' | 'pending-update' | 'possible-duplicate';

export interface PlanItem {
  draft: TransactionDraft;
  dedupeKey: string;
  status: PlanStatus;
  /** Transação existente relacionada (duplicata, conflito, pendente a atualizar). */
  existingId?: string;
  reason?: string;
  /** Alerta não bloqueante (ex.: mesmo valor e data com descrição diferente). */
  warning?: string;
  /** Decisão: entra na importação? (o usuário pode mudar na revisão). */
  include: boolean;
}

export interface ImportPlan {
  accountId: string;
  currency: Currency;
  items: PlanItem[];
  invalid: InvalidRow[];
  ignored: IgnoredRow[];
  warnings: string[];
  range?: { from: string; to: string };
  totals: { inCents: number; outCents: number; newCount: number; duplicateCount: number; conflictCount: number; possibleDuplicateCount: number; pendingUpdateCount: number };
}

export function fingerprint(d: Pick<TransactionDraft, 'postedDate' | 'amountCents' | 'description'>): string {
  return `${d.postedDate}|${d.amountCents}|${normalizeDesc(d.description).slice(0, 80)}`;
}

/** Chaves para todas as linhas, na ordem do arquivo. */
export function dedupeKeys(drafts: TransactionDraft[]): string[] {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    if (d.externalId) return `ext:${d.externalId}`;
    const fp = fingerprint(d);
    const n = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, n);
    return `fp:${fp}#${n}`;
  });
}

export function planImport(input: {
  account: Pick<FinancialAccount, 'id' | 'currency' | 'type'>;
  drafts: TransactionDraft[];
  existing: BankTransaction[];
  invalid?: InvalidRow[];
  ignored?: IgnoredRow[];
  warnings?: string[];
}): ImportPlan {
  const { account, drafts } = input;
  const existing = input.existing.filter((t) => t.accountId === account.id);
  const byKey = new Map(existing.map((t) => [t.dedupeKey, t]));
  const keys = dedupeKeys(drafts);
  const warnings = [...(input.warnings ?? [])];
  const invalid = [...(input.invalid ?? [])];
  // Candidatos a duplicidade entre esquemas diferentes (consumidos uma vez cada).
  const strongPool = new Map<string, BankTransaction[]>();
  for (const t of existing) {
    if (t.source.kind === 'manual') continue;
    const k = fingerprint(t);
    strongPool.set(k, [...(strongPool.get(k) ?? []), t]);
  }
  const pendings = existing.filter((t) => t.status === 'pending');
  const usedPending = new Set<string>();
  const inFile = new Set<string>();
  const items: PlanItem[] = [];

  drafts.forEach((d, i) => {
    const key = keys[i];
    if (d.currency && d.currency !== account.currency) {
      invalid.push({ line: d.line, reason: `Moeda ${d.currency} diferente da conta (${account.currency}); sem conversão automática.` });
      return;
    }
    if (inFile.has(key)) {
      items.push({ draft: d, dedupeKey: key, status: 'duplicate', reason: 'Repetida no próprio arquivo (mesmo identificador).', include: false });
      return;
    }
    inFile.add(key);
    const hit = byKey.get(key);
    if (hit) {
      if (hit.status === 'pending' && d.status === 'posted') {
        items.push({ draft: d, dedupeKey: key, status: 'pending-update', existingId: hit.id, reason: 'Pendente agora contabilizada: o registro existente será atualizado.', include: true });
        usedPending.add(hit.id);
        return;
      }
      if (hit.amountCents !== d.amountCents || hit.postedDate !== d.postedDate) {
        if (hit.amountCents === d.amountCents && hit.status === 'posted' && d.status === 'pending') {
          items.push({ draft: d, dedupeKey: key, status: 'duplicate', existingId: hit.id, reason: 'Já importada como contabilizada.', include: false });
          return;
        }
        items.push({ draft: d, dedupeKey: key, status: 'conflict', existingId: hit.id, reason: `Mesmo identificador com dados diferentes (gravado: ${hit.postedDate}, ${hit.amountCents} centavos).`, include: false });
        return;
      }
      items.push({ draft: d, dedupeKey: key, status: 'duplicate', existingId: hit.id, reason: 'Já importada.', include: false });
      return;
    }
    // Pendente existente que agora chega contabilizada com outro identificador.
    if (d.status === 'posted') {
      const p = pendings.find((t) => !usedPending.has(t.id) && t.amountCents === d.amountCents && normalizeDesc(t.description) === normalizeDesc(d.description) && Math.abs(daysBetween(t.postedDate, d.postedDate)) <= 5);
      if (p) {
        usedPending.add(p.id);
        items.push({ draft: d, dedupeKey: key, status: 'pending-update', existingId: p.id, reason: 'Pendente agora contabilizada: o registro existente será atualizado.', include: true });
        return;
      }
    }
    const fp = fingerprint(d);
    const pool = strongPool.get(fp);
    if (pool?.length) {
      const t = pool.shift()!;
      items.push({ draft: d, dedupeKey: key, status: 'possible-duplicate', existingId: t.id, reason: 'Mesma data, valor e descrição de um registro de outra importação. Marque para importar se forem movimentações diferentes.', include: false });
      return;
    }
    const weak = existing.find((t) => t.amountCents === d.amountCents && Math.abs(daysBetween(t.postedDate, d.postedDate)) <= 1 && t.source.kind !== 'manual');
    items.push({ draft: d, dedupeKey: key, status: 'new', include: true, warning: weak ? `Mesmo valor e data próxima de “${cleanText(weak.description, 40)}” — confira se não é a mesma movimentação.` : undefined });
  });

  const totals = { inCents: 0, outCents: 0, newCount: 0, duplicateCount: 0, conflictCount: 0, possibleDuplicateCount: 0, pendingUpdateCount: 0 };
  for (const it of items) {
    if (it.status === 'new') totals.newCount++;
    else if (it.status === 'duplicate') totals.duplicateCount++;
    else if (it.status === 'conflict') totals.conflictCount++;
    else if (it.status === 'possible-duplicate') totals.possibleDuplicateCount++;
    else totals.pendingUpdateCount++;
    if (it.status === 'new' || it.status === 'possible-duplicate') {
      if (it.draft.amountCents > 0) totals.inCents += it.draft.amountCents;
      else totals.outCents += -it.draft.amountCents;
    }
  }
  return { accountId: account.id, currency: account.currency, items, invalid, ignored: input.ignored ?? [], warnings, range: rangeOf(drafts), totals };
}

/** Converte o plano revisado em gravações. Pura: quem grava é o repositório, numa transação. */
export function materializePlan(plan: ImportPlan, ctx: {
  account: Pick<FinancialAccount, 'id' | 'currency' | 'type'>;
  origin: ImportOrigin;
  importId: string;
  fileName?: string;
  providerId?: string;
  now: number;
  newId: () => string;
  rules: CategoryRule[];
  categories: string[];
  existing: BankTransaction[];
  reportedBalance?: ReportedBalance;
}): { add: BankTransaction[]; update: BankTransaction[]; session: ImportSession } {
  const add: BankTransaction[] = [];
  const update: BankTransaction[] = [];
  const updatedTx: NonNullable<ImportSession['updatedTx']> = [];
  const byId = new Map(ctx.existing.map((t) => [t.id, t]));
  const counts: ImportCounts = { read: plan.items.length + plan.invalid.length + plan.ignored.length, accepted: 0, duplicate: 0, ignored: plan.ignored.length, conflict: 0, invalid: plan.invalid.length, updated: 0 };
  const usedKeys = new Set(ctx.existing.filter((t) => t.accountId === ctx.account.id).map((t) => t.dedupeKey));
  for (const it of plan.items) {
    if (it.status === 'duplicate') { counts.duplicate++; continue; }
    if (it.status === 'conflict' && !it.include) { counts.conflict++; continue; }
    if (it.status === 'pending-update' && it.include && it.existingId) {
      const prev = byId.get(it.existingId);
      if (!prev) continue;
      // A própria fonte atualizou o registro (pendente → contabilizado): mesma identidade local, nova chave
      // para que a próxima importação do extrato definitivo a reconheça como já importada.
      const newKey = it.dedupeKey !== prev.dedupeKey && !usedKeys.has(it.dedupeKey) ? it.dedupeKey : prev.dedupeKey;
      usedKeys.add(newKey);
      update.push({ ...prev, status: 'posted', postedDate: it.draft.postedDate, externalId: it.draft.externalId ?? prev.externalId, dedupeKey: newKey });
      updatedTx.push({ id: prev.id, prevStatus: prev.status, prevPostedDate: prev.postedDate, prevDedupeKey: prev.dedupeKey, prevExternalId: prev.externalId });
      counts.updated++;
      continue;
    }
    if (!it.include) { if (it.status === 'possible-duplicate') counts.duplicate++; else counts.ignored++; continue; }
    // Conflito ou possível duplicidade aceitos pelo usuário: entram com chave própria (não substituem o existente).
    let key = it.dedupeKey;
    if (usedKeys.has(key)) { let n = 2; while (usedKeys.has(`${key}~${n}`)) n++; key = `${key}~${n}`; }
    usedKeys.add(key);
    const d = it.draft;
    add.push({
      id: ctx.newId(),
      accountId: ctx.account.id,
      source: { kind: ctx.origin === 'backup' ? 'backup' : ctx.origin, importId: ctx.importId, fileName: ctx.fileName, providerId: ctx.providerId },
      externalId: d.externalId,
      dedupeKey: key,
      operationDate: d.operationDate,
      postedDate: d.postedDate,
      description: d.description,
      memo: d.memo,
      amountCents: d.amountCents,
      currency: ctx.account.currency,
      direction: d.amountCents >= 0 ? 'credit' : 'debit',
      rawType: d.rawType,
      status: d.status,
      reference: d.reference,
      installment: d.installment,
      importedAt: ctx.now,
      local: classifyNew(d, ctx.account, ctx.rules, ctx.categories),
    });
    counts.accepted++;
  }
  const session: ImportSession = {
    id: ctx.importId,
    origin: ctx.origin,
    fileName: ctx.fileName,
    providerId: ctx.providerId,
    createdAt: ctx.now,
    accountId: ctx.account.id,
    counts,
    status: 'committed',
    range: plan.range,
    reportedBalance: ctx.reportedBalance,
    warnings: plan.warnings.slice(0, 50),
    errors: plan.invalid.slice(0, 50).map((r) => `Linha ${r.line}: ${r.reason}`),
    updatedTx: updatedTx.length ? updatedTx : undefined,
  };
  return { add, update, session };
}

/** Nome de arquivo sem caminho, sem controles, limitado (não confiável). */
export function safeImportFileName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  return cleanText(base, 120).replace(/[<>:"|?*]/g, '_') || 'extrato';
}
