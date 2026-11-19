/**
 * Ciclo F1 — Minhas contas (jornadas A–H). Somente dados FICTÍCIOS; nenhuma rede externa (a IA é simulada por
 * page.route; o provedor bancário é o fictício do próprio app).
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state } from './helpers';

const CSV_A = 'Data;Descrição;Valor\n05/11/2026;SALARIO EMPRESA FICTICIA;2.000,00\n06/11/2026;TED ENVIADA CONTA B;-500,00\n20/11/2026;PAGAMENTO FATURA CARTAO;-300,00\n';
const CSV_B = 'Data;Descrição;Valor\n06/11/2026;TED RECEBIDA CONTA A;500,00\n';
const OFX_CARD = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Banco Ficticio B</FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL<CCACCTFROM><ACCTID>5555444433339999</CCACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261130
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261110<TRNAMT>-300.00<FITID>C1<NAME>LOJA FICTICIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261120<TRNAMT>300.00<FITID>C2<NAME>PAGAMENTO RECEBIDO</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261122<TRNAMT>50.00<FITID>C3<NAME>ESTORNO LOJA FICTICIA</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
const CSV_PAY = 'Data;Descrição;Valor\n05/11/2026;SALARIO EMPRESA FICTICIA;2.000,00\n20/11/2026;PAGAMENTO FATURA CARTAO;-300,00\n';
const CSV_SPEND = 'Data;Descrição;Valor\n05/11/2026;SALARIO EMPRESA FICTICIA;5.000,00\n07/11/2026;UBER VIAGEM;-42,50\n08/11/2026;IFOOD PEDIDO;-120,00\n09/11/2026;=HYPERLINK("http://exemplo.invalid","x");-1,00\n';

async function openHub(page: Page) {
  await page.getByTestId('open-finance').click();
  await expect(page.getByTestId('finance-hub')).toBeVisible();
}
async function tab(page: Page, id: string) {
  await page.getByTestId(`finance-tab-${id}`).click();
}
async function addAccount(page: Page, a: { institution: string; name: string; type?: string; opening?: string; openingDate?: string }) {
  await tab(page, 'accounts');
  await page.getByTestId('add-account').click();
  const form = page.getByTestId('account-form');
  await form.getByLabel('Instituição').fill(a.institution);
  await form.getByLabel('Nome da conta').fill(a.name);
  if (a.type) await form.getByLabel('Tipo de conta').selectOption({ label: a.type });
  if (a.opening) {
    await form.getByLabel('Saldo inicial', { exact: true }).fill(a.opening);
    await form.getByLabel('Data do saldo inicial').fill(a.openingDate ?? '2026-11-01');
  }
  await page.getByTestId('account-save').click();
  await expect(page.getByTestId('account-form')).toHaveCount(0);
}
async function importFile(page: Page, account: string, name: string, content: string | Buffer, opts: { expectNew?: number; confirm?: boolean } = {}) {
  await page.getByTestId('open-import').click();
  await page.getByTestId('import-file').setInputFiles({ name, mimeType: 'text/plain', buffer: typeof content === 'string' ? Buffer.from(content, 'utf8') : content });
  const value = await page.getByTestId('import-account').locator('option', { hasText: account }).first().getAttribute('value');
  await page.getByTestId('import-account').selectOption(value!);
  await page.getByTestId('import-review').click();
  await expect(page.getByTestId('import-preview')).toBeVisible();
  if (opts.expectNew !== undefined) await expect(page.getByTestId('import-new')).toHaveText(String(opts.expectNew));
  if (opts.confirm !== false) {
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('import-wizard')).toHaveCount(0);
  }
}
async function gotoMonth(page: Page, label: string) {
  for (let i = 0; i < 36; i++) {
    const cur = (await page.getByTestId('finance-month').innerText()).trim();
    if (cur.includes(label)) return;
    const [mName, y] = label.split(' ');
    const target = Number(y) * 12 + ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'].indexOf(mName);
    const m = /(\S+)\s+(\d{4})/.exec(cur.replace(/[‹›]/g, '').trim())!;
    const now = Number(m[2]) * 12 + ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'].indexOf(m[1]);
    await page.getByRole('button', { name: now > target ? 'Mês anterior' : 'Mês seguinte' }).click();
  }
  throw new Error(`mês ${label} não encontrado`);
}
/** Valor em reais como o Intl formata (espaço não separável entre R$ e o número). */
const money = (v: string, prefix = '') => new RegExp(`${prefix}R\\$\\s${v.replace(/\./g, '\\.')}`);
const finState = (page: Page) => page.evaluate(() => { const f = (window as any).__aurora.finance.getFinance(); return { txs: f.transactions.length, accounts: f.accounts.length, imports: f.imports.length, descriptions: f.transactions.map((t: any) => t.description) }; });

