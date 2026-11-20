/**
 * Conectores (Open Finance). Neste ciclo só existe o provedor FICTÍCIO, ativado explicitamente como
 * “ambiente de testes” e sempre rotulado “DADOS FICTÍCIOS — AMBIENTE DE TESTES”. Provedores reais exigem
 * backend com credenciais e contrato — documentados em docs/finance/OPEN_FINANCE.md, não simulados aqui.
 */
import { useEffect, useState } from 'react';
import { MockBankProvider } from '../../finance/providers/mock';
import { accountsOfConnection, connectionState, forgetConnection, getProvider, refreshConsentStatus, registerProvider, revokeConnection, startConnection, syncConnection } from '../../finance/providers/sync';
import { CONNECTION_LABELS, type ProviderInstitution } from '../../finance/providers/types';
import { deleteAccountData, setTestMode, useFinance } from '../../finance/store';
import { confirmDialog, toast } from '../../store/ui';
import { btnCls, Card, dangerCls, primaryCls, todayISO } from './common';

let mock: MockBankProvider | null = null;
export function mockProvider(): MockBankProvider {
  if (!mock) { mock = new MockBankProvider(todayISO()); registerProvider(mock); }
  return mock;
}

export function TestBanner() {
  return <div className="rounded-lg border-2 border-warn bg-warn/15 text-warn text-[12px] font-extrabold tracking-wider text-center py-1.5" data-testid="mock-banner">DADOS FICTÍCIOS — AMBIENTE DE TESTES</div>;
}

