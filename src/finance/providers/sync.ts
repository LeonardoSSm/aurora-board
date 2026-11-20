/**
 * Orquestração provedor → razão. Usa EXATAMENTE o mesmo planejador de importação dos arquivos
 * (deduplicação por id do provedor, pendente → contabilizada, conciliação automática conservadora).
 *
 * Erros do provedor viram estado do consentimento (expirado, revogado, falha temporária, indisponível) sem
 * apagar nada local. Revogar no provedor e excluir dados locais são operações SEPARADAS.
 */
import type { ConsentRecord, FinancialAccount } from '../model';
import { cleanText, isSafeCents, isValidDate, maskIdentifier, normalizeDesc } from '../model';
import type { TransactionDraft } from '../drafts';
import { planImport, type ImportPlan } from '../importPlan';
import * as F from '../store';
import { ProviderError, READ_SCOPES, type BankDataProvider, type ConnectionState, type ProviderAccount, type ProviderTransaction } from './types';

const registry = new Map<string, BankDataProvider>();
export function registerProvider(p: BankDataProvider) { registry.set(p.id, p); }
export function getProvider(id: string): BankDataProvider | undefined { return registry.get(id); }
export function listProviders(): BankDataProvider[] { return [...registry.values()]; }

/** Estado exibido de uma conexão (o `syncing` é transitório, mantido pela interface). */
export function connectionState(c: ConsentRecord | undefined, syncing = false): ConnectionState {
  if (!c) return 'not_connected';
  if (syncing) return 'syncing';
  switch (c.status) {
    case 'awaiting': return 'awaiting_consent';
    case 'expired': return 'consent_expired';
    case 'revoked': return 'consent_revoked';
    case 'error': return c.lastError === 'unavailable' ? 'provider_unavailable' : 'temporary_failure';
    default: return c.lastSyncAt ? 'up_to_date' : 'connected';
  }
}

export async function startConnection(provider: BankDataProvider, institutionId: string): Promise<ConsentRecord> {
  await F.ensureFinanceLoaded();
  const inst = (await provider.listInstitutions()).find((i) => i.id === institutionId);
  if (!inst) throw new Error('Instituição não encontrada no provedor.');
  const start = await provider.startConsent(institutionId, READ_SCOPES);
  const local = await F.upsertInstitution(inst.name, { code: inst.code, origin: 'provider', providerRef: { providerId: provider.id, externalId: inst.id } });
  const rec: ConsentRecord = { id: F.newFinanceId('consent_'), providerId: provider.id, environment: provider.environment, consentRef: start.consentRef, institutionId: local.id, scopes: [...READ_SCOPES], status: 'awaiting', expiresAt: start.expiresAt };
  await F.saveConsent(rec);
  return rec;
}

/** Consulta o provedor e atualiza o registro local (após o titular aprovar na instituição). */
export async function refreshConsentStatus(provider: BankDataProvider, consentId: string): Promise<ConsentRecord> {
  const rec = mustConsent(consentId);
  const st = await provider.getConsentStatus(rec.consentRef);
  const next: ConsentRecord = { ...rec, status: st.status, expiresAt: st.expiresAt ?? rec.expiresAt, grantedAt: st.status === 'active' ? rec.grantedAt ?? Date.now() : rec.grantedAt };
  await F.saveConsent(next);
  return next;
}

function mustConsent(id: string): ConsentRecord {
  const rec = F.getFinance().consents.find((c) => c.id === id);
  if (!rec) throw new Error('Conexão não encontrada.');
  return rec;
}

export interface SyncAccountRow {
  providerAccountId: string;
  name: string;
  institutionName: string;
  type: FinancialAccount['type'];
  /** Conta local de destino (ausente = será criada). */
  localAccountId?: string;
  localName?: string;
  /** Conta local reconhecida por número/tipo depois que o item mudou de identificador (renovação). */
  relinked?: boolean;
  /** Data inicial do vínculo com conta já existente (antes dela nada entra pelo provedor). */
  since?: string;
  fetched: number;
  newCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  pendingUpdateCount: number;
  conflictCount: number;
  /** Mesmo valor e data próxima de outro registro com descrição diferente: entra, mas merece conferência. */
  overlapWarnings: number;
  beforeLink: number;
  invalid: number;
}

export interface SyncReport {
  accounts: number;
  added: number;
  updated: number;
  /** Já importadas (inclui possíveis duplicidades deixadas de fora). */
  duplicates: number;
  possibleDuplicates: number;
  overlapWarnings: number;
  paired: number;
  errors: string[];
  rows: SyncAccountRow[];
}

const emptyReport = (): SyncReport => ({ accounts: 0, added: 0, updated: 0, duplicates: 0, possibleDuplicates: 0, overlapWarnings: 0, paired: 0, errors: [], rows: [] });

