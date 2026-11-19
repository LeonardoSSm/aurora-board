/**
 * Assistente IA × widgets financeiros (contrato v2). O provedor é simulado: nenhuma chave real, nenhuma rede externa.
 * Verifica prévia, confirmação obrigatória, valores exatos em centavos, destinos, desfazer/refazer e compatibilidade.
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state, type El } from './helpers';

const PEDIDO = 'Crie um bloco de receita de R$ 2.000,00';
const BRL_2000 = /R\$\s2\.000,00/;
const fence = (json: unknown, prefix = 'Certo, segue a proposta.') => `${prefix}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;

interface ChatBody { provider: string; system: string; messages: { role: string; content: string }[] }

/** Provedor simulado: só Anthropic configurado; cada mensagem recebe a próxima resposta da fila. */
async function mockAI(page: Page, replies: string[]) {
  const bodies: ChatBody[] = [];
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [{ id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'mock' }] } }));
  await page.route('**/api/ai/chat', async (r) => {
    bodies.push(r.request().postDataJSON() as ChatBody);
    await r.fulfill({ json: { text: replies[bodies.length - 1] ?? 'ok', provider: 'anthropic', model: 'mock' } });
  });
  return bodies;
}

/** Quadro novo com um bloco de IA; `finances` cria blocos de Finanças ligados ao assistente por conexão de contexto. */
async function board(page: Page, finances: string[] = []) {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('IA financeira'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  return page.evaluate((titles) => {
    const { actions, elements: E } = (window as any).__aurora;
    const ai = actions.addWidget('aurora.ai', { x: -200, y: 0 }, { provider: 'anthropic' }, { title: 'Assistente' });
    const ids: string[] = [];
    titles.forEach((title: string, i: number) => {
      const f = actions.addWidget('aurora.finance', { x: 380, y: -220 + i * 460 }, { entries: [] }, { title });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'context');
      l.startBinding = { elementId: f.id, fixedPoint: null };
      l.endBinding = { elementId: ai.id, fixedPoint: null };
      actions.addElements([l], false);
      ids.push(f.id);
    });
    actions.setSelection([]);
    return { aiId: ai.id as string, financeIds: ids };
  }, finances);
}

async function ask(page: Page, text: string) {
  const box = page.getByPlaceholder('Pergunte algo sobre o contexto… (Enter envia)');
  await box.fill(text);
  await box.press('Enter');
}

const widgets = async (page: Page, type: string) => (await state(page)).elements.filter((e) => e.type === 'widget' && e.widgetType === type);
const finance = async (page: Page, id: string) => (await state(page)).elements.find((e) => e.id === id) as El;
const act = (page: Page, name: 'undo' | 'redo') => page.evaluate((n) => (window as any).__aurora.actions[n](), name);

