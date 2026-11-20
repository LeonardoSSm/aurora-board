/**
 * Issue #9 — Meu Pluggy no navegador: provedor `pluggy-personal` → sincronização → razão F1.
 * O servidor local é substituído por um `fetch` falso que responde como /api/pluggy/* (dados inventados).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from '../../src/finance/store';
import { MemoryFinanceRepository } from '../../src/finance/repository';
import { PluggyPersonalProvider } from '../../src/finance/providers/pluggy';
import { accountsOfConnection, forgetConnection, refreshConsentStatus, startConnection, syncConnection } from '../../src/finance/providers/sync';

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ITEM_NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const ACC = '0b0b0b0b-1111-4222-8333-444444444444';
const ACC_NEW = '0b0b0b0b-1111-4222-8333-000000000001';
const CARD = '0c0c0c0c-1111-4222-8333-444444444444';
const RANGE = { from: '2026-08-01', to: '2026-11-19' };

interface Backend {
  items: { itemId: string; connectorName: string; status: string; consentStatus: string; message?: string }[];
  accounts: Record<string, unknown[]>;
  txs: Record<string, unknown[]>;
  fail?: { status: number; body: unknown; headers?: Record<string, string> };
  calls: string[];
}
let be: Backend;

const bankAcc = (id = ACC) => ({ id, itemId: ITEM, name: 'Conta Corrente', type: 'checking', currency: 'BRL', numberTail: '3450', institutionName: 'Nubank', balance: { cents: 152037, asOf: '2026-11-19' } });
const cardAcc = () => ({ id: CARD, itemId: ITEM, name: 'Nubank Ultravioleta', type: 'credit_card', currency: 'BRL', numberTail: '4321', institutionName: 'Nubank', balance: { cents: -84210, asOf: '2026-11-19' }, card: { limitCents: 500000, availableLimitCents: 415790, dueDay: 2 } });
const t = (id: string, postedDate: string, amountCents: number, description: string, extra: Record<string, unknown> = {}) => ({ id, postedDate, amountCents, description, status: 'posted', ...extra });

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(async () => {
  be = {
    items: [{ itemId: ITEM, connectorName: 'MeuPluggy', status: 'UPDATED', consentStatus: 'active' }],
    accounts: { [ITEM]: [bankAcc(), cardAcc()] },
    txs: {
      [ACC]: [t('p1', '2026-11-05', 500000, 'SALARIO EMPRESA FICTICIA'), t('p2', '2026-11-10', -1050, 'PADARIA FICTICIA'), t('p3', '2026-11-12', -42970, 'PAGAMENTO FATURA NUBANK')],
      [CARD]: [t('c1', '2026-11-03', -8990, 'IFOOD *PEDIDO'), t('c2', '2026-11-18', -12000, 'LOJA ONLINE FICTICIA', { status: 'pending' }), t('c3', '2026-11-12', 42970, 'PAGAMENTO RECEBIDO')],
    },
    calls: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://localhost');
    be.calls.push(u.pathname + u.search);
    if (be.fail) return json(be.fail.status, be.fail.body, be.fail.headers);
    if (u.pathname === '/api/pluggy/status') return json(200, { configured: true, readOnly: true, items: be.items });
    if (u.pathname === '/api/pluggy/accounts') return json(200, { accounts: be.accounts[u.searchParams.get('itemId')!] ?? [] });
    if (u.pathname === '/api/pluggy/transactions') return json(200, { transactions: be.txs[u.searchParams.get('accountId')!] ?? [], invalid: 0, pages: 1 });
    return json(404, { error: 'Rota não encontrada.' });
  }));
  F.resetFinanceForTests(new MemoryFinanceRepository());
  await F.ensureFinanceLoaded();
});
afterEach(() => { vi.unstubAllGlobals(); });

async function connect(provider: PluggyPersonalProvider, itemId = ITEM) {
  const rec = await startConnection(provider, itemId);
  return refreshConsentStatus(provider, rec.id);
}

describe('Meu Pluggy → razão', () => {
  it('conecta item ativo, sincroniza contas reais (instituição pelo banco), saldos e cartão; reimportar é idempotente', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    expect(rec).toMatchObject({ status: 'active', environment: 'production', providerId: 'pluggy-personal', consentRef: ITEM });
    const r1 = await syncConnection(p, rec.id, RANGE);
    expect(r1).toMatchObject({ accounts: 2, added: 6, errors: [] });
    const s = F.getFinance();
    expect(s.accounts.map((a) => [a.type, a.maskedNumber, a.origin])).toEqual([['checking', '•••• 3450', 'provider'], ['credit_card', '•••• 4321', 'provider']]);
    expect(s.institutions.find((i) => i.id === s.accounts[0].institutionId)?.name).toBe('Nubank');
    expect(s.accounts[0].reportedBalance).toMatchObject({ cents: 152037, origin: 'provider' });
    expect(s.accounts[1].card).toMatchObject({ limitCents: 500000, dueDay: 2 });
    expect(s.accounts.every((a) => a.providerRef?.connectionRef === ITEM)).toBe(true);
    expect(accountsOfConnection(rec.id)).toHaveLength(2);
    // Fatura paga na conta + pagamento recebido no cartão → pareados pela conciliação F1.
    expect(r1.paired).toBeGreaterThanOrEqual(1);
    const r2 = await syncConnection(p, rec.id, RANGE);
    expect(r2).toMatchObject({ added: 0, duplicates: 6 });
    expect(F.getFinance().transactions).toHaveLength(6);
    // Só o servidor local é chamado; nenhuma URL da Pluggy no navegador.
    expect(be.calls.every((c) => c.startsWith('/api/pluggy/'))).toBe(true);
  });

  it('pendente → contabilizada com o mesmo id; classificação manual nunca é sobrescrita', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    await syncConnection(p, rec.id, RANGE);
    const pend = F.getFinance().transactions.find((x) => x.externalId === 'c2')!;
    expect(pend.status).toBe('pending');
    const ifood = F.getFinance().transactions.find((x) => x.externalId === 'c1')!;
    await F.classifyTransaction(ifood.id, { category: 'Lazer' });
    be.txs[CARD] = be.txs[CARD].map((x) => ((x as { id: string }).id === 'c2' ? { ...(x as object), status: 'posted' } : x));
    const r = await syncConnection(p, rec.id, RANGE);
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect(F.getFinance().transactions.find((x) => x.id === pend.id)?.status).toBe('posted');
    expect(F.getFinance().transactions.find((x) => x.id === ifood.id)?.local).toMatchObject({ category: 'Lazer', categorySource: 'user' });
  });

  it('prévia (dryRun) não grava nada nem cria contas', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    const pv = await syncConnection(p, rec.id, RANGE, { dryRun: true });
    expect(pv).toMatchObject({ accounts: 2, added: 6 });
    expect(pv.rows.map((r) => [r.name, r.newCount, r.localAccountId])).toEqual([['Conta Corrente', 3, undefined], ['Nubank Ultravioleta', 3, undefined]]);
    expect(F.getFinance().accounts).toHaveLength(0);
    expect(F.getFinance().transactions).toHaveLength(0);
    expect(F.getFinance().consents[0].lastSyncAt).toBeUndefined();
  });

  it('vínculo com conta CSV existente: só entra o que vier depois do histórico do arquivo (sem duplicar)', async () => {
    const csv = await F.createAccount({ institutionName: 'Nubank', name: 'Nubank (extrato)', type: 'checking', number: '123450' });
    const plan = F.prepareImport(csv.id, { drafts: [{ line: 1, postedDate: '2026-11-05', amountCents: 500000, description: 'Salário Empresa Fictícia - TED', status: 'posted' }, { line: 2, postedDate: '2026-11-10', amountCents: -1050, description: 'Padaria', status: 'posted' }], invalid: [], ignored: [], warnings: [] });
    await F.commitImportPlan(plan, { origin: 'csv', fileName: 'nubank.csv' });
    await F.setAccountProviderRef(csv.id, { providerId: 'pluggy-personal', externalId: ACC, connectionRef: ITEM, since: '2026-11-11' });
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    const pv = await syncConnection(p, rec.id, RANGE, { dryRun: true });
    expect(pv.rows[0]).toMatchObject({ localAccountId: csv.id, beforeLink: 2, newCount: 1, since: '2026-11-11' });
    await syncConnection(p, rec.id, RANGE);
    const mine = F.getFinance().transactions.filter((x) => x.accountId === csv.id);
    expect(mine.map((x) => x.amountCents).sort((a, b) => a - b)).toEqual([-42970, -1050, 500000]);
    expect(F.getFinance().accounts.find((a) => a.id === csv.id)).toMatchObject({ origin: 'manual', providerRef: { since: '2026-11-11', connectionRef: ITEM } });
    // A mesma conta do provedor não pode ser vinculada a duas contas locais.
    const other = await F.createAccount({ institutionName: 'Nubank', name: 'Outra', type: 'checking' });
    await expect(F.setAccountProviderRef(other.id, { providerId: 'pluggy-personal', externalId: ACC })).rejects.toThrow(/já está vinculada/);
  });

  it('sem vínculo, a mesma movimentação do CSV com mesma descrição vira possível duplicidade (fica de fora)', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    await syncConnection(p, rec.id, RANGE);
    const acc = F.getFinance().accounts.find((a) => a.type === 'checking')!;
    // Arquivo OFX/CSV posterior com o mesmo lançamento → não duplica (fluxo F1 entre esquemas).
    const plan = F.prepareImport(acc.id, { drafts: [{ line: 1, postedDate: '2026-11-10', amountCents: -1050, description: 'PADARIA FICTICIA', status: 'posted', externalId: 'FITID-9' }], invalid: [], ignored: [], warnings: [] });
    expect(plan.items[0]).toMatchObject({ status: 'possible-duplicate', include: false });
  });

  it('renovação com itemId e ids de conta novos: reconhece a conta pelo final do número e não duplica o histórico', async () => {
    const p = new PluggyPersonalProvider();
    const old = await connect(p);
    await syncConnection(p, old.id, RANGE);
    const localId = F.getFinance().accounts.find((a) => a.type === 'checking')!.id;
    // Autorização renovada no Meu Pluggy: item novo, conta e movimentações com novos identificadores.
    be.items = [{ itemId: ITEM_NEW, connectorName: 'MeuPluggy', status: 'UPDATED', consentStatus: 'active' }];
    be.accounts = { [ITEM_NEW]: [{ ...bankAcc(ACC_NEW), itemId: ITEM_NEW }] };
    be.txs[ACC_NEW] = [...be.txs[ACC].map((x) => ({ ...(x as object), id: `n-${(x as { id: string }).id}` })), t('n-p4', '2026-11-19', -2500, 'FARMACIA FICTICIA')];
    const st = await refreshConsentStatus(p, old.id);
    expect(st.status).toBe('expired'); // item antigo saiu de PLUGGY_ITEM_IDS
    const rec = await connect(p, ITEM_NEW);
    const pv = await syncConnection(p, rec.id, RANGE, { dryRun: true });
    expect(pv.rows[0]).toMatchObject({ localAccountId: localId, relinked: true, newCount: 1, possibleDuplicateCount: 3 });
    const r = await syncConnection(p, rec.id, RANGE);
    expect(r).toMatchObject({ added: 1, possibleDuplicates: 3 });
    expect(F.getFinance().accounts.find((a) => a.id === localId)?.providerRef).toMatchObject({ externalId: ACC_NEW, connectionRef: ITEM_NEW });
    expect(F.getFinance().transactions.filter((x) => x.accountId === localId)).toHaveLength(4);
    await forgetConnection(old.id);
    expect(F.getFinance().transactions.filter((x) => x.accountId === localId)).toHaveLength(4); // esquecer não apaga dados
  });

  it('autorização expirada: sincronizar não lê (a Pluggy devolveria vazio) e marca expirado sem apagar nada', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    await syncConnection(p, rec.id, RANGE);
    be.items[0] = { ...be.items[0], status: 'LOGIN_ERROR', consentStatus: 'expired', message: 'Autorização expirada: renove em meu.pluggy.ai.' };
    const before = be.calls.length;
    const r = await syncConnection(p, rec.id, RANGE);
    expect(r.errors[0]).toMatch(/expirada/);
    expect(F.getFinance().consents[0].status).toBe('expired');
    expect(F.getFinance().transactions).toHaveLength(6);
    expect(be.calls.slice(before).some((c) => c.startsWith('/api/pluggy/accounts'))).toBe(false);
  });

  it('erros do servidor local viram estados da conexão (429, não configurado, sem servidor)', async () => {
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    be.fail = { status: 429, body: { error: 'A Pluggy pediu para aguardar (limite de requisições).', code: 'rate_limited' }, headers: { 'retry-after': '60' } };
    const r = await syncConnection(p, rec.id, RANGE);
    expect(r.errors[0]).toMatch(/aguardar.*60 s/);
    expect(F.getFinance().consents[0]).toMatchObject({ status: 'error', lastError: 'temporary' });
    be.fail = { status: 200, body: { configured: false, problems: ['PLUGGY_CLIENT_ID ausente.'] } };
    const st = await p.status(0);
    expect(st).toEqual({ configured: false, problems: ['PLUGGY_CLIENT_ID ausente.'] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(p.status(0)).rejects.toThrow(/Servidor local do Aurora indisponível/);
  });

  it('respostas fora do formato são descartadas e revogar na origem não existe aqui', async () => {
    be.accounts[ITEM] = [bankAcc(), { id: 'nao-uuid', type: 'checking', currency: 'BRL' }, { ...cardAcc(), currency: 'JPY' }];
    be.txs[ACC] = [t('ok', '2026-11-05', 100, 'OK'), { id: 'x', postedDate: '2026-13-40', amountCents: 5, description: 'data ruim' }, { id: 'y', postedDate: '2026-11-05', amountCents: 1.5, description: 'centavo quebrado' }];
    const p = new PluggyPersonalProvider();
    const rec = await connect(p);
    const r = await syncConnection(p, rec.id, RANGE);
    expect(r).toMatchObject({ accounts: 1, added: 1 });
    await expect(p.revokeConsent()).rejects.toThrow(/meu\.pluggy\.ai/);
  });
});