/**
 * Conta local de uma conta do provedor:
 * 1. vínculo direto (`providerRef.externalId`);
 * 2. renovação: a mesma conta numa conexão anterior do MESMO provedor (o item pode mudar de identificador ao
 *    renovar a autorização) — só com tipo, moeda, instituição e final do número iguais e candidato único.
 */
function findLocalAccount(providerId: string, connectionRef: string, pa: ProviderAccount, takenIds: Set<string>): { account?: FinancialAccount; relinked: boolean } {
  const accs = F.getFinance().accounts;
  const direct = accs.find((a) => a.providerRef?.providerId === providerId && a.providerRef.externalId === pa.id);
  if (direct) return { account: direct, relinked: false };
  const masked = maskIdentifier(pa.number);
  if (!masked) return { relinked: false };
  const instName = pa.institutionName ? normalizeDesc(pa.institutionName) : null;
  const cands = accs.filter((a) => {
    if (takenIds.has(a.id) || a.status !== 'active') return false;
    if (a.providerRef?.providerId !== providerId || a.providerRef.connectionRef === connectionRef) return false;
    if (a.type !== pa.type || a.currency !== pa.currency || a.maskedNumber !== masked) return false;
    if (instName) {
      const inst = F.getFinance().institutions.find((i) => i.id === a.institutionId);
      if (!inst || normalizeDesc(inst.name) !== instName) return false;
    }
    return true;
  });
  return cands.length === 1 ? { account: cands[0], relinked: true } : { relinked: false };
}

function toDrafts(txs: ProviderTransaction[], currency: FinancialAccount['currency'], since?: string) {
  const drafts: TransactionDraft[] = [];
  const invalid: { line: number; reason: string }[] = [];
  let beforeLink = 0;
  txs.forEach((t, i) => {
    // O provedor também é fonte NÃO confiável: mesma validação dos arquivos.
    if (!isValidDate(t.postedDate) || !isSafeCents(t.amountCents) || t.amountCents === 0) { invalid.push({ line: i + 1, reason: 'Movimentação do provedor com data ou valor inválido.' }); return; }
    if (since && t.postedDate < since) { beforeLink++; return; }
    drafts.push({ line: i + 1, externalId: cleanText(t.id, 120), postedDate: t.postedDate, operationDate: t.operationDate && isValidDate(t.operationDate) ? t.operationDate : undefined, description: cleanText(t.description) || '(sem descrição)', amountCents: t.amountCents, currency, rawType: t.type ? cleanText(t.type, 40) : undefined, status: t.status === 'pending' ? 'pending' : 'posted', categoryHint: t.category ? cleanText(t.category, 60) : undefined, installment: t.installment });
  });
  return { drafts, invalid, beforeLink };
}

function rowOf(pa: ProviderAccount, local: FinancialAccount | undefined, relinked: boolean, fetched: number, plan: ImportPlan, beforeLink: number): SyncAccountRow {
  return {
    providerAccountId: pa.id, name: pa.name, institutionName: pa.institutionName ?? '', type: pa.type,
    localAccountId: local?.id, localName: local?.name, relinked: relinked || undefined, since: local?.providerRef?.since,
    fetched, newCount: plan.totals.newCount, duplicateCount: plan.totals.duplicateCount, possibleDuplicateCount: plan.totals.possibleDuplicateCount,
    pendingUpdateCount: plan.totals.pendingUpdateCount, conflictCount: plan.totals.conflictCount,
    overlapWarnings: plan.items.filter((it) => it.status === 'new' && it.warning).length, beforeLink, invalid: plan.invalid.length,
  };
}

/**
 * Sincroniza contas, saldos e movimentações de um consentimento ativo.
 * `dryRun`: só calcula a prévia (nada é gravado; nenhuma conta é criada ou revinculada).
 */
