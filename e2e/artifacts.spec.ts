import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { ready, state, waitSaved } from './helpers';
import { backup, confirmImport, importBackup } from './security-helpers';

const mockProvider = { id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'mock' };
const response = (...actions: object[]) => ({ text: JSON.stringify({ version: 3, actions }), provider: 'anthropic', model: 'mock' });
const artifact = async (page: Page) => (await state(page)).elements.find((e) => e.widgetType === 'aurora.sandbox-html');
const frame = (page: Page) => page.getByTestId('artifact-widget').frameLocator('iframe');

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function board(page: Page) {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Artifacts P1'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  return page.evaluate(() => {
    const { actions } = (window as any).__aurora;
    const ai = actions.addWidget('aurora.ai', { x: -230, y: -20 }, { provider: 'anthropic', instruction: 'INSTRUCAO_PRIVADA', messages: [{ id: 'old', role: 'user', content: 'HISTORICO_PRIVADO', at: 1 }] });
    const v = actions.addWidget('aurora.value', { x: -230, y: 270 }, { valueType: 'number', numericValue: '21', note: 'DADO_PRIVADO' }, { title: 'Base fictícia' });
    actions.setSelection([]);
    return { ai: ai.id as string, value: v.id as string };
  });
}

async function ask(page: Page, text: string, target?: string) {
  await page.getByRole('button', { name: 'Criar ou editar Artifact' }).click();
  await page.getByRole('textbox', { name: 'Pedido para o Artifact' }).fill(text);
  if (target) await page.getByTestId('artifact-composer').getByRole('combobox').selectOption(target);
}

const CODE = `<main style="padding:18px"><h2>Projeção de exemplo</h2><p>Dados fictícios</p><output id="result"></output></main>
<script>aurora.onInputs(i => { const n = (i.base ?? 0) * 2; document.querySelector('#result').textContent = n; aurora.publish('total',n); });</script>`;