test(`pedido exato "${PEDIDO}" cria aurora.value de receita com 200000 centavos, só após confirmação`, async ({ page }) => {
  const bodies = await mockAI(page, [fence({ version: 2, actions: [{ type: 'create_value', role: 'income', currency: 'BRL', amount: '2000.00' }] })]);
  await board(page);
  await ask(page, PEDIDO);

  // O modelo recebe o pedido e o contrato v2.
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0].messages.at(-1)).toEqual({ role: 'user', content: PEDIDO });
  expect(bodies[0].system).toContain('create_value');
  expect(bodies[0].system).toContain('"amount":"2000.00"');

  // Prévia: tipo, valor, moeda, centavos, destino e efeito — e nada criado ainda.
  const card = page.getByTestId('ai-proposal');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-origin', 'ai');
  const action = card.getByTestId('ai-action');
  await expect(action).toHaveAttribute('data-action-type', 'money');
  await expect(action.getByTestId('ai-money')).toContainText('Receita');
  await expect(action.getByTestId('ai-money')).toContainText(BRL_2000);
  await expect(action.getByTestId('ai-money')).toContainText('BRL · 200000 centavos');
  await expect(action.getByTestId('ai-destination')).toHaveValue('value');
  await expect(action.getByTestId('ai-effect')).toContainText('Cria bloco de valor “Receita” (aurora.value)');
  await expect(action.getByTestId('ai-defaults')).toContainText('Competência: do mês conectado');
  await expect(action.getByTestId('ai-warning')).toHaveCount(0);
  expect(await widgets(page, 'aurora.value')).toHaveLength(0);
  expect(await widgets(page, 'aurora.notes')).toHaveLength(0);

  // Cancelar não altera nada.
  await card.getByTestId('ai-proposal-apply').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Confirmar alterações financeiras');
  await expect(dlg).toContainText(BRL_2000);
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dlg).toHaveCount(0);
  expect(await widgets(page, 'aurora.value')).toHaveLength(0);

  // Confirmar cria exatamente um bloco de valor.
  await card.getByTestId('ai-proposal-apply').click();
  await dlg.getByRole('button', { name: 'Aplicar no quadro' }).click();
  await expect.poll(async () => (await widgets(page, 'aurora.value')).length).toBe(1);
  const [tile] = await widgets(page, 'aurora.value');
  expect(tile.title).toBe('Receita');
  expect(tile.data).toMatchObject({ valueType: 'money', financialRole: 'income', currency: 'BRL', amountCents: 200000, period: '', category: '' });
  expect(await widgets(page, 'aurora.notes')).toHaveLength(0);
  await expect(page.locator('[data-testid="value-tile"]')).toContainText(BRL_2000);

  // Não aplica duas vezes.
  await expect(card).toHaveAttribute('data-applied', 'true');
  await expect(card.getByTestId('ai-proposal-apply')).toBeDisabled();

  // Desfazer remove o bloco e reabre a proposta; refazer devolve os dois.
  await act(page, 'undo');
  await expect.poll(async () => (await widgets(page, 'aurora.value')).length).toBe(0);
  await expect(card.getByTestId('ai-proposal-apply')).toBeEnabled();
  await act(page, 'redo');
  await expect.poll(async () => (await widgets(page, 'aurora.value')).length).toBe(1);
  await expect(card.getByTestId('ai-proposal-apply')).toBeDisabled();
});

test('[reprodução] IA responde com Nota "Receita": a interpretação local oferece o bloco de valor correto', async ({ page }) => {
  await mockAI(page, [fence({ notes: [{ title: 'Receita', content: 'R$ 2.000,00' }], tasks: [], connections: [] })]);
  await board(page);
  await ask(page, PEDIDO);

  const cards = page.getByTestId('ai-proposal');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('data-origin', 'ai');
  await expect(cards.nth(0).getByTestId('ai-action')).toHaveAttribute('data-action-type', 'note');
  const local = page.locator('[data-testid="ai-proposal"][data-origin="local"]');
  await expect(local).toContainText('Interpretação local do seu pedido');
  await expect(local.getByTestId('ai-money')).toContainText('200000 centavos');

  await local.getByTestId('ai-proposal-apply').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aplicar no quadro' }).click();
  await expect.poll(async () => (await widgets(page, 'aurora.value')).length).toBe(1);
  expect((await widgets(page, 'aurora.value'))[0].data).toMatchObject({ financialRole: 'income', currency: 'BRL', amountCents: 200000 });
  expect(await widgets(page, 'aurora.notes')).toHaveLength(0);
});

test('pedido ambíguo: o usuário escolhe entre bloco independente e lançamento no widget de Finanças', async ({ page }) => {
  await mockAI(page, [fence({ version: 2, actions: [{ type: 'create_value', role: 'income', currency: 'BRL', amount: '2000.00', ambiguous: true }] })]);
  const { financeIds } = await board(page, ['Casa', 'Empresa']);
  await ask(page, 'Registre uma receita de R$ 2.000,00');

  const card = page.getByTestId('ai-proposal');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('ai-needs-choice')).toContainText('ambíguo');
  await expect(card.getByTestId('ai-proposal-apply')).toBeDisabled();

  const dest = card.getByTestId('ai-destination');
  await expect(dest.locator('option')).toHaveText([/Escolha/, /Novo bloco de valor/, /Lançamento em “Casa”/, /Lançamento em “Empresa”/, /Novo bloco de Finanças/]);
  await dest.selectOption(`entry:${financeIds[1]}`);
  await expect(card.getByTestId('ai-effect')).toContainText(/em “Empresa” — saldo previsto R\$\s0,00 → R\$\s2\.000,00/);
  await expect(card.getByTestId('ai-defaults')).toContainText('Data: sem vencimento');
  await expect(card.getByTestId('ai-defaults')).toContainText('Categoria: Sem categoria');
  await card.screenshot({ path: test.info().outputPath('ai-proposal-preview.png') });

  await card.getByTestId('ai-proposal-apply').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aplicar no quadro' }).click();
  await expect.poll(async () => (await finance(page, financeIds[1])).data.entries.length).toBe(1);
  expect((await finance(page, financeIds[1])).data.entries[0]).toMatchObject({ kind: 'income', amountCents: 200000, date: '', category: '', paid: false, installments: 1 });
  expect((await finance(page, financeIds[0])).data.entries).toHaveLength(0);
  expect(await widgets(page, 'aurora.value')).toHaveLength(0);
  await expect(page.getByTestId('finance-balance').nth(1)).toHaveText(BRL_2000);
  await expect(card.getByTestId('ai-proposal-apply')).toBeDisabled();

  await act(page, 'undo');
  await expect.poll(async () => (await finance(page, financeIds[1])).data.entries.length).toBe(0);
});

