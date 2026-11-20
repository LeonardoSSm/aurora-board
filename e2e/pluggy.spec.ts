/**
 * Issue #9 — Minhas contas → Conectores → Meu Pluggy, OFFLINE: o servidor local é simulado por page.route
 * (/api/pluggy/*). Nenhuma credencial, nenhuma chamada à Pluggy, só dados inventados.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { ready } from './helpers';

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACC = '0b0b0b0b-1111-4222-8333-444444444444';
const CARD = '0c0c0c0c-1111-4222-8333-444444444444';

interface Fake { status: unknown; accounts: unknown[]; txs: Record<string, unknown[]>; fail?: { status: number; body: unknown; headers?: Record<string, string> }; calls: string[] }

function fake(): Fake {
  return {
    status: { configured: true, readOnly: true, items: [{ itemId: ITEM, connectorName: 'MeuPluggy', status: 'UPDATED', consentStatus: 'active', consentExpiresAt: '2027-11-01T00:00:00.000Z', lastUpdatedAt: '2026-11-19T08:00:00.000Z' }] },
    accounts: [
      { id: ACC, itemId: ITEM, name: 'Conta Corrente', type: 'checking', currency: 'BRL', numberTail: '3450', institutionName: 'Nubank', balance: { cents: 152037, asOf: '2026-11-19' } },
      { id: CARD, itemId: ITEM, name: 'Nubank Ultravioleta', type: 'credit_card', currency: 'BRL', numberTail: '4321', institutionName: 'Nubank', balance: { cents: -8990, asOf: '2026-11-19' }, card: { limitCents: 500000 } },
    ],
    txs: {
      [ACC]: [
        { id: 'p1', postedDate: '2026-11-05', amountCents: 500000, description: 'SALARIO EMPRESA FICTICIA', status: 'posted' },
        { id: 'p2', postedDate: '2026-11-10', amountCents: -1050, description: 'PADARIA FICTICIA', status: 'posted' },
        { id: 'p3', postedDate: '2026-11-14', amountCents: -2500, description: 'FARMACIA FICTICIA', status: 'posted' },
      ],
      [CARD]: [{ id: 'c1', postedDate: '2026-11-03', amountCents: -8990, description: 'IFOOD *PEDIDO', status: 'posted' }],
    },
    calls: [],
  };
}

async function mockServer(page: Page, f: Fake) {
  await page.route('**/api/pluggy/**', async (route: Route) => {
    const u = new URL(route.request().url());
    f.calls.push(u.pathname);
    if (f.fail) return route.fulfill({ status: f.fail.status, contentType: 'application/json', headers: f.fail.headers, body: JSON.stringify(f.fail.body) });
    const body = u.pathname.endsWith('/status') ? f.status : u.pathname.endsWith('/accounts') ? { accounts: f.accounts } : { transactions: f.txs[u.searchParams.get('accountId') ?? ''] ?? [], invalid: 0, pages: 1 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function openConnectors(page: Page) {
  await page.getByTestId('open-finance').click();
  await expect(page.getByTestId('finance-hub')).toBeVisible();
  await page.getByTestId('finance-tab-connectors').click();
}
interface FinView { accounts: { name: string; type: string; origin: string; since?: string }[]; txs: { d: string; a: string }[] }
const finState = (page: Page): Promise<FinView> => page.evaluate(() => { const f = (window as any).__aurora.finance.getFinance(); return { accounts: f.accounts.map((a: any) => ({ name: a.name, type: a.type, origin: a.origin, since: a.providerRef?.since })), txs: f.transactions.map((t: any) => ({ d: t.description, a: t.accountId })) }; });

test.describe('Meu Pluggy (offline)', () => {
  test('não configurado: explica o que falta, sem conta real e sem dados fictícios misturados', async ({ page }) => {
    const f = fake();
    f.status = { configured: false, problems: ['Meu Pluggy não configurado: defina PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEM_IDS no .env do servidor local.'] };
    await mockServer(page, f);
    await ready(page);
    await openConnectors(page);
    const card = page.getByTestId('pluggy-card');
    await expect(card.getByTestId('pluggy-real-badge')).toHaveText('DADOS REAIS · SOMENTE LEITURA');
    await expect(card.getByTestId('pluggy-summary')).toContainText('Nenhuma conta real conectada');
    expect(f.calls).toEqual([]); // nada é consultado sem o usuário pedir
    await card.getByTestId('pluggy-check').click();
    await expect(card.getByTestId('pluggy-not-configured')).toContainText('PLUGGY_CLIENT_SECRET');
    await expect(page.getByTestId('mock-banner')).toHaveCount(0);
    await card.getByTestId('pluggy-howto').locator('summary').click();
    await expect(card.getByTestId('pluggy-howto').getByRole('link', { name: 'meu.pluggy.ai', exact: true })).toHaveAttribute('rel', /noopener/);
  });

  test('configurado: adicionar item, prévia, vincular conta CSV existente e sincronizar sem duplicar', async ({ page }) => {
    const f = fake();
    const external: string[] = [];
    page.on('request', (r) => { if (/pluggy\.ai/.test(new URL(r.url()).hostname)) external.push(r.url()); });
    await mockServer(page, f);
    await ready(page);
    // Conta já existente com histórico importado de CSV até 10/11.
    await page.evaluate(async () => {
      const F = (window as any).__aurora.finance;
      await F.ensureFinanceLoaded();
      const acc = await F.createAccount({ institutionName: 'Nubank', name: 'Nubank extrato', type: 'checking' });
      const plan = F.prepareImport(acc.id, { drafts: [{ line: 1, postedDate: '2026-11-05', amountCents: 500000, description: 'Salário - TED', status: 'posted' }, { line: 2, postedDate: '2026-11-10', amountCents: -1050, description: 'Padaria', status: 'posted' }], invalid: [], ignored: [], warnings: [] });
      await F.commitImportPlan(plan, { origin: 'csv', fileName: 'nubank.csv' });
    });
    await openConnectors(page);
    const card = page.getByTestId('pluggy-card');
    await card.getByTestId('pluggy-check').click();
    const item = card.getByTestId('pluggy-item');
    await expect(item).toContainText('MeuPluggy');
    await expect(item).toContainText('autorização até');
    await item.getByTestId('pluggy-add').click();
    const conn = card.getByTestId('pluggy-connection');
    await expect(conn.getByTestId('pluggy-state')).toHaveText('Conectado');

    await conn.getByTestId('pluggy-preview').click();
    const rows = conn.getByTestId('pluggy-preview-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId('pluggy-row-new')).toHaveText('3');
    expect((await finState(page)).accounts).toHaveLength(1); // prévia não grava nada

    // Vincula a conta corrente da Pluggy à conta do CSV: só entra o que vier depois de 10/11.
    const sel = rows.first().getByTestId('pluggy-link-select');
    const value = await sel.locator('option', { hasText: 'Nubank extrato' }).getAttribute('value');
    await sel.selectOption(value!);
    await expect(rows.first().getByTestId('pluggy-row-target')).toContainText('só a partir de 11/11/2026');
    await expect(rows.first().getByTestId('pluggy-row-new')).toHaveText('1');

    await conn.getByTestId('pluggy-sync').click();
    await expect(conn.getByTestId('pluggy-state')).toHaveText('Atualizado');
    const st = await finState(page);
    expect(st.accounts.map((a) => [a.name, a.type, a.origin, a.since])).toEqual([['Nubank extrato', 'checking', 'manual', '2026-11-11'], ['Nubank Ultravioleta', 'credit_card', 'provider', undefined]]);
    expect(st.txs.map((t) => t.d).sort()).toEqual(['FARMACIA FICTICIA', 'IFOOD *PEDIDO', 'Padaria', 'Salário - TED']);

    // Sincronizar de novo não duplica.
    await conn.getByTestId('pluggy-sync').click();
    await expect(page.getByText(/0 nova\(s\)/).first()).toBeVisible();
    expect((await finState(page)).txs).toHaveLength(4);
    expect(external, 'o navegador nunca fala com a Pluggy diretamente').toEqual([]);
  });

  test('autorização expirada e limite da Pluggy viram estados claros, sem apagar dados', async ({ page }) => {
    const f = fake();
    await mockServer(page, f);
    await ready(page);
    await openConnectors(page);
    const card = page.getByTestId('pluggy-card');
    await card.getByTestId('pluggy-check').click();
    await card.getByTestId('pluggy-add').click();
    const conn = card.getByTestId('pluggy-connection');
    await conn.getByTestId('pluggy-sync').click();
    await expect(conn.getByTestId('pluggy-state')).toHaveText('Atualizado');
    const synced = (await finState(page)).txs.length;

    f.fail = { status: 429, body: { error: 'A Pluggy pediu para aguardar (limite de requisições).', code: 'rate_limited' }, headers: { 'retry-after': '60' } };
    await conn.getByTestId('pluggy-sync').click();
    await expect(page.getByText(/aguardar.*60 s/).first()).toBeVisible();
    await expect(conn.getByTestId('pluggy-state')).toHaveText('Falha temporária');

    f.fail = undefined;
    f.status = { configured: true, readOnly: true, items: [{ itemId: ITEM, connectorName: 'MeuPluggy', status: 'LOGIN_ERROR', consentStatus: 'expired', message: 'Autorização expirada: renove em meu.pluggy.ai (o itemId pode mudar; atualize PLUGGY_ITEM_IDS).' }] };
    await conn.getByTestId('pluggy-sync').click();
    await expect(conn.getByTestId('pluggy-state')).toHaveText('Consentimento expirado');
    expect((await finState(page)).txs).toHaveLength(synced);
    await card.getByTestId('pluggy-check').click();
    await expect(conn.getByTestId('pluggy-item-message')).toContainText('renove em meu.pluggy.ai');
  });
});
