/**
 * Issue #9 — adaptador Meu Pluggy no servidor local (server/pluggy.ts + rotas em server/app.ts).
 * Pluggy FALSA em memória: nenhuma chamada de rede, nenhuma credencial real. Todos os identificadores, valores e
 * segredos abaixo são inventados.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type PluggyDeps } from '../../server/app';
import { PairingStore } from '../../server/pairing';
import { nextCursor, normalizeAccount, normalizeItem, normalizeTransaction, PluggyClient, PluggyError, readPluggyConfig, toCents, toCivilDate, type PluggyFetch } from '../../server/pluggy';

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'segredo-de-teste-NAO-REAL-0123456789';
const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ITEM2 = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const ACC = '0b0b0b0b-1111-4222-8333-444444444444';
const CARD = '0c0c0c0c-1111-4222-8333-444444444444';
const API_KEY = 'apikey-ficticia-xyz-000000';
const config = { clientId: CLIENT_ID, clientSecret: SECRET, itemIds: [ITEM] };

interface Call { method: string; url: URL; headers: Record<string, string>; body?: string }
type Handler = (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<never>;

function fakePluggy(routes: Partial<Record<string, Handler>> & { auth?: Handler } = {}) {
  const calls: Call[] = [];
  let auths = 0;
  const f: PluggyFetch = async (url, init) => {
    const c: Call = { method: init.method, url: new URL(url), headers: init.headers, body: init.body };
    calls.push(c);
    expect(init.redirect).toBe('error');
    const key = `${init.method} ${c.url.pathname}`;
    let h = routes[key] ?? (c.url.pathname.startsWith('/items/') ? routes['GET /items/:id'] : undefined);
    if (key === 'POST /auth') { auths++; h = routes.auth ?? (() => ({ status: 200, body: { apiKey: API_KEY } })); }
    if (!h) return resp({ status: 404, body: { code: 404, codeDescription: 'NOT_FOUND', message: 'not found' } });
    if (key !== 'POST /auth' && c.headers['x-api-key'] !== API_KEY) return resp({ status: 401, body: { code: 401, message: 'unauthorized' } });
    return resp(await h(c));
  };
  return { fetch: f, calls, auths: () => auths };
}
function resp(r: { status: number; body?: unknown; headers?: Record<string, string> }) {
  const text = r.body === undefined ? '' : JSON.stringify(r.body);
  return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => text };
}

const accountsBody = {
  page: 1, total: 2, totalPages: 1,
  results: [
    { id: ACC, type: 'BANK', subtype: 'CHECKING_ACCOUNT', number: '0001/12345-0', name: 'Conta Corrente', balance: 1520.37, currencyCode: 'BRL', itemId: ITEM, taxNumber: '000.000.000-00', owner: 'TITULAR FICTICIO', bankData: { transferNumber: '260/0001/12345-0', closingBalance: 1500 } },
    { id: CARD, type: 'CREDIT', subtype: 'CREDIT_CARD', number: '4321', name: 'Cartão Fictício', marketingName: 'Nubank Ultravioleta', balance: 842.1, currencyCode: 'BRL', itemId: ITEM, creditData: { creditLimit: 5000, availableCreditLimit: 4157.9, balanceCloseDate: '2026-11-25', balanceDueDate: '2026-12-02T00:00:00.000Z', brand: 'MASTERCARD' } },
  ],
};
const tx = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, accountId: ACC, description: `COMPRA ${id}`, currencyCode: 'BRL', amount, date: '2026-11-10T00:00:00.000Z', status: 'POSTED', type: amount < 0 ? 'DEBIT' : 'CREDIT', paymentData: { payer: { documentNumber: { type: 'CPF', value: '000.000.000-00' } } }, ...extra });

function standardRoutes(pages: unknown[][] = [[tx('t1', -10.5), tx('t2', 2500)]]): Partial<Record<string, Handler>> {
  return {
    'GET /items/:id': (c) => ({ status: 200, body: { id: c.url.pathname.split('/').pop(), status: 'UPDATED', executionStatus: 'SUCCESS', connector: { id: 200, name: 'MeuPluggy' }, consentExpiresAt: '2027-11-01T00:00:00.000Z', lastUpdatedAt: '2026-11-19T08:00:00.000Z', error: null } }),
    'GET /accounts': () => ({ status: 200, body: accountsBody }),
    'GET /v2/transactions': (c) => {
      const after = c.url.searchParams.get('after');
      const i = after ? Number(after.replace('cur', '')) : 0;
      const next = i + 1 < pages.length ? `?accountId=${ACC}&after=cur${i + 1}` : null;
      return { status: 200, body: { results: pages[i], next } };
    },
  };
}

describe('configuração (.env)', () => {
  it('ausente → não configurado, sem chamar a Pluggy', () => {
    const r = readPluggyConfig({});
    expect(r).toMatchObject({ config: null, present: false });
    expect(r.problems[0]).toMatch(/PLUGGY_CLIENT_ID/);
  });
  it('incompleta ou inválida → problemas descritos SEM ecoar valores', () => {
    const r = readPluggyConfig({ PLUGGY_CLIENT_ID: 'nao-e-uuid', PLUGGY_CLIENT_SECRET: SECRET, PLUGGY_ITEM_IDS: `${ITEM}, invalido` });
    expect(r.config).toBeNull();
    expect(r.problems.join(' ')).toMatch(/UUID/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain('nao-e-uuid');
  });
  it('válida: lista de itens normalizada (vírgula/espaço, minúsculas, sem repetição)', () => {
    const r = readPluggyConfig({ PLUGGY_CLIENT_ID: CLIENT_ID, PLUGGY_CLIENT_SECRET: SECRET, PLUGGY_ITEM_IDS: `${ITEM.toUpperCase()} ${ITEM2},${ITEM}` });
    expect(r.config?.itemIds).toEqual([ITEM, ITEM2]);
  });
});

describe('normalização', () => {
  it('centavos por texto (sem erro de ponto flutuante)', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(-212.45)).toBe(-21245);
    expect(toCents(1234567.89)).toBe(123456789);
    expect(toCents(Number.NaN)).toBeNull();
    expect(toCents('10')).toBeNull();
    expect(toCents(1e12)).toBeNull();
  });
  it('datas: meia-noite UTC é data civil; com hora converte para Brasília', () => {
    expect(toCivilDate('2026-11-10T00:00:00.000Z')).toBe('2026-11-10');
    expect(toCivilDate('2026-11-10T02:30:00.000Z')).toBe('2026-11-09');
    expect(toCivilDate('2026-11-10T15:00:00.000Z')).toBe('2026-11-10');
    expect(toCivilDate('2026-02-30')).toBeNull();
    expect(toCivilDate('ontem')).toBeNull();
  });
  it('conta: instituição pelo COMPE, só final do número, sem titular/CPF; cartão com dívida negativa', () => {
    const bank = normalizeAccount(accountsBody.results[0], ITEM, 'Meu Pluggy', '2026-11-19')!;
    expect(bank).toMatchObject({ id: ACC, type: 'checking', institutionName: 'Nubank', numberTail: '3450', balance: { cents: 152037 } });
    expect(JSON.stringify(bank)).not.toMatch(/000\.000|TITULAR|12345/);
    const card = normalizeAccount(accountsBody.results[1], ITEM, 'Meu Pluggy', '2026-11-19')!;
    expect(card).toMatchObject({ type: 'credit_card', institutionName: 'Nubank', numberTail: '4321', balance: { cents: -84210 }, card: { limitCents: 500000, availableLimitCents: 415790, closingDay: 25, dueDay: 2 } });
    expect(normalizeAccount({ ...accountsBody.results[0], currencyCode: 'JPY' }, ITEM, 'x', '2026-11-19')).toBeNull();
    expect(normalizeAccount({ id: 'x' }, ITEM, 'x', '2026-11-19')).toBeNull();
  });
  it('movimentação: sinal do razão, parcelas, sem paymentData; inválidas recusadas', () => {
    const acc = { id: ACC, type: 'checking' as const, currency: 'BRL' as const };
    const card = { id: CARD, type: 'credit_card' as const, currency: 'BRL' as const };
    expect(normalizeTransaction(tx('a', -212.45), acc)).toMatchObject({ amountCents: -21245, postedDate: '2026-11-10', status: 'posted' });
    // Conta: valor absoluto com type DEBIT vira saída.
    expect(normalizeTransaction(tx('b', 50, { type: 'DEBIT' }), acc)?.amountCents).toBe(-5000);
    // Cartão: positivo = compra (dívida) → negativo no razão; negativo = pagamento → positivo.
    expect(normalizeTransaction(tx('c', 99.9, { type: 'DEBIT', creditCardMetadata: { installmentNumber: 2, totalInstallments: 6, purchaseDate: '2026-09-10T00:00:00.000Z' } }), card)).toMatchObject({ amountCents: -9990, installment: { index: 2, count: 6 }, operationDate: '2026-09-10' });
    expect(normalizeTransaction(tx('d', -500, { type: 'CREDIT' }), card)?.amountCents).toBe(50000);
    expect(normalizeTransaction(tx('e', 10, { status: 'PENDING' }), acc)?.status).toBe('pending');
    const out = JSON.stringify(normalizeTransaction(tx('f', -1), acc));
    expect(out).not.toMatch(/documentNumber|CPF|000\.000/);
    expect(normalizeTransaction(tx('g', 0), acc)).toBeNull();
    expect(normalizeTransaction(tx('h', 10, { currencyCode: 'USD' }), acc)).toBeNull();
    expect(normalizeTransaction(tx('i', 10, { currencyCode: 'USD', amountInAccountCurrency: 52.3 }), acc)?.amountCents).toBe(5230);
    expect(normalizeTransaction(tx('j', 10, { date: 'xx' }), acc)).toBeNull();
    expect(normalizeTransaction({ ...tx('k', 10), id: '../etc' }, acc)).toBeNull();
  });
  it('item: expirado, revogado, pendente, desatualizado e com erro de login', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const base = { id: ITEM, status: 'UPDATED', executionStatus: 'SUCCESS', connector: { name: 'MeuPluggy' } };
    expect(normalizeItem(base, ITEM, now).consentStatus).toBe('active');
    expect(normalizeItem({ ...base, consentExpiresAt: '2026-11-01T00:00:00Z' }, ITEM, now).consentStatus).toBe('expired');
    expect(normalizeItem({ ...base, status: 'LOGIN_ERROR', executionStatus: 'USER_AUTHORIZATION_EXPIRED' }, ITEM, now)).toMatchObject({ consentStatus: 'expired', message: expect.stringMatching(/itemId pode mudar/) });
    expect(normalizeItem({ ...base, status: 'LOGIN_ERROR', error: { code: 'USER_AUTHORIZATION_REVOKED' } }, ITEM, now).consentStatus).toBe('revoked');
    expect(normalizeItem({ ...base, status: 'WAITING_USER_INPUT' }, ITEM, now).consentStatus).toBe('awaiting');
    expect(normalizeItem({ ...base, status: 'OUTDATED' }, ITEM, now)).toMatchObject({ consentStatus: 'active', message: expect.stringMatching(/desatualizados/) });
    expect(normalizeItem({ ...base, status: 'LOGIN_ERROR', executionStatus: 'ERROR' }, ITEM, now).consentStatus).toBe('error');
    expect(normalizeItem('lixo', ITEM, now).consentStatus).toBe('error');
  });
  it('cursor: só query string relativa; nunca segue outro host', () => {
    expect(nextCursor(null)).toBeNull();
    expect(nextCursor(`?accountId=${ACC}&after=abc123`)).toBe('abc123');
    expect(() => nextCursor('https://evil.example/v2/transactions?after=x')).toThrow(PluggyError);
    expect(() => nextCursor('//evil.example/?after=x')).toThrow(PluggyError);
    expect(() => nextCursor('?after=a b')).toThrow(PluggyError);
    expect(nextCursor('?accountId=x')).toBeNull();
  });
});

describe('cliente HTTP (Pluggy falsa)', () => {
  it('autentica uma vez, reaproveita a chave, pagina por cursor e só fala com api.pluggy.ai', async () => {
    const p = fakePluggy(standardRoutes([[tx('t1', -10.5)], [tx('t2', 25)], [tx('t3', -1), { lixo: true }]]));
    const c = new PluggyClient(config, { fetch: p.fetch, sleep: async () => {} });
    const r = await c.transactions(ITEM, ACC, { from: '2026-08-01', to: '2026-11-19' });
    expect(r.transactions.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(r).toMatchObject({ invalid: 1, pages: 3 });
    expect(p.auths()).toBe(1);
    for (const call of p.calls) {
      expect(call.url.origin).toBe('https://api.pluggy.ai');
      expect(call.url.href).not.toContain(SECRET);
      expect(call.url.href).not.toContain(API_KEY);
    }
    const txCalls = p.calls.filter((x) => x.url.pathname === '/v2/transactions');
    expect(txCalls).toHaveLength(3);
    // Só parâmetros documentados (a Pluggy recusa parâmetros desconhecidos a partir de 23/11/2026).
    for (const call of txCalls) expect([...call.url.searchParams.keys()].every((k) => ['accountId', 'dateFrom', 'dateTo', 'after'].includes(k))).toBe(true);
    expect(txCalls[1].url.searchParams.get('after')).toBe('cur1');
    expect(p.calls.some((x) => x.url.pathname === '/transactions')).toBe(false); // nunca o endpoint legado
    const auth = p.calls.find((x) => x.url.pathname === '/auth')!;
    expect(JSON.parse(auth.body!)).toEqual({ clientId: CLIENT_ID, clientSecret: SECRET });
  });
  it('renova a API Key quando expira e depois de um 401', async () => {
    let t = 0;
    let reject = false;
    const routes = standardRoutes();
    const p = fakePluggy({ ...routes, 'GET /accounts': (c) => (reject ? ((reject = false), { status: 401, body: { message: 'expired' } }) : routes['GET /accounts']!(c)) });
    const c = new PluggyClient(config, { fetch: p.fetch, now: () => t, sleep: async () => {}, limits: { accountsCacheMs: 0 } });
    await c.accounts(ITEM);
    expect(p.auths()).toBe(1);
    t += 101 * 60_000; // passou da validade local (100 min)
    await c.accounts(ITEM);
    expect(p.auths()).toBe(2);
    reject = true;
    await c.accounts(ITEM);
    expect(p.auths()).toBe(3);
  });
  it('credenciais recusadas → auth_failed sem ecoar o segredo', async () => {
    const p = fakePluggy({ ...standardRoutes(), auth: () => ({ status: 401, body: { code: 401, codeDescription: 'CLIENT_KEYS_UNAUTHORIZED', message: `bad ${SECRET}` } }) });
    const c = new PluggyClient(config, { fetch: p.fetch });
    const e = (await c.accounts(ITEM).then(() => null, (x: unknown) => x)) as PluggyError;
    expect(e).toBeInstanceOf(PluggyError);
    expect(e).toMatchObject({ code: 'auth_failed', upstream: 'CLIENT_KEYS_UNAUTHORIZED' });
    expect(e.message).not.toContain(SECRET);
  });
  it('429 → rate_limited com Retry-After; 410 → deprecated; 404 → not_found', async () => {
    const mk = (status: number, headers?: Record<string, string>) => new PluggyClient(config, { fetch: fakePluggy({ ...standardRoutes(), 'GET /accounts': () => ({ status, body: { code: status, codeDescription: status === 410 ? 'ENDPOINT_DEPRECATED' : undefined }, headers }) }).fetch, sleep: async () => {} });
    await expect(mk(429, { 'retry-after': '60' }).accounts(ITEM)).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 60, status: 429 });
    await expect(mk(410).accounts(ITEM)).rejects.toMatchObject({ code: 'deprecated', upstream: 'ENDPOINT_DEPRECATED' });
    await expect(mk(404).accounts(ITEM)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('5xx e rede: uma nova tentativa; persistindo → unavailable', async () => {
    let n = 0;
    const routes = standardRoutes();
    const flaky = fakePluggy({ ...routes, 'GET /accounts': (c) => (++n === 1 ? { status: 503 } : routes['GET /accounts']!(c)) });
    expect(await new PluggyClient(config, { fetch: flaky.fetch, sleep: async () => {} }).accounts(ITEM)).toHaveLength(2);
    const down: PluggyFetch = async () => { throw new TypeError('fetch failed'); };
    await expect(new PluggyClient(config, { fetch: down, sleep: async () => {} }).accounts(ITEM)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/rede/) });
  });
  it('tetos: páginas, cursor repetido e intervalo de datas', async () => {
    const loop = fakePluggy({ ...standardRoutes(), 'GET /v2/transactions': () => ({ status: 200, body: { results: [tx('x', 1)], next: '?after=sempre-o-mesmo' } }) });
    await expect(new PluggyClient(config, { fetch: loop.fetch }).transactions(ITEM, ACC, { from: '2026-01-01', to: '2026-02-01' })).rejects.toMatchObject({ code: 'bad_response' });
    let i = 0;
    const endless = fakePluggy({ ...standardRoutes(), 'GET /v2/transactions': () => ({ status: 200, body: { results: [], next: `?after=c${++i}` } }) });
    await expect(new PluggyClient(config, { fetch: endless.fetch, limits: { maxPages: 5 } }).transactions(ITEM, ACC, { from: '2026-01-01', to: '2026-02-01' })).rejects.toMatchObject({ code: 'too_large' });
    const c = new PluggyClient(config, { fetch: fakePluggy(standardRoutes()).fetch });
    await expect(c.transactions(ITEM, ACC, { from: '2020-01-01', to: '2026-11-01' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.transactions(ITEM, ACC, { from: '2026-11-02', to: '2026-11-01' })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('conta de outro item ou item não configurado → not_found (sem consultar transações)', async () => {
    const p = fakePluggy(standardRoutes());
    const c = new PluggyClient(config, { fetch: p.fetch });
    await expect(c.transactions(ITEM, '99999999-1111-4222-8333-444444444444', { from: '2026-01-01', to: '2026-02-01' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.accounts(ITEM2)).rejects.toMatchObject({ code: 'not_found' });
    expect(p.calls.some((x) => x.url.pathname === '/v2/transactions')).toBe(false);
  });
  it('status: item que sumiu (renovado com outro itemId) não derruba os demais', async () => {
    const routes = standardRoutes();
    const p = fakePluggy({ ...routes, 'GET /items/:id': (c) => (c.url.pathname.endsWith(ITEM2) ? { status: 404, body: { codeDescription: 'ITEM_NOT_FOUND' } } : routes['GET /items/:id']!(c)) });
    const c = new PluggyClient({ ...config, itemIds: [ITEM, ITEM2] }, { fetch: p.fetch });
    const st = await c.status();
    expect(st.map((s) => [s.itemId, s.consentStatus])).toEqual([[ITEM, 'active'], [ITEM2, 'expired']]);
  });
  it('cancelamento do cliente aborta a chamada à Pluggy', async () => {
    const hang: PluggyFetch = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const ctrl = new AbortController();
    const pr = new PluggyClient(config, { fetch: hang }).accounts(ITEM, ctrl.signal);
    ctrl.abort();
    await expect(pr).rejects.toMatchObject({ code: 'cancelled' });
  });
});

/* ------------------------------------------------------------------ rotas HTTP */

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function start(pluggy: PluggyDeps | null, pairing: PairingStore | null = null) {
  const logs: string[] = [];
  const s = createServer(createApp({ pluggy, pairing, log: (m) => logs.push(m) }));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, logs };
}
async function rawGet(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const { request } = await import('node:http');
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('rotas /api/pluggy', () => {
  it('não configurado: status explica o que falta; dados → 503 not_configured', async () => {
    const { base } = await start({ client: null, problems: readPluggyConfig({}).problems });
    const st = await (await fetch(`${base}/api/pluggy/status`)).json();
    expect(st).toMatchObject({ configured: false, problems: [expect.stringMatching(/PLUGGY_CLIENT_ID/)] });
    const r = await fetch(`${base}/api/pluggy/accounts?itemId=${ITEM}`);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('not_configured');
  });
  it('configurado: status, contas e movimentações sem segredos nem dados de terceiros', async () => {
    const p = fakePluggy(standardRoutes());
    const { base } = await start({ client: new PluggyClient(config, { fetch: p.fetch }), problems: [] });
    const st = await (await fetch(`${base}/api/pluggy/status`)).text();
    const acc = await (await fetch(`${base}/api/pluggy/accounts?itemId=${ITEM}`)).text();
    const txr = await fetch(`${base}/api/pluggy/transactions?itemId=${ITEM}&accountId=${ACC}&from=2026-08-01&to=2026-11-19`);
    const txt = await txr.text();
    expect(txr.status).toBe(200);
    expect(JSON.parse(st)).toMatchObject({ configured: true, readOnly: true, items: [{ itemId: ITEM, consentStatus: 'active', connectorName: 'MeuPluggy' }] });
    expect(JSON.parse(acc).accounts).toHaveLength(2);
    expect(JSON.parse(txt).transactions).toHaveLength(2);
    for (const body of [st, acc, txt]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain(CLIENT_ID);
      expect(body).not.toMatch(/000\.000\.000|TITULAR|taxNumber|paymentData/);
    }
  });
  it('item fora de PLUGGY_ITEM_IDS → 404 sem chamar a Pluggy; escrita → 405', async () => {
    const p = fakePluggy(standardRoutes());
    const { base } = await start({ client: new PluggyClient(config, { fetch: p.fetch }), problems: [] });
    expect((await fetch(`${base}/api/pluggy/accounts?itemId=${ITEM2}`)).status).toBe(404);
    expect((await fetch(`${base}/api/pluggy/transactions?itemId=../../auth&accountId=${ACC}&from=2026-01-01&to=2026-02-01`)).status).toBe(404);
    expect(p.calls).toHaveLength(0);
    const post = await fetch(`${base}/api/pluggy/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(405);
  });
  it('429 da Pluggy chega ao navegador com Retry-After; erro 5xx não vaza segredo no log', async () => {
    const p = fakePluggy({ ...standardRoutes(), 'GET /accounts': () => ({ status: 429, headers: { 'retry-after': '60' }, body: { code: 429 } }) });
    const { base } = await start({ client: new PluggyClient(config, { fetch: p.fetch }), problems: [] });
    const r = await fetch(`${base}/api/pluggy/accounts?itemId=${ITEM}`);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await r.json()).code).toBe('rate_limited');
    const down = fakePluggy({ ...standardRoutes(), auth: () => ({ status: 500, body: { message: SECRET } }) });
    const s2 = await start({ client: new PluggyClient(config, { fetch: down.fetch, sleep: async () => {} }), problems: [] });
    const r2 = await fetch(`${s2.base}/api/pluggy/status`);
    expect(r2.status).toBe(503);
    expect(await r2.text()).not.toContain(SECRET);
    expect(s2.logs.join('\n')).not.toContain(SECRET);
  });
  it('Host externo e Origin de outro site continuam recusados (S1)', async () => {
    const { base } = await start({ client: new PluggyClient(config, { fetch: fakePluggy(standardRoutes()).fetch }), problems: [] });
    expect((await rawGet(base, '/api/pluggy/status', { host: 'evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/api/pluggy/status`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('dispositivo pareado: bloqueado por padrão; leitura só com AURORA_PLUGGY_PAIRED_READ=1', async () => {
    const LAN = '10.0.0.109:5174';
    const remote = { 'x-aurora-remote': '1', 'x-aurora-remote-addr': '10.0.0.50', host: LAN, origin: `http://${LAN}` };
    const pairDevice = async (base: string) => {
      const { code } = await (await fetch(`${base}/api/pairing/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      const { request } = await import('node:http');
      const u = new URL('/api/pairing/claim', base);
      return new Promise<string>((resolve, reject) => {
        const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...remote, 'content-type': 'application/json' } }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(JSON.parse(d).token));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ code, name: 'Notebook' }));
      });
    };
    const p = fakePluggy(standardRoutes());
    const blocked = await start({ client: new PluggyClient(config, { fetch: p.fetch }), problems: [] }, new PairingStore());
    const t1 = await pairDevice(blocked.base);
    const r1 = await rawGet(blocked.base, '/api/pluggy/status', { ...remote, authorization: `Bearer ${t1}` });
    expect(r1.status).toBe(403);
    expect(JSON.parse(r1.text).code).toBe('local_only');
    // Sem token, nem chega na política do Pluggy.
    expect((await rawGet(blocked.base, '/api/pluggy/status', remote)).status).toBe(401);
    expect(p.calls).toHaveLength(0);
    const open = await start({ client: new PluggyClient(config, { fetch: p.fetch }), problems: [], allowPaired: true }, new PairingStore());
    const t2 = await pairDevice(open.base);
    const r2 = await rawGet(open.base, '/api/pluggy/status', { ...remote, authorization: `Bearer ${t2}` });
    expect(r2.status).toBe(200);
    expect(r2.text).not.toContain(SECRET);
  });
});
