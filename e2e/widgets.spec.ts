/** Widgets interativos não podem ser prejudicados pelo motor do canvas (e vice-versa). */
import { expect, test } from '@playwright/test';
import { drag, drawShape, ready, state, toPage } from './helpers';

test('campo do bloco financeiro: clicar e arrastar no campo não move o bloco', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.finance"]').click();
  await page.getByTestId('finance-add').click();
  const desc = page.getByTestId('finance-desc');
  const box = (await desc.boundingBox())!;
  const x0 = (await state(page)).elements[0].x;
  await drag(page, { x: box.x + 10, y: box.y + box.height / 2 }, { x: box.x + 150, y: box.y + 80 });
  expect((await state(page)).elements[0].x).toBe(x0);
  await desc.fill('Conta de luz');
  await page.getByTestId('finance-amount').fill('123,45');
  await page.getByTestId('finance-save').click();
  await expect(page.getByTestId('finance-expense')).toHaveText(/123,45/);
});

test('editar tarefa não ativa atalhos de desenho; calendário não cria elementos', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.tasks"]').click();
  const input = page.getByPlaceholder('Nova tarefa e Enter');
  await input.fill('');
  await input.type('revisar ordem das telas'); // contém r, o, d, a, t, e, l, s…
  await input.press('Enter');
  let s = await state(page);
  expect(s.tool).toBe('select');
  expect(s.elements).toHaveLength(1);
  await page.locator('[data-library-item="aurora.calendar"]').click();
  await page.getByRole('button', { name: 'Próximo mês' }).click();
  await page.getByRole('button', { name: '15', exact: true }).click();
  s = await state(page);
  expect(s.elements).toHaveLength(2); // nenhum elemento novo além dos dois widgets
  expect(s.elements.every((e) => e.type === 'widget')).toBe(true);
});

test('redimensionar widget preserva o conteúdo', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.tasks"]').click();
  const input = page.getByPlaceholder('Nova tarefa e Enter');
  await input.fill('Primeira');
  await input.press('Enter');
  const el = (await state(page)).elements[0];
  await page.getByTestId('widget-title').click();
  // alça SE do widget selecionado
  await drag(page, await toPage(page, el.x + el.width + 5, el.y + el.height + 5), await toPage(page, el.x + el.width + 205, el.y + el.height + 105));
  const after = (await state(page)).elements[0];
  expect(after.width).toBeGreaterThan(el.width + 150);
  expect(after.data.items.map((i: { text: string }) => i.text)).toEqual(['Primeira']);
  await expect(page.getByTestId('tasks-progress')).toHaveText('0/1 concluídas');
});

test('trocar de ferramenta e Esc durante o arrasto', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 100, 80);
  const start = await toPage(page, 0, 40), mid = await toPage(page, 150, 40);
  // Esc no meio do arrasto cancela e devolve a forma à posição original
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(Math.round((await state(page)).elements[0].x)).toBe(0);
  // trocar de ferramenta no meio do arrasto: o movimento termina normalmente
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y, { steps: 5 });
  await page.keyboard.press('o');
  await page.mouse.up();
  const s = await state(page);
  expect(Math.round(s.elements[0].x)).toBeGreaterThan(100);
  expect(s.tool).toBe('ellipse');
  expect(s.elements).toHaveLength(1);
});