test('IA cria e refina no canvas com autorização, dados reativos, undo, histórico e reabertura', async ({ page }, info) => {
  const requests: { system: string; messages: { content: string }[] }[] = [];
  let source = '';
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [mockProvider] } }));
  await page.route('**/api/ai/chat', (r) => {
    requests.push(r.request().postDataJSON());
    return r.fulfill({ json: requests.length === 1
      ? response({ type: 'create_html_widget', title: 'Projeção de exemplo', html: CODE },
        { type: 'configure_html_ports', target: '@artifact', inputs: [{ id: 'base', label: 'Base', type: 'number' }], outputs: [{ id: 'total', label: 'Total', type: 'number' }] },
        { type: 'connect_data', from: source, sourcePort: 'value', to: '@artifact', targetPort: 'base' })
      : response({ type: 'update_html_widget', target: '@artifact', html: CODE.replace('* 2', '* 3') }) });
  });
  const ids = await board(page);
  source = ids.value;
  await ask(page, 'Crie uma projeção com a Base fictícia.');
  await page.getByText('Blocos para conectar', { exact: false }).click();
  await page.getByRole('checkbox', { name: /Base fictícia/ }).check();
  await page.getByTestId('artifact-generate').click();
  const card = page.getByTestId('artifact-proposal').first();
  await card.getByRole('button', { name: 'Revisar código e conexões' }).click();
  await expect(card.getByTestId('artifact-proposed-code')).toContainText('aurora.onInputs');
  await expect(card).toContainText('Base fictícia · value');
  expect(await artifact(page)).toBeUndefined();
  expect(requests[0].system).toContain('Base fictícia');
  expect(requests[0].system).not.toMatch(/HISTORICO_PRIVADO|INSTRUCAO_PRIVADA|DADO_PRIVADO|numericValue/);
  expect(requests[0].messages).toEqual([{ role: 'user', content: 'Crie uma projeção com a Base fictícia.' }]);
  const dialog = page.getByRole('dialog');
  await card.getByRole('button', { name: 'Aplicar e executar…' }).click();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  expect(await artifact(page)).toBeUndefined();
  await card.getByRole('button', { name: 'Aplicar e executar…' }).click();
  await dialog.getByRole('button', { name: 'Aplicar e executar', exact: true }).click();
  await expect(frame(page).locator('#result')).toHaveText('42');
  const original = (await artifact(page))!;
  const edges = (await state(page)).elements.filter((e) => e.endBinding?.elementId === original.id);
  expect(edges).toHaveLength(1);
  await page.evaluate((id) => (window as any).__aurora.actions.updateWidgetData(id, (d: any) => ({ ...d, numericValue: '25' })), ids.value);
  await expect(frame(page).locator('#result')).toHaveText('50');
  await ask(page, 'Use um multiplicador de três.', original.id);
  await expect(page.getByTestId('artifact-send-source')).toHaveText(CODE);
  await expect(page.getByTestId('artifact-generate')).toBeDisabled();
  await page.getByRole('checkbox', { name: /Autorizo enviar este código/ }).check();
  await page.getByTestId('artifact-generate').click();
  const edit = page.getByTestId('artifact-proposal').last();
  await edit.getByRole('button', { name: 'Revisar código e conexões' }).click();
  expect(requests[1].system).toContain(JSON.stringify(CODE));
  expect(requests[1].system).not.toContain('DADO_PRIVADO');
  expect(requests[1].messages).toHaveLength(1);
  await capture(page, info, 'revisao-do-artifact');
  await edit.getByRole('button', { name: 'Aplicar e executar…' }).click();
  await dialog.getByRole('button', { name: 'Aplicar e executar', exact: true }).click();
  await expect(frame(page).locator('#result')).toHaveText('75');
  expect(await artifact(page)).toMatchObject({ id: original.id, x: original.x, y: original.y, width: original.width, height: original.height, data: { artifact: { number: 2 } } });
  expect((await state(page)).elements.filter((e) => e.endBinding?.elementId === original.id).map((e) => e.id)).toEqual(edges.map((e) => e.id));
  await page.evaluate(() => (window as any).__aurora.actions.undo());
  await expect(frame(page).locator('#result')).toHaveText('50');
  await page.evaluate(() => (window as any).__aurora.actions.redo());
  await expect(frame(page).locator('#result')).toHaveText('75');
  await waitSaved(page);
  await page.reload();
  await expect(frame(page).locator('#result')).toHaveText('75');
  await page.getByTestId('artifact-widget').getByText('Histórico', { exact: true }).click();
  await page.getByRole('button', { name: 'Restaurar v1…' }).click();
  await dialog.getByRole('button', { name: 'Restaurar pausado' }).click();
  await expect(page.getByTestId('artifact-widget')).toContainText('Artifact v3');
  await expect(frame(page).locator('#result')).toHaveCount(0);
  await activate(page);
  await expect(frame(page).locator('#result')).toHaveText('50');
  await capture(page, info, 'artifact-em-execucao');
});

async function activate(page: Page) {
  await page.getByTestId('sandbox-activate').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ativar este widget' }).click();
}