test.describe('Ciclo F1 — Minhas contas', () => {
  test('A: importação CSV com prévia, confirmação e integridade após recarregar', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await expect(page.getByTestId('finance-empty')).toBeVisible();
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    await importFile(page, 'Conta A', 'extrato-a.csv', CSV_A, { confirm: false, expectNew: 3 });
    // Antes de confirmar: nada gravado.
    expect((await finState(page)).txs).toBe(0);
    await expect(page.getByTestId('import-summary')).toContainText('R$ 2.000,00');
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('import-wizard')).toHaveCount(0);
    await page.reload();
    await ready(page);
    await openHub(page);
    await tab(page, 'transactions');
    await expect(page.getByTestId('tx-count')).toContainText('3 movimentação(ões)');
    await tab(page, 'imports');
    await expect(page.getByTestId('import-row')).toHaveCount(1);
    await expect(page.getByTestId('import-row-accepted')).toHaveText('3');
  });

  test('B: reimportar o mesmo extrato não duplica', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    await importFile(page, 'Conta A', 'extrato-a.csv', CSV_A, { expectNew: 3 });
    await importFile(page, 'Conta A', 'extrato-a.csv', CSV_A, { confirm: false, expectNew: 0 });
    await expect(page.getByTestId('import-dup')).toHaveText('3');
    await expect(page.getByTestId('import-confirm')).toBeDisabled();
    await page.getByTestId('import-cancel').click();
    expect((await finState(page)).txs).toBe(3);
  });

  test('C: duas contas — transferência interna fora da receita, saldos e consolidado', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A', opening: '1.000,00' });
    await addAccount(page, { institution: 'Banco Fictício B', name: 'Conta B', opening: '0,00' });
    await importFile(page, 'Conta A', 'a.csv', CSV_A);
    await importFile(page, 'Conta B', 'b.csv', CSV_B);
    await tab(page, 'overview');
    await gotoMonth(page, 'Novembro 2026');
    await expect(page.getByTestId('ov-income')).toHaveText('R$ 2.000,00');
    await expect(page.getByTestId('ov-transfers')).toHaveText('R$ 500,00');
    // A = 1.000 + 2.000 − 500 − 300; B = 500 (pagamento de fatura sem cartão: aviso explícito).
    await expect(page.getByTestId('ov-consolidated')).toHaveText('R$ 2.700,00');
    await expect(page.getByTestId('ov-warning').first()).toBeVisible();
    await expect(page.getByTestId('finance-overview')).toContainText('sem o cartão importado');
  });

  test('D: cartão — compra, pagamento de fatura e estorno sem contagem dupla', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    await addAccount(page, { institution: 'Banco Fictício B', name: 'Cartão B', type: 'Cartão de crédito' });
    await importFile(page, 'Conta A', 'a.csv', CSV_PAY);
    await importFile(page, 'Cartão B', 'fatura.ofx', OFX_CARD, { expectNew: 3 });
    await tab(page, 'overview');
    await gotoMonth(page, 'Novembro 2026');
    await expect(page.getByTestId('ov-expense')).toHaveText('R$ 250,00');
    await expect(page.getByTestId('ov-cardpay')).toHaveText('R$ 300,00');
    await expect(page.getByTestId('ov-income')).toHaveText('R$ 2.000,00');
    await tab(page, 'cards');
    await expect(page.getByTestId('card-purchases')).toHaveText('R$ 300,00');
    await expect(page.getByTestId('card-refunds')).toHaveText('R$ 50,00');
    await expect(page.getByTestId('card-payments')).toHaveText('R$ 300,00');
  });

  test('E: canvas — consulta bancária alimenta o Mês e recalcula ao reclassificar; quadro sem extratos', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    await importFile(page, 'Conta A', 'gastos.csv', CSV_SPEND);
    await page.getByRole('button', { name: 'Fechar Minhas contas' }).click();
    await page.evaluate(() => (window as any).__aurora.actions.createBoard('Finanças bancárias E2E'));
    await expect.poll(async () => (await state(page)).elements.length).toBe(0);
    await page.evaluate(() => {
      const { actions, elements: E } = (window as any).__aurora;
      const b = actions.addWidget('aurora.bank-query', { x: -300, y: 0 }, { metric: 'result', period: '2026-11', periodMode: 'month' }, { title: 'Resultado do banco' });
      const m = actions.addWidget('aurora.finance-period', { x: 100, y: 0 }, { period: '2026-11' }, { title: 'Novembro 2026' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: b.id, fixedPoint: null };
      l.endBinding = { elementId: m.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'occurrences', targetPort: 'occurrences' };
      actions.addElements([l], false);
      actions.setSelection([]);
    });
    const tile = page.getByTestId('bank-tile');
    await expect(tile).toHaveAttribute('data-value', money('4.836,50'));
    await expect(page.getByTestId('period-tile')).toHaveAttribute('data-value', money('4.836,50'));
    // Reclassificar a corrida como transferência tira do consumo: bloco e mês recalculam.
    await openHub(page);
    await tab(page, 'transactions');
    const row = page.getByTestId('tx-row').filter({ hasText: 'UBER VIAGEM' });
    await row.getByLabel('Tipo de movimento').selectOption('transfer');
    await page.getByRole('button', { name: 'Fechar Minhas contas' }).click();
    await expect(tile).toHaveAttribute('data-value', money('4.879,00'));
    await expect(page.getByTestId('period-tile')).toHaveAttribute('data-value', money('4.879,00'));
    // O quadro guarda só a consulta.
    const els = JSON.stringify((await state(page)).elements);
    expect(els).not.toMatch(/UBER|IFOOD|SALARIO|HYPERLINK/);
  });

  test('F: IA recebe só o resumo agregado autorizado (nenhuma movimentação bruta)', async ({ page }) => {
    const bodies: { system: string }[] = [];
    await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [{ id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'mock' }] } }));
    await page.route('**/api/ai/chat', async (r) => { bodies.push(r.request().postDataJSON()); await r.fulfill({ json: { text: 'ok', provider: 'anthropic', model: 'mock' } }); });
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    await importFile(page, 'Conta A', 'gastos.csv', CSV_SPEND);
    await page.getByRole('button', { name: 'Fechar Minhas contas' }).click();
    await page.evaluate(() => (window as any).__aurora.actions.createBoard('IA bancária E2E'));
    await expect.poll(async () => (await state(page)).elements.length).toBe(0);
    const bankId = await page.evaluate(() => {
      const { actions, elements: E } = (window as any).__aurora;
      const ai = actions.addWidget('aurora.ai', { x: 200, y: -100 }, { provider: 'anthropic' }, { title: 'Assistente' });
      const b = actions.addWidget('aurora.bank-query', { x: -300, y: 0 }, { metric: 'expense', period: '2026-11', aiShare: { mode: 'aggregate' } }, { title: 'Despesas do banco' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'context');
      l.startBinding = { elementId: b.id, fixedPoint: null };
      l.endBinding = { elementId: ai.id, fixedPoint: null };
      actions.addElements([l], false);
      actions.setSelection([]);
      return b.id as string;
    });
    const ask = async (text: string) => { const box = page.getByPlaceholder('Pergunte algo sobre o contexto… (Enter envia)'); await box.fill(text); await box.press('Enter'); };
    await expect(page.getByTestId('ai-source-note')).toContainText('autorização para IA pendente');
    await ask('Como estão meus gastos?');
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].system).not.toMatch(/DADOS FINANCEIROS|UBER|IFOOD|SALARIO|163,50/);
    // Autoriza o resumo agregado no painel do bloco (prévia + confirmação).
    await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), bankId);
    await expect(page.getByTestId('bank-ai-preview')).toContainText('DADOS FINANCEIROS AUTORIZADOS');
    await page.getByRole('button', { name: 'Autorizar este conteúdo para IA' }).click();
    await page.getByRole('button', { name: 'Autorizar', exact: true }).click();
    await expect(page.getByTestId('bank-ai-status')).toContainText('Autorizado');
    await page.evaluate(() => (window as any).__aurora.actions.setSelection([]));
    await ask('E agora?');
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].system).toContain('DADOS FINANCEIROS AUTORIZADOS');
    expect(bodies[1].system).toMatch(money('163,50', 'consumo líquido: '));
    expect(bodies[1].system).not.toMatch(/UBER|IFOOD|SALARIO|HYPERLINK|Conta A|t_[0-9a-f]{4}/);
  });

  test('G: provedor fictício — conectar, sincronizar, expirar e revogar', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await tab(page, 'connectors');
    await page.getByTestId('enable-test-mode').click();
    await expect(page.getByTestId('mock-banner').first()).toHaveText('DADOS FICTÍCIOS — AMBIENTE DE TESTES');
    await page.getByTestId('mock-connect-alfa').click();
    const conn = page.getByTestId('mock-connection').first();
    await expect(conn.getByTestId('mock-state')).toHaveText('Aguardando consentimento');
    await conn.getByTestId('mock-approve').click();
    await expect(conn.getByTestId('mock-state')).toHaveText('Conectado');
    await conn.getByTestId('mock-sync').click();
    await expect(conn.getByTestId('mock-state')).toHaveText('Atualizado');
    const synced = (await finState(page)).txs;
    expect(synced).toBeGreaterThan(5);
    await conn.getByTestId('mock-expire').click();
    await expect(conn.getByTestId('mock-state')).toHaveText('Consentimento expirado');
    await conn.getByTestId('mock-revoke').click();
    await page.getByRole('button', { name: 'Revogar', exact: true }).click();
    await expect(conn.getByTestId('mock-state')).toHaveText('Consentimento revogado');
    // Revogar não apaga dados locais; a interface marca os dados como fictícios.
    expect((await finState(page)).txs).toBe(synced);
    await tab(page, 'overview');
    await expect(page.getByTestId('mock-banner').first()).toBeVisible();
  });

  test('H: arquivos manipulados, importação interrompida e exportação CSV segura', async ({ page }) => {
    await ready(page);
    await openHub(page);
    await addAccount(page, { institution: 'Banco Fictício A', name: 'Conta A' });
    const tryFile = async (name: string, content: string | Buffer) => {
      await page.getByTestId('open-import').click();
      await page.getByTestId('import-file').setInputFiles({ name, mimeType: 'text/plain', buffer: typeof content === 'string' ? Buffer.from(content) : content });
      await expect(page.getByTestId('import-error')).toBeVisible();
      const msg = await page.getByTestId('import-error').innerText();
      await page.getByTestId('import-cancel').click();
      return msg;
    };
    expect(await tryFile('xxe.ofx', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><OFX>&e;</OFX>')).toMatch(/DOCTYPE|ENTITY/);
    expect(await tryFile('quebrado.ofx', 'OFXHEADER:100\n<OFX><SIGNONMSGSRSV1></OFX>')).toMatch(/Nenhum extrato/);
    expect(await tryFile('enorme.csv', Buffer.alloc(21 * 1024 * 1024, 'a'))).toMatch(/grande demais/);
    expect(await tryFile('vazio.csv', ' \n')).toMatch(/vazio/i);
    // Interrompida na prévia: nada gravado.
    await importFile(page, 'Conta A', 'gastos.csv', CSV_SPEND, { confirm: false, expectNew: 4 });
    await page.getByTestId('import-cancel').click();
    expect((await finState(page)).txs).toBe(0);
    // Importa e exporta: a descrição com fórmula sai neutralizada.
    await importFile(page, 'Conta A', 'gastos.csv', CSV_SPEND);
    await tab(page, 'transactions');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
    const text = await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://exemplo.invalid"",""x"")"`);
    expect(text).not.toMatch(/;=HYPERLINK/);
  });
});
