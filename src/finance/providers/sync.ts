/**
 * Orquestração provedor → razão. Usa EXATAMENTE o mesmo planejador de importação dos arquivos
 * (deduplicação por id do provedor, pendente → contabilizada, conciliação automática conservadora).
 *
 * Erros do provedor viram estado do consentimento (expirado, revogado, falha temporária, indisponível) sem
 * apagar nada local. Revogar no provedor e excluir dados locais são operações SEPARADAS.
 */
import type { ConsentRecord, FinancialAccount } from '../model';
import { cleanText, isSafeCents, isValidDate } from '../model';
import type { TransactionDraft } from '../drafts';
import * as F from '../store';
import { ProviderError, READ_SCOPES, type BankDataProvider, type ConnectionState } from './types';

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

export interface SyncReport { accounts: number; added: number; updated: number; duplicates: number; paired: number; errors: string[] }

/** Sincroniza contas, saldos e movimentações de um consentimento ativo. */
export async function syncConnection(provider: BankDataProvider, consentId: string, range: { from: string; to: string }, opts: { refresh?: boolean } = {}): Promise<SyncReport> {
  await F.ensureFinanceLoaded();
  let rec = mustConsent(consentId);
  const report: SyncReport = { accounts: 0, added: 0, updated: 0, duplicates: 0, paired: 0, errors: [] };
  try {
    if (opts.refresh) await provider.refresh(rec.consentRef);
    const accounts = await provider.listAccounts(rec.consentRef);
    for (const pa of accounts) {
      let local = F.getFinance().accounts.find((a) => a.providerRef?.providerId === provider.id && a.providerRef.externalId === pa.id);
      const inst = F.getFinance().institutions.find((i) => i.id === rec.institutionId);
      if (!local) {
        local = await F.createAccount({ institutionName: inst?.name ?? 'Instituição', institutionProviderRef: inst?.providerRef, name: pa.name, type: pa.type, currency: pa.currency, number: pa.number, card: pa.card, origin: 'provider', providerRef: { providerId: provider.id, externalId: pa.id } });
      }
      report.accounts++;
      const txs = await provider.listTransactions(rec.consentRef, pa.id, range);
      const drafts: TransactionDraft[] = [];
      const invalid: { line: number; reason: string }[] = [];
      txs.forEach((t, i) => {
        // O provedor também é fonte NÃO confiável: mesma validação dos arquivos.
        if (!isValidDate(t.postedDate) || !isSafeCents(t.amountCents) || t.amountCents === 0) { invalid.push({ line: i + 1, reason: 'Movimentação do provedor com data ou valor inválido.' }); return; }
        drafts.push({ line: i + 1, externalId: cleanText(t.id, 120), postedDate: t.postedDate, operationDate: t.operationDate && isValidDate(t.operationDate) ? t.operationDate : undefined, description: cleanText(t.description) || '(sem descrição)', amountCents: t.amountCents, currency: pa.currency, rawType: t.type ? cleanText(t.type, 40) : undefined, status: t.status === 'pending' ? 'pending' : 'posted', categoryHint: t.category ? cleanText(t.category, 60) : undefined, installment: t.installment });
      });
      const plan = F.prepareImport(local.id, { drafts, invalid, ignored: [], warnings: [] });
      const reported = pa.balance && isSafeCents(pa.balance.cents) && isValidDate(pa.balance.asOf.slice(0, 10)) ? { cents: pa.balance.cents, asOf: pa.balance.asOf, origin: 'provider' as const, availableCents: pa.balance.availableCents } : undefined;
      const r = await F.commitImportPlan(plan, { origin: 'provider', providerId: provider.id, fileName: `${provider.name}`, reportedBalance: reported });
      if (pa.card && local.type === 'credit_card') await F.updateAccount(local.id, { card: { ...local.card, ...pa.card } } as Partial<FinancialAccount>);
      report.added += r.added;
      report.updated += r.updated;
      report.duplicates += r.session.counts.duplicate;
      report.paired += r.paired;
      report.errors.push(...r.session.errors);
    }
    rec = { ...mustConsent(consentId), status: 'active', lastSyncAt: Date.now(), lastError: undefined };
    await F.saveConsent(rec);
    return report;
  } catch (e) {
    const cur = mustConsent(consentId);
    if (e instanceof ProviderError) {
      const status = e.code === 'consent_expired' ? 'expired' : e.code === 'consent_revoked' ? 'revoked' : e.code === 'temporary' || e.code === 'unavailable' ? 'error' : cur.status;
      await F.saveConsent({ ...cur, status, lastError: e.code === 'unavailable' ? 'unavailable' : e.code === 'temporary' ? 'temporary' : cur.lastError });
      report.errors.push(e.message);
      return report;
    }
    throw e;
  }
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
  return F.getFinance().accounts.filter((a) => a.providerRef?.providerId === rec.providerId && a.institutionId === inst?.id);
}
