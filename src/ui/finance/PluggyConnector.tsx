/**
 * Minhas contas → Conectores → Meu Pluggy (issue #9). Dados REAIS do próprio titular, somente leitura.
 *
 * - Nada acontece sozinho: o estado só é consultado quando o usuário pede, e nenhum dado é gravado sem
 *   “Sincronizar dados já disponíveis”. A prévia (simulação) não grava nada.
 * - Credenciais nunca aparecem aqui: a tela só explica os NOMES das variáveis do `.env` do servidor local.
 * - A autorização dos bancos acontece no portal meu.pluggy.ai (links abaixo), nunca nesta tela.
 */
import { useEffect, useState } from 'react';
import { LOCAL_API_ENABLED } from '../../config/runtime';
import { MEU_PLUGGY_URL, PLUGGY_DASHBOARD_URL, PLUGGY_PROVIDER_ID, pluggyProvider, type PluggyItemStatus, type PluggyStatus } from '../../finance/providers/pluggy';
import { accountsOfConnection, connectionState, forgetConnection, refreshConsentStatus, startConnection, syncConnection, type SyncAccountRow, type SyncReport } from '../../finance/providers/sync';
import { CONNECTION_LABELS, ProviderError } from '../../finance/providers/types';
import { deleteAccountData, setAccountProviderRef, useFinance } from '../../finance/store';
import type { ConsentRecord, FinancialAccount } from '../../finance/model';
import { confirmDialog, toast } from '../../store/ui';
import { btnCls, Card, dangerCls, inputCls, primaryCls, todayISO } from './common';

const RANGES = [3, 6, 12] as const;
type Months = (typeof RANGES)[number];

function rangeOf(months: Months) {
  const t = todayISO();
  const [y, m] = t.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1 - months, 1)).toISOString().slice(0, 10), to: t };
}
const fmtDate = (iso?: string | number) => (iso === undefined ? '' : new Date(iso).toLocaleDateString('pt-BR'));
const fmtDateTime = (iso?: string | number) => (iso === undefined ? '' : new Date(iso).toLocaleString('pt-BR'));
const nextDay = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); };

export function RealDataBadge() {
  return <span className="text-[10px] font-extrabold tracking-wider px-1.5 py-0.5 rounded border border-accent/60 text-accent" data-testid="pluggy-real-badge">DADOS REAIS · SOMENTE LEITURA</span>;
}

/** Último dia com movimentação vinda de arquivo/manual (para começar o vínculo depois dele). */
function suggestedSince(accountId: string): string | undefined {
  let max = '';
  for (const t of useFinance.getState().transactions) if (t.accountId === accountId && t.source.kind !== 'provider' && t.postedDate > max) max = t.postedDate;
  return max ? nextDay(max) : undefined;
}