test('exemplos interativos reagem, publicam saídas tipadas e preservam o estado local', async ({ page }, info) => {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Exemplos P1'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  const add = async (id: string) => {
    await page.locator(`[data-library-item="aurora.sandbox-html#${id}"]`).click();
    await expect(page.getByTestId('sandbox-inactive')).toHaveCount(1);
    await expect(page.getByTestId('artifact-widget').locator('iframe')).toHaveCount(0);
    await activate(page);
    await expect(page.getByTestId('artifact-widget')).toContainText('Em execução');
  };
  const remove = async () => {
    const id = (await artifact(page))!.id;
    await page.evaluate((id) => { const a = (window as any).__aurora.actions; a.setSelection([id]); a.deleteSelected(); }, id);
    await expect(page.getByTestId('artifact-widget')).toHaveCount(0);
  };
  await add('artifact-projects');
  await expect(frame(page).getByText('Dados fictícios')).toBeVisible();
  await expect(frame(page).locator('#progresso')).toHaveText('50%');
  await frame(page).getByLabel('Prioridade').selectOption('high');
  await expect(frame(page).locator('#total')).toHaveText('2');
  await expect(frame(page).locator('#grafico rect')).toHaveCount(3);
  await capture(page, info, 'dashboard-de-projetos');
  await remove();
  await add('artifact-finance');
  await expect(frame(page).locator('#saldo')).toContainText('2.200,00');
  const htmlId = (await artifact(page))!.id;
  const incomeId = await page.evaluate((id) => {
    const { actions, elements: E } = (window as any).__aurora;
    const income = actions.addWidget('aurora.value', { x: -300, y: -160 }, { valueType: 'money', amountCents: 500000 });
    const expense = actions.addWidget('aurora.value', { x: -300, y: -20 }, { valueType: 'money', amountCents: 120000 });
    const links = [income, expense].map((value, i) => {
      const link = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      link.startBinding = { elementId: value.id, fixedPoint: null };
      link.endBinding = { elementId: id, fixedPoint: null };
      link.connection = { ...link.connection, sourcePort: 'value', targetPort: i ? 'despesas' : 'receitas' };
      return link;
    });
    actions.addElements(links, false);
    return income.id as string;
  }, htmlId);
  await expect(frame(page).locator('#saldo')).toContainText('3.800,00');
  await page.evaluate((id) => (window as any).__aurora.actions.updateWidgetData(id, (d: any) => ({ ...d, amountCents: 600000 })), incomeId);
  await expect(frame(page).locator('#saldo')).toContainText('4.800,00');
  await capture(page, info, 'dashboard-financeiro');
  await remove();
  await add('artifact-calculator');
  await expect(frame(page).locator('#resultado')).toHaveText('115,00');
  const calculator = (await artifact(page))!.id;
  await page.evaluate((id) => {
    const { actions, elements: E } = (window as any).__aurora;
    const formula = actions.addWidget('aurora.formula', { x: -280, y: 170 }, { expression: 'n * 2' }, { title: 'Dobro do resultado' });
    const link = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
    link.startBinding = { elementId: id, fixedPoint: null };
    link.endBinding = { elementId: formula.id, fixedPoint: null };
    link.connection = { ...link.connection, sourcePort: 'resultado', targetPort: 'in', variable: 'n' };
    actions.addElements([link], false);
  }, calculator);
  await frame(page).getByLabel('Valor base').fill('200');
  await frame(page).getByLabel('Valor base').press('Tab');
  await expect(frame(page).locator('#resultado')).toHaveText('230,00');
  await expect(page.getByTestId('formula-tile')).toContainText('460');
  await waitSaved(page);
  await page.reload();
  await expect(frame(page).locator('#resultado')).toHaveText('230,00');
  await capture(page, info, 'calculadora-de-cenarios');
});