test('lançamento direto em Finanças com destino indicado pela IA', async ({ page }) => {
  const replies: string[] = [];
  const bodies = await mockAI(page, replies);
  const { financeIds } = await board(page, ['Casa']);
  replies.push(fence({ version: 2, actions: [{ type: 'add_finance_entry', target: financeIds[0], kind: 'expense', currency: 'BRL', amount: '150.00', description: 'Internet' }] }));
  await ask(page, 'Lance uma despesa de R$ 150,00 de internet nas finanças');
  await expect.poll(() => bodies.length).toBe(1);
  // O id do bloco de Finanças só é conhecido pelo modelo porque está no contexto autorizado.
  expect(bodies[0].system).toContain(`id: ${financeIds[0]}`);

  const card = page.getByTestId('ai-proposal');
  await expect(card.getByTestId('ai-destination')).toHaveValue(`entry:${financeIds[0]}`);
  await expect(card.getByTestId('ai-money')).toContainText('Despesa');
  await card.getByTestId('ai-proposal-apply').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aplicar no quadro' }).click();
  await expect.poll(async () => (await finance(page, financeIds[0])).data.entries.length).toBe(1);
  expect((await finance(page, financeIds[0])).data.entries[0]).toMatchObject({ kind: 'expense', amountCents: 15000, description: 'Internet', date: '', category: '' });
});

test('propostas inválidas de modelo externo são recusadas e nada pode ser aplicado', async ({ page }) => {
  await mockAI(page, [fence({
    version: 2,
    actions: [
      { type: 'create_value', role: 'income', amount: '2.000,00' },
      { type: 'create_value', role: 'income', amount: 2000.005 },
      { type: 'delete_board' },
      { type: 'add_finance_entry', target: 'id-inventado', kind: 'income' },
    ],
  })]);
  await board(page);
  await ask(page, 'Crie um bloco de receita');
  const card = page.getByTestId('ai-proposal');
  await expect(card.getByTestId('ai-rejected').locator('div')).toHaveCount(4);
  await expect(card.getByTestId('ai-rejected')).toContainText('tipo de ação desconhecido');
  await expect(card.getByTestId('ai-proposal-apply')).toBeDisabled();
  expect(await widgets(page, 'aurora.value')).toHaveLength(0);
});

test('compatibilidade: proposta antiga de notas e tarefas continua aplicável numa única operação', async ({ page }) => {
  await mockAI(page, [fence({ notes: [{ title: 'Resumo', content: '# Plano' }], tasks: [{ text: 'Revisar orçamento', priority: 'high' }], connections: [] })]);
  await board(page);
  await ask(page, 'Gere blocos');
  const card = page.getByTestId('ai-proposal');
  await expect(card.getByTestId('ai-action')).toHaveCount(2);
  const undoBefore = await page.evaluate(() => { const s = (window as any).__aurora.getState(); return s.history[s.boardId]?.undo.length ?? 0; });
  await card.getByTestId('ai-proposal-apply').click();
  await expect(page.getByRole('dialog')).toContainText('Criar elementos sugeridos pela IA');
  await page.getByRole('dialog').getByRole('button', { name: 'Aplicar no quadro' }).click();
  await expect.poll(async () => (await widgets(page, 'aurora.notes')).length).toBe(1);
  expect((await widgets(page, 'aurora.tasks'))[0].data.items[0]).toMatchObject({ text: 'Revisar orçamento', priority: 'high' });
  const undoAfter = await page.evaluate(() => { const s = (window as any).__aurora.getState(); return s.history[s.boardId].undo.length; });
  expect(undoAfter).toBe(undoBefore + 1);
});