export function PluggyConnector() {
  const s = useFinance();
  const [status, setStatus] = useState<PluggyStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consents = s.consents.filter((c) => c.providerId === PLUGGY_PROVIDER_ID);

  const check = async () => {
    setChecking(true);
    setError(null);
    try { setStatus(await pluggyProvider().status(0)); } catch (e) { setError((e as Error).message); } finally { setChecking(false); }
  };

  const add = async (itemId: string) => {
    try {
      const rec = await startConnection(pluggyProvider(), itemId);
      const next = await refreshConsentStatus(pluggyProvider(), rec.id);
      toast(next.status === 'active' ? 'Item adicionado. Faça a prévia antes de sincronizar.' : `Item adicionado: ${CONNECTION_LABELS[connectionState(next)]}.`, next.status === 'active' ? 'success' : 'warning', 6000);
    } catch (e) { toast((e as Error).message, 'error', 7000); }
  };

  if (!LOCAL_API_ENABLED) {
    return (
      <Card title={<span className="flex items-center gap-2">Meu Pluggy <RealDataBadge /></span>} testid="pluggy-card">
        <div className="text-[12px] text-muted" data-testid="pluggy-static">Indisponível nesta versão pública: o Meu Pluggy precisa do servidor local do Aurora (que guarda as credenciais no seu computador).</div>
      </Card>
    );
  }

  const configuredItems = status && status.configured ? status.items : [];
  const orphan = consents.filter((c) => status?.configured && !configuredItems.some((i) => i.itemId === c.consentRef));

  return (
    <Card title={<span className="flex items-center gap-2">Meu Pluggy <RealDataBadge /></span>} testid="pluggy-card">
      <div className="text-[12px] text-fg-2">
        Uso pessoal e gratuito do Meu Pluggy: você autoriza seus bancos <b>no portal da Pluggy</b> e o servidor local do Aurora lê contas, saldos e movimentações <b>já disponíveis</b>. Nenhum pagamento, Pix ou transferência é possível por aqui.
      </div>
      <div className="text-[11px] text-muted mt-1" data-testid="pluggy-summary">
        {consents.length ? `${consents.length} item(ns) do Meu Pluggy neste navegador.` : 'Nenhuma conta real conectada.'} O Meu Pluggy atualiza os dados cerca de uma vez por dia; o Aurora não força atualização no banco.
      </div>

      <details className="mt-2 text-[11px] text-fg-2" data-testid="pluggy-howto">
        <summary className="cursor-pointer font-semibold">Como configurar (no seu computador, sem enviar segredos a ninguém)</summary>
        <ol className="list-decimal pl-5 mt-1 space-y-0.5">
          <li>Em <a className="underline" href={MEU_PLUGGY_URL} target="_blank" rel="noopener noreferrer">meu.pluggy.ai</a>, conecte seus bancos (ex.: Inter, Nubank).</li>
          <li>No <a className="underline" href={PLUGGY_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">Dashboard da Pluggy</a>: Aplicações → Demo → Conectar conta → escolha <b>MeuPluggy</b> e autorize.</li>
          <li>Ainda na aplicação, copie o <b>Client ID</b>, o <b>Client Secret</b> e os <b>itemIds</b> dos itens conectados.</li>
          <li>No arquivo <code>.env</code> da pasta do Aurora (nunca no Git), preencha <code>PLUGGY_CLIENT_ID</code>, <code>PLUGGY_CLIENT_SECRET</code> e <code>PLUGGY_ITEM_IDS</code> (separados por vírgula).</li>
          <li>Reinicie <code>npm run dev</code> e clique em “Verificar Meu Pluggy”.</li>
        </ol>
        <div className="mt-1 text-soft">Passo a passo completo: docs/finance/MEU_PLUGGY.md.</div>
      </details>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button className={btnCls} data-testid="pluggy-check" disabled={checking} onClick={() => void check()}>{checking ? 'Verificando…' : 'Verificar Meu Pluggy'}</button>
        <a className={`${btnCls} inline-flex items-center`} href={MEU_PLUGGY_URL} target="_blank" rel="noopener noreferrer">Abrir meu.pluggy.ai</a>
      </div>

      {error && <div className="text-[12px] text-warn mt-2" data-testid="pluggy-error">{error}</div>}

      {status && !status.configured && (
        <div className="mt-2 text-[12px]" data-testid="pluggy-not-configured">
          <b>Não configurado neste computador.</b>
          <ul className="list-disc pl-5 text-[11px] text-muted mt-0.5">{status.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      {status?.configured && (
        <div className="flex flex-col gap-2 mt-2">
          {!configuredItems.length && <div className="text-[11px] text-soft">Nenhum item em PLUGGY_ITEM_IDS.</div>}
          {configuredItems.map((it) => {
            const rec = consents.find((c) => c.consentRef === it.itemId);
            return rec ? <PluggyConnection key={it.itemId} rec={rec} item={it} /> : (
              <div key={it.itemId} className="rounded-lg border border-line p-2 text-[12px]" data-testid="pluggy-item" data-consent={it.consentStatus}>
                <div className="flex items-center justify-between gap-2">
                  <b>{it.connectorName}</b>
                  <span className="text-[10px] text-soft font-mono">item …{it.itemId.slice(-6)}</span>
                </div>
                <ItemFacts item={it} />
                <button className={`${primaryCls} mt-1.5`} data-testid="pluggy-add" disabled={it.consentStatus !== 'active'} onClick={() => void add(it.itemId)}>Adicionar ao Aurora</button>
              </div>
            );
          })}
          {orphan.map((c) => <PluggyConnection key={c.id} rec={c} orphan />)}
        </div>
      )}
      {!status && consents.map((c) => <PluggyConnection key={c.id} rec={c} />)}
    </Card>
  );
}

function ItemFacts({ item }: { item: PluggyItemStatus }) {
  return (
    <>
      <div className="text-[10px] text-soft">
        Pluggy: {item.status || '—'}
        {item.lastUpdatedAt ? ` · dados atualizados pela Pluggy em ${fmtDateTime(item.lastUpdatedAt)}` : ''}
        {item.nextAutoSyncAt ? ` · próxima atualização automática ${fmtDateTime(item.nextAutoSyncAt)}` : ''}
        {item.consentExpiresAt ? ` · autorização até ${fmtDate(item.consentExpiresAt)}` : ''}
      </div>
      {item.message && <div className={`text-[11px] mt-0.5 ${item.consentStatus === 'active' ? 'text-muted' : 'text-warn'}`} data-testid="pluggy-item-message">{item.message}</div>}
    </>
  );
}

function PluggyConnection({ rec, item, orphan }: { rec: ConsentRecord; item?: PluggyItemStatus; orphan?: boolean }) {
  const s = useFinance();
  const [months, setMonths] = useState<Months>(12);
  const [busy, setBusy] = useState<null | 'preview' | 'sync'>(null);
  const [preview, setPreview] = useState<SyncReport | null>(null);
  const state = connectionState(rec, busy === 'sync');
  const accs = accountsOfConnection(rec.id);

  // A prévia fica velha quando o período ou os vínculos mudam.
  useEffect(() => { setPreview(null); }, [months]);

  const runPreview = async () => {
    setBusy('preview');
    try {
      const r = await syncConnection(pluggyProvider(), rec.id, rangeOf(months), { dryRun: true });
      setPreview(r);
      if (r.errors.length) toast(r.errors[0], 'warning', 7000);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const runSync = async () => {
    setBusy('sync');
    try {
      const r = await syncConnection(pluggyProvider(), rec.id, rangeOf(months));
      setPreview(null);
      if (r.errors.length) toast(r.errors[0], 'warning', 7000);
      else toast(`Sincronizado: ${r.accounts} conta(s), ${r.added} nova(s), ${r.updated} atualizada(s), ${r.duplicates} já existente(s)${r.possibleDuplicates ? `, ${r.possibleDuplicates} possível(is) duplicidade(s) deixada(s) de fora` : ''}.`, 'success', 8000);
    } catch (e) { toast(e instanceof ProviderError ? e.message : (e as Error).message, 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="rounded-lg border border-line p-2 text-[12px]" data-testid="pluggy-connection" data-state={state}>
      <div className="flex items-center justify-between gap-2">
        <b>{s.institutions.find((i) => i.id === rec.institutionId)?.name ?? 'Meu Pluggy'}</b>
        <span className={`text-[11px] font-bold ${state === 'up_to_date' || state === 'connected' ? 'text-ok' : state === 'syncing' ? 'text-muted' : 'text-warn'}`} data-testid="pluggy-state">{CONNECTION_LABELS[state]}</span>
      </div>
      {item && <ItemFacts item={item} />}
      {orphan && <div className="text-[11px] text-warn" data-testid="pluggy-orphan">Este item não está mais em PLUGGY_ITEM_IDS (renovado com outro itemId?). Os dados importados continuam; adicione o item novo e sincronize — as contas são reconhecidas pelo tipo e final do número.</div>}
      <div className="text-[10px] text-soft">
        Somente leitura{rec.lastSyncAt ? ` · última sincronização ${fmtDateTime(rec.lastSyncAt)}` : ' · nunca sincronizado'}{accs.length ? ` · ${accs.length} conta(s) local(is)` : ''}
      </div>
      {!orphan && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <select className={inputCls} aria-label="Período" data-testid="pluggy-range" value={months} onChange={(e) => setMonths(Number(e.target.value) as Months)}>
            {RANGES.map((m) => <option key={m} value={m}>Últimos {m} meses</option>)}
          </select>
          <button className={btnCls} data-testid="pluggy-preview" disabled={!!busy || rec.status === 'revoked'} onClick={() => void runPreview()}>{busy === 'preview' ? 'Calculando…' : 'Prévia'}</button>
          <button className={primaryCls} data-testid="pluggy-sync" disabled={!!busy || rec.status === 'revoked'} onClick={() => void runSync()}>{busy === 'sync' ? 'Sincronizando…' : 'Sincronizar dados já disponíveis'}</button>
        </div>
      )}
      {preview && <PreviewTable report={preview} connectionRef={rec.consentRef} onChanged={() => void runPreview()} />}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        <a className={`${btnCls} inline-flex items-center`} href={MEU_PLUGGY_URL} target="_blank" rel="noopener noreferrer">Gerenciar autorização no Meu Pluggy</a>
        {accs.length > 0 && <button className={dangerCls} onClick={async () => { if (await confirmDialog('Excluir dados locais desta conexão', `${accs.length} conta(s) e suas movimentações serão apagadas deste navegador. A autorização no Meu Pluggy continua (gerencie em meu.pluggy.ai).`, 'Excluir dados locais', true)) { for (const a of accs) await deleteAccountData(a.id); } }}>Excluir dados locais</button>}
        <button className={btnCls} data-testid="pluggy-forget" onClick={async () => { if (await confirmDialog('Esquecer conexão', 'A conexão sai da lista deste navegador. Contas e movimentações já importadas continuam. Nada é alterado no Meu Pluggy.', 'Esquecer')) await forgetConnection(rec.id); }}>Esquecer conexão</button>
      </div>
    </div>
  );
}

function PreviewTable({ report, connectionRef, onChanged }: { report: SyncReport; connectionRef: string; onChanged: () => void }) {
  const accounts = useFinance((st) => st.accounts);
  if (!report.rows.length) return <div className="text-[11px] text-soft mt-1.5" data-testid="pluggy-preview-empty">{report.errors[0] ?? 'Nenhuma conta disponível neste item.'}</div>;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="pluggy-preview-table">
      <div className="text-[11px] text-muted">Prévia (nada foi gravado): {report.added} nova(s), {report.duplicates} já existente(s), {report.updated} pendente(s) contabilizada(s){report.possibleDuplicates ? `, ${report.possibleDuplicates} possível(is) duplicidade(s) que ficarão de fora` : ''}{report.overlapWarnings ? `, ${report.overlapWarnings} com valor e data parecidos a outro registro (confira depois)` : ''}.</div>
      {report.rows.map((r) => <PreviewRow key={r.providerAccountId} row={r} accounts={accounts} connectionRef={connectionRef} onChanged={onChanged} />)}
    </div>
  );
}

function PreviewRow({ row, accounts, connectionRef, onChanged }: { row: SyncAccountRow; accounts: FinancialAccount[]; connectionRef: string; onChanged: () => void }) {
  // Contas que podem receber o vínculo: mesmo tipo, sem provedor (vindas de CSV/OFX/manual).
  const candidates = accounts.filter((a) => a.status === 'active' && a.type === row.type && !a.providerRef);
  const target = row.localAccountId ? accounts.find((a) => a.id === row.localAccountId) : undefined;
  const link = async (accountId: string) => {
    try {
      if (!accountId) return;
      await setAccountProviderRef(accountId, { providerId: PLUGGY_PROVIDER_ID, externalId: row.providerAccountId, connectionRef, since: suggestedSince(accountId) });
      onChanged();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const unlink = async () => {
    if (!target || target.origin === 'provider') return;
    await setAccountProviderRef(target.id, null);
    onChanged();
  };
  return (
    <div className="rounded border border-line/70 p-1.5 text-[11px]" data-testid="pluggy-preview-row">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span><b>{row.name}</b>{row.institutionName ? ` · ${row.institutionName}` : ''}</span>
        <span className="text-soft">{row.fetched} lida(s) · <b data-testid="pluggy-row-new">{row.newCount}</b> nova(s) · {row.duplicateCount} já existente(s){row.possibleDuplicateCount ? ` · ${row.possibleDuplicateCount} possível(is) duplicidade(s)` : ''}{row.beforeLink ? ` · ${row.beforeLink} antes do vínculo` : ''}{row.invalid ? ` · ${row.invalid} inválida(s)` : ''}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-1">
        {target ? (
          <>
            <span data-testid="pluggy-row-target">Destino: <b>{target.name}</b>{row.relinked ? ' (reconhecida após renovação)' : ''}{row.since ? ` · só a partir de ${fmtDate(`${row.since}T12:00:00`)}` : ''}</span>
            {target.origin !== 'provider' && <button className={btnCls} onClick={() => void unlink()}>Desvincular</button>}
          </>
        ) : (
          <>
            <span>Destino:</span>
            <select className={inputCls} aria-label={`Destino de ${row.name}`} data-testid="pluggy-link-select" value="" onChange={(e) => void link(e.target.value)}>
              <option value="">Criar conta nova</option>
              {candidates.map((a) => <option key={a.id} value={a.id}>Vincular a “{a.name}” {a.maskedNumber}</option>)}
            </select>
          </>
        )}
      </div>
      {row.overlapWarnings > 0 && <div className="text-warn mt-0.5">{row.overlapWarnings} movimentação(ões) com mesmo valor e data próxima de outro registro: confira depois em Movimentações.</div>}
    </div>
  );
}