test('quadro importado exige autorização e uma falha de runtime tem recuperação por revisão', async ({ page }) => {
  await ready(page);
  await importBackup(page, backup([{
    id: 'imported-artifact', type: 'widget', widgetType: 'aurora.sandbox-html', title: 'Artifact importado', x: 0, y: 0, width: 440, height: 300,
    data: { html: '<p>Com falha</p><script>throw new Error("detalhe sintético");</script>', state: null,
      activation: { state: 'allowed', source: 'artifact', at: 10 },
      artifact: { version: 1, number: 2, origin: 'manual', revisionId: '12345678', at: 10, history: [{ number: 1, html: '<p>Recuperado</p>', origin: 'manual', at: 9, inputs: [], outputs: [] }] } },
  }]));
  await confirmImport(page);
  await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
  await expect(page.getByTestId('artifact-widget').locator('iframe')).toHaveCount(0);
  await activate(page);
  await expect(page.getByRole('alert')).toContainText('O código registrou um erro');
  await expect(page.getByTestId('artifact-widget')).not.toContainText('detalhe sintético');
  await page.getByTestId('artifact-widget').getByText('Histórico', { exact: true }).click();
  await page.getByRole('button', { name: 'Restaurar v1…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restaurar pausado' }).click();
  await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
  await activate(page);
  await expect(frame(page).getByText('Recuperado', { exact: true })).toBeVisible();
  await page.getByTestId('artifact-widget').getByRole('button', { name: 'Código', exact: true }).click();
  await page.getByRole('textbox', { name: 'Código HTML' }).fill('<p>Revisão manual</p>');
  await page.getByRole('button', { name: 'Salvar revisão pausada' }).click();
  await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
  await activate(page);
  await expect(frame(page).getByText('Revisão manual', { exact: true })).toBeVisible();
  await waitSaved(page);
  await page.goto('/?safe');
  await expect(page.getByTestId('sandbox-safe-mode')).toBeVisible();
  await expect(page.getByTestId('artifact-widget').locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manter pausado' }).click();
  await waitSaved(page);
  await page.goto('/');
  await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
});

test('Artifact gerado separa a página de um CSV das agregações do arquivo e reage à paginação', async ({ page }) => {
  let datasetId = '';
  let sent = '';
  const html = '<p id="indicadores"></p><script>aurora.onInputs(i => {' +
    'document.querySelector("#indicadores").textContent = "Página: " + (i.pagina?.reduce((n,r) => n + r.valor, 0) ?? 0) + " | Arquivo: " + (i.resumo?.stats?.valor?.sum ?? 0);' +
    '});</script>';
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [mockProvider] } }));
  await page.route('**/api/ai/chat', (r) => {
    sent = r.request().postDataJSON().system;
    return r.fulfill({ json: response(
      { type: 'create_html_widget', title: 'KPIs do CSV', html },
      { type: 'configure_html_ports', target: '@artifact', inputs: [{ id: 'pagina', label: 'Página', type: 'object' }, { id: 'resumo', label: 'Conjunto', type: 'object' }], outputs: [] },
      { type: 'connect_data', from: datasetId, sourcePort: 'rows', to: '@artifact', targetPort: 'pagina' },
      { type: 'connect_data', from: datasetId, sourcePort: 'summary', to: '@artifact', targetPort: 'resumo' },
    ) });
  });
  await board(page);
  datasetId = await page.evaluate(() => (window as any).__aurora.actions.addWidget('aurora.dataset', { x: -180, y: -340 }).id);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dataset-import').click();
  await (await chooser).setFiles({ name: 'metricas.csv', mimeType: 'text/csv', buffer: Buffer.from('nome,valor\nCÉLULA-FICTÍCIA,10\nB,20\nC,50\n') });
  await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByTestId('dataset-counts')).toContainText('3 linha(s)');
  const setPage = (index: number) => page.evaluate(([id, n]) => (window as any).__aurora.actions.updateWidgetData(id, (d: any) => ({ ...d, view: { ...d.view, pageSize: 2, page: n } })), [datasetId, index]);
  await setPage(0);
  await ask(page, 'Mostre o total da página e o total do arquivo inteiro.');
  await page.getByText('Blocos para conectar', { exact: false }).click();
  await page.getByRole('checkbox', { name: /metricas/ }).check();
  await page.getByTestId('artifact-generate').click();
  await page.getByTestId('artifact-proposal').getByRole('button', { name: 'Revisar código e conexões' }).click();
  await page.getByRole('button', { name: 'Aplicar e executar…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aplicar e executar', exact: true }).click();
  expect(sent).toContain('summary.stats');
  expect(sent).not.toContain('CÉLULA-FICTÍCIA');
  await expect(frame(page).locator('#indicadores')).toHaveText('Página: 30 | Arquivo: 80');
  await setPage(1);
  await expect(frame(page).locator('#indicadores')).toHaveText('Página: 50 | Arquivo: 80');
});