export async function syncConnection(provider: BankDataProvider, consentId: string, range: { from: string; to: string }, opts: { refresh?: boolean; dryRun?: boolean } = {}): Promise<SyncReport> {
  await F.ensureFinanceLoaded();
  let rec = mustConsent(consentId);
  const report = emptyReport();
  try {
    if (opts.refresh && !opts.dryRun) await provider.refresh(rec.consentRef);
    const accounts = await provider.listAccounts(rec.consentRef);
    const taken = new Set<string>();
    for (const pa of accounts) {
      const found = findLocalAccount(provider.id, rec.consentRef, pa, taken);
      let local = found.account;
      if (local) taken.add(local.id);
      const inst = F.getFinance().institutions.find((i) => i.id === rec.institutionId);
      const txs = await provider.listTransactions(rec.consentRef, pa.id, range);
      const { drafts, invalid, beforeLink } = toDrafts(txs, pa.currency, local?.providerRef?.since);
      report.accounts++;
      if (opts.dryRun) {
        const plan = planImport({ account: local ?? { id: '__new__', currency: pa.currency, type: pa.type }, drafts, existing: local ? F.getFinance().transactions : [], invalid });
        const row = rowOf(pa, local, found.relinked, txs.length, plan, beforeLink);
        report.rows.push(row);
        report.added += row.newCount;
        report.updated += row.pendingUpdateCount;
        report.duplicates += row.duplicateCount;
        report.possibleDuplicates += row.possibleDuplicateCount;
        report.overlapWarnings += row.overlapWarnings;
        continue;
      }
      if (!local) {
        local = await F.createAccount({ institutionName: pa.institutionName ?? inst?.name ?? 'Instituição', institutionProviderRef: pa.institutionName ? undefined : inst?.providerRef, name: pa.name, type: pa.type, currency: pa.currency, number: pa.number, card: pa.card, origin: 'provider', providerRef: { providerId: provider.id, externalId: pa.id, connectionRef: rec.consentRef } });
        taken.add(local.id);
      } else if (local.providerRef?.externalId !== pa.id || local.providerRef.connectionRef !== rec.consentRef) {
        // Renovação (novo item) ou vínculo criado pela interface: grava a conexão atual, preservando `since`.
        await F.setAccountProviderRef(local.id, { providerId: provider.id, externalId: pa.id, connectionRef: rec.consentRef, since: local.providerRef?.since });
        const id = local.id;
        local = F.getFinance().accounts.find((a) => a.id === id)!;
      }
      const plan = F.prepareImport(local.id, { drafts, invalid, ignored: [], warnings: [] });
      const row = rowOf(pa, local, found.relinked, txs.length, plan, beforeLink);
      report.rows.push(row);
      const reported = pa.balance && isSafeCents(pa.balance.cents) && isValidDate(pa.balance.asOf.slice(0, 10)) ? { cents: pa.balance.cents, asOf: pa.balance.asOf, origin: 'provider' as const, availableCents: pa.balance.availableCents } : undefined;
      const r = await F.commitImportPlan(plan, { origin: 'provider', providerId: provider.id, fileName: `${provider.name}`, reportedBalance: reported });
      if (pa.card && local.type === 'credit_card') await F.updateAccount(local.id, { card: { ...local.card, ...definedOnly(pa.card) } } as Partial<FinancialAccount>);
      report.added += r.added;
      report.updated += r.updated;
      report.duplicates += r.session.counts.duplicate;
      report.possibleDuplicates += row.possibleDuplicateCount;
      report.overlapWarnings += row.overlapWarnings;
      report.paired += r.paired;
      report.errors.push(...r.session.errors);
    }
    if (opts.dryRun) return report;
    rec = { ...mustConsent(consentId), status: 'active', lastSyncAt: Date.now(), lastError: undefined };
    await F.saveConsent(rec);
    return report;
  } catch (e) {
    const cur = mustConsent(consentId);
    if (e instanceof ProviderError) {
      if (!opts.dryRun || e.code === 'consent_expired' || e.code === 'consent_revoked') {
        const status = e.code === 'consent_expired' ? 'expired' : e.code === 'consent_revoked' ? 'revoked' : e.code === 'temporary' || e.code === 'unavailable' ? 'error' : cur.status;
        await F.saveConsent({ ...cur, status, lastError: e.code === 'unavailable' ? 'unavailable' : e.code === 'temporary' ? 'temporary' : cur.lastError });
      }
      report.errors.push(e.message);
      return report;
    }
    throw e;
  }
}

/** Sem `undefined` explícito (não apaga dados do cartão que o provedor deixou de informar). */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Revoga o consentimento NO PROVEDOR. Os dados já importados continuam locais até o usuário excluí-los. */
export async function revokeConnection(provider: BankDataProvider, consentId: string): Promise<void> {
  const rec = mustConsent(consentId);
  await provider.revokeConsent(rec.consentRef);
  await F.saveConsent({ ...rec, status: 'revoked', revokedAt: Date.now() });
}

/** Esquece a conexão localmente (sem chamar o provedor). Contas e movimentações continuam. */
export async function forgetConnection(consentId: string): Promise<void> {
  await F.removeConsentRecord(consentId);
}

/** Contas locais vindas desta conexão (para “excluir dados locais desta conexão”). */
export function accountsOfConnection(consentId: string): FinancialAccount[] {
  const rec = F.getFinance().consents.find((c) => c.id === consentId);
  if (!rec) return [];
  const inst = F.getFinance().institutions.find((i) => i.id === rec.institutionId);
  return F.getFinance().accounts.filter((a) => a.providerRef?.providerId === rec.providerId && (a.providerRef.connectionRef ? a.providerRef.connectionRef === rec.consentRef : a.institutionId === inst?.id));
}
