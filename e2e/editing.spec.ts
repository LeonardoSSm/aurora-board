/** Edição: grupos aninhados, área de transferência, histórico por quadro. */
import { expect, test } from '@playwright/test';
import { drag, drawShape, ready, state, toPage } from './helpers';

test('grupos aninhados: clique seleciona o grupo externo, duplo clique entra um nível', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', -300, 0, -220, 60);
  await drawShape(page, 'r', -200, 0, -120, 60);
  await drawShape(page, 'r', -100, 0, -20, 60);
  const ids = (await state(page)).elements.map((e) => e.id);
  // grupo interno: A + B
  await drag(page, await toPage(page, -320, -20), await toPage(page, -110, 80));
  await page.keyboard.press('Control+g');
  // grupo externo: (A+B) + C
  await drag(page, await toPage(page, -320, -20), await toPage(page, -10, 80));
  await page.keyboard.press('Control+g');
  const bg = await toPage(page, 0, 300);
  await page.mouse.click(bg.x, bg.y);
  const a = await toPage(page, -300, 30);
  await page.mouse.click(a.x, a.y);
  expect((await state(page)).selectedIds.sort()).toEqual([...ids].sort());
  await page.mouse.dblclick(a.x, a.y);
  expect((await state(page)).selectedIds.sort()).toEqual([ids[0], ids[1]].sort());
  // desagrupar o nível selecionável fora da edição: só o externo é desfeito
  await page.keyboard.press('Escape');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press('Control+Shift+g');
  const s = await state(page);
  expect(s.elements[0].groupIds).toHaveLength(1);
  expect(s.elements[0].groupIds).toEqual(s.elements[1].groupIds);
  expect(s.elements[2].groupIds).toHaveLength(0);
});

test('copiar e colar pelo teclado (Ctrl+C / Ctrl+V / Ctrl+X)', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit não dispara eventos de copiar/colar a partir de atalhos sintéticos');
  await ready(page);
  await drawShape(page, 'o', 0, 0, 100, 60);
  await page.keyboard.press('Control+c');
  const target = await toPage(page, 250, 150);
  await page.mouse.move(target.x, target.y);
  await page.keyboard.press('Control+v');
  let s = await state(page);
  expect(s.elements).toHaveLength(2);
  expect(Math.round(s.elements[1].x + s.elements[1].width / 2)).toBeGreaterThan(200); // colado perto do cursor
  await page.keyboard.press('Control+x');
  s = await state(page);
  expect(s.elements).toHaveLength(1);
  await page.keyboard.press('Control+v');
  expect((await state(page)).elements).toHaveLength(2);
});

test('histórico de desfazer é separado por quadro', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 80, 80);
  const first = (await state(page)).boardId;
  await page.getByRole('button', { name: 'Novo quadro' }).click();
  await page.getByPlaceholder('Nome do quadro').fill('Outro');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByTestId('board-name')).toHaveText('Outro');
  await page.keyboard.press('Control+z'); // nada a desfazer aqui
  await page.getByRole('button', { name: 'Abrir lista de quadros' }).click();
  await page.getByTestId('boards-list').getByText('Meu primeiro quadro').click();
  await page.waitForFunction((id) => (window as any).__aurora.getState().boardId === id, first);
  expect((await state(page)).elements).toHaveLength(1); // intacto
  await page.keyboard.press('Control+z');
  expect((await state(page)).elements).toHaveLength(0); // o histórico deste quadro continua disponível
});