export function ConnectorsTab() {
  const s = useFinance();
  const [institutions, setInstitutions] = useState<ProviderInstitution[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
  const mockConsents = s.consents.filter((c) => c.providerId === 'mock');

  useEffect(() => { if (s.testMode) void mockProvider().listInstitutions().then(setInstitutions); }, [s.testMode]);

  const range = () => { const t = todayISO(); const [y, m] = t.split('-').map(Number); const from = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString().slice(0, 10); return { from, to: t }; };
  const run = async (id: string, fn: () => Promise<void>) => {
    setSyncing(id);
    try { await fn(); } catch (e) { toast((e as Error).message, 'error'); } finally { setSyncing(null); }
  };
  const sync = (consentId: string, refresh = false) => run(consentId, async () => {
    const r = await syncConnection(getProvider('mock')!, consentId, range(), { refresh });
    if (r.errors.length) toast(r.errors[0], 'warning', 6000);
    else toast(`Sincronizado: ${r.accounts} conta(s), ${r.added} nova(s), ${r.updated} atualizada(s), ${r.duplicates} repetida(s) ignorada(s).`, 'success', 6000);
  });

  return (
    <div className="flex flex-col gap-3" data-testid="finance-connectors">
      <Card title="Open Finance — estado real">
        <div className="text-[12px] text-fg-2">Nenhuma conexão bancária real está configurada. O Open Finance Brasil só entrega dados transacionais a instituições autorizadas pelo Banco Central ou a intermediários contratados (ex.: Pluggy, Belvo), que exigem um <b>backend</b> com credenciais de aplicação — nada disso existe nesta versão local.</div>
        <ul className="mt-2 text-[11px] text-muted list-disc pl-5">
          <li>Pluggy / Belvo: <b>não configurado</b> — requer contrato/credenciais e servidor seguro (ver docs/finance/OPEN_FINANCE.md).</li>
          <li>Enquanto isso, use <b>Importar extrato</b> (CSV/OFX) — funciona com dados reais e fica só neste navegador.</li>
        </ul>
      </Card>

      <Card title="Ambiente de testes (provedor fictício)">
        {!s.testMode ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted">Simula o fluxo completo (consentimento, sincronização, expiração, revogação) com bancos inventados.</span>
            <button className={btnCls} data-testid="enable-test-mode" onClick={() => setTestMode(true)}>Ativar ambiente de testes</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <TestBanner />
            <div className="flex flex-wrap gap-2">
              {institutions.map((i) => (
                <button key={i.id} className={primaryCls} data-testid={`mock-connect-${i.id}`} onClick={() => void run(i.id, async () => { await startConnection(mockProvider(), i.id); toast(`Consentimento solicitado a ${i.name} (fictício).`, 'info'); })}>Conectar {i.name}</button>
              ))}
              <button className={btnCls} onClick={() => setTestMode(false)}>Ocultar ambiente de testes</button>
            </div>
            {!mockConsents.length && <div className="text-[11px] text-soft">Nenhuma conexão fictícia.</div>}
            {mockConsents.map((c) => {
              const inst = s.institutions.find((i) => i.id === c.institutionId);
              const state = connectionState(c, syncing === c.id);
              const accs = accountsOfConnection(c.id);
              return (
                <div key={c.id} className="rounded-lg border border-line p-2 text-[12px]" data-testid="mock-connection" data-state={state}>
                  <div className="flex items-center justify-between gap-2">
                    <b>{inst?.name ?? 'Banco fictício'}</b>
                    <span className={`text-[11px] font-bold ${state === 'up_to_date' || state === 'connected' ? 'text-ok' : state === 'syncing' ? 'text-muted' : 'text-warn'}`} data-testid="mock-state">{CONNECTION_LABELS[state]}</span>
                  </div>
                  <div className="text-[10px] text-soft">Escopos: {c.scopes.join(', ')} (somente leitura) · {c.expiresAt ? `expira em ${new Date(c.expiresAt).toLocaleDateString('pt-BR')}` : ''}{c.lastSyncAt ? ` · última sincronização ${new Date(c.lastSyncAt).toLocaleString('pt-BR')}` : ''}{accs.length ? ` · ${accs.length} conta(s) local(is)` : ''}</div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {c.status === 'awaiting' && <button className={primaryCls} data-testid="mock-approve" onClick={() => void run(c.id, async () => { mockProvider().approve(c.consentRef); await refreshConsentStatus(mockProvider(), c.id); })}>Aprovar consentimento simulado</button>}
                    {c.status !== 'awaiting' && c.status !== 'revoked' && <button className={btnCls} data-testid="mock-sync" disabled={!!syncing} onClick={() => void sync(c.id)}>Sincronizar</button>}
                    {c.status === 'active' && <button className={btnCls} data-testid="mock-refresh" disabled={!!syncing} onClick={() => void sync(c.id, true)}>Atualizar na instituição</button>}
                    {c.status === 'active' && <button className={btnCls} data-testid="mock-expire" onClick={() => void run(c.id, async () => { try { mockProvider().expire(c.consentRef); } catch { /* sessão de testes encerrada */ } await sync(c.id); })}>Simular expiração</button>}
                    {c.status === 'active' && <button className={btnCls} onClick={() => { mockProvider().failNext('temporary'); void sync(c.id); }}>Simular falha</button>}
                    {(c.status === 'expired' || c.status === 'error') && <button className={btnCls} onClick={() => void run(c.id, async () => { await forgetConnection(c.id); const inst2 = s.institutions.find((i) => i.id === c.institutionId); const ext = inst2?.providerRef?.externalId; if (ext) await startConnection(mockProvider(), ext); })}>Reconectar</button>}
                    {c.status !== 'revoked' && <button className={dangerCls} data-testid="mock-revoke" onClick={async () => { if (await confirmDialog('Revogar consentimento', 'O consentimento será revogado no provedor (fictício). Os dados já importados continuam neste navegador até você excluí-los.', 'Revogar', true)) await run(c.id, () => revokeConnection(mockProvider(), c.id)); }}>Revogar consentimento</button>}
                    {accs.length > 0 && <button className={dangerCls} onClick={async () => { if (await confirmDialog('Excluir dados locais desta conexão', `${accs.length} conta(s) e suas movimentações serão apagadas deste navegador. Isso NÃO revoga o consentimento na instituição.`, 'Excluir dados locais', true)) await run(c.id, async () => { for (const a of accs) await deleteAccountData(a.id); }); }}>Excluir dados locais</button>}
                    {c.status === 'revoked' && <button className={btnCls} onClick={() => void forgetConnection(c.id)}>Remover da lista</button>}
                  </div>
                  {c.lastError && c.status === 'error' && <div className="text-[11px] text-warn mt-1">{c.lastError === 'unavailable' ? 'Provedor indisponível.' : 'Falha temporária: tente sincronizar de novo.'}</div>}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
