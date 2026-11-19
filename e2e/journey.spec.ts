/**
 * Jornada completa de usuário (validação final do ciclo 2):
 * quadro com todos os tipos → organizar → propriedades → conexões → recarregar → exportar →
 * importar como novo → comparar integridade elemento a elemento.
 */
import { expect, test } from '@playwright/test';
import { drag, drawShape, emptyCanvasPoint, ready, state, toPage, waitSaved, type El } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGRgYAAAhAQX/7xHnBQAAAABJRU5ErkJggg==', 'base64');

/** Conteúdo comparável (ignora ids, que mudam na importação, e metadados voláteis). */
function signature(els: El[]) {
  const idx = new Map(els.map((e, i) => [e.id, i]));
  return els.map((e) => {
    const { id: _id, groupIds, startBinding, endBinding, updatedAt: _u, version: _v, seed: _s, frameId, data, ...rest } = e as El & Record<string, unknown>;
    return {
      ...rest,
      groups: (groupIds as string[]).length,
      start: startBinding ? idx.get((startBinding as { elementId: string }).elementId) : null,
      end: endBinding ? idx.get((endBinding as { elementId: string }).elementId) : null,
      frame: frameId ? idx.get(frameId as string) : null,
      data: JSON.stringify(data ?? null).replace(/"id":"[^"]+"/g, '"id":"*"').replace(/"assetId":"[^"]+"/g, '"assetId":"*"'),
    };
  });
}

test('jornada completa: criar, organizar, conectar, recarregar, exportar e importar como novo', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByRole('button', { name: 'Novo quadro' }).click();
  await page.getByPlaceholder('Nome do quadro').fill('Jornada');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByTestId('board-name')).toHaveText('Jornada');

  // formas + texto interno
  await drawShape(page, 'r', -380, -260, -230, -170);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Planejar');
  await page.keyboard.press('Escape');
  await drawShape(page, 'o', -150, -260, 0, -170);
  await drawShape(page, 'd', 80, -270, 220, -160);
  // propriedades: preenchimento, fonte mono, XL
  await page.mouse.click((await toPage(page, -305, -170)).x, (await toPage(page, -305, -170)).y);
  await page.getByRole('radio', { name: '#24436a' }).click();
  await page.getByRole('radio', { name: 'Mono' }).click();
  await page.getByRole('radio', { name: 'XL', exact: true }).click();
  // seta ancorada entre retângulo e elipse; fluxograma a partir do losango
  await page.keyboard.press('a');
  await drag(page, await toPage(page, -300, -215), await toPage(page, -75, -215), { steps: 10 });
  await page.mouse.click((await toPage(page, 150, -160)).x, (await toPage(page, 150, -160)).y);
  await page.keyboard.press('Control+ArrowDown');
  // texto independente
  await page.keyboard.press('t');
  const tp = await toPage(page, -380, -100);
  await page.mouse.click(tp.x, tp.y);
  await page.keyboard.type('Notas soltas');
  await page.keyboard.press('Escape');
  // desenho livre
  await page.keyboard.press('p');
  await drag(page, await toPage(page, -380, -40), await toPage(page, -250, 10), { steps: 12 });
  await page.keyboard.press('Escape');
  // agrupar elipse + losango
  const s0 = await state(page);
  const ellipse = s0.elements.find((e) => e.type === 'ellipse')!;
  const diamond = s0.elements.find((e) => e.type === 'diamond')!;
  await page.evaluate(([a, b]) => { (window as any).__aurora.actions.setSelection([a, b]); (window as any).__aurora.actions.groupSelection(); }, [ellipse.id, diamond.id]);
  // widgets: notas, tarefas, finanças, calendário + imagem
  const lib = async (id: string) => { const bg = await emptyCanvasPoint(page); await page.mouse.click(bg.x, bg.y); await page.locator(`[data-library-item="${id}"]`).click(); };
  await lib('aurora.notes');
  await page.locator('[data-widget-body] textarea').last().fill('# Reunião\n- definir escopo');
  await lib('aurora.tasks');
  await page.getByPlaceholder('Nova tarefa e Enter').last().fill('Enviar proposta');
  await page.getByPlaceholder('Nova tarefa e Enter').last().press('Enter');
  await lib('aurora.finance');
  await page.getByTestId('finance-add').last().click();
  await page.getByTestId('finance-desc').fill('Salário');
  await page.getByRole('button', { name: 'Receita', exact: true }).click();
  await page.getByTestId('finance-amount').fill('5.000,00');
  await page.getByTestId('finance-save').click();
  await lib('aurora.calendar');
  await page.getByPlaceholder('Novo evento e Enter').last().fill('Entrega');
  await page.getByPlaceholder('Novo evento e Enter').last().press('Enter');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-library-item="tool:image"]').click();
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await state(page)).elements.some((e) => e.type === 'image')).toBe(true);

  // organizar: espalha os widgets (todos foram inseridos no centro)
  await page.evaluate(() => {
    const A = (window as any).__aurora;
    const ws = A.getState().elements.filter((e: any) => e.type === 'widget' || e.type === 'image');
    ws.forEach((w: any, i: number) => A.actions.updateElement(w.id, { x: -380 + i * 340, y: 120 }));
  });

  // checagens do conteúdo antes de salvar
  let s = await state(page);
  const types = s.elements.map((e) => (e.type === 'widget' ? e.widgetType : e.type));
  for (const t of ['rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'freedraw', 'image', 'aurora.notes', 'aurora.tasks', 'aurora.finance', 'aurora.calendar']) expect(types).toContain(t);
  const rect = s.elements.find((e) => e.type === 'rectangle' && e.text === 'Planejar')!;
  expect(rect.style).toMatchObject({ backgroundColor: '#24436a', fontFamily: 'mono', fontSize: 36 });
  const arrows = s.elements.filter((e) => e.type === 'arrow');
  expect(arrows.some((a) => a.startBinding?.elementId === rect.id && a.endBinding?.elementId === ellipse.id)).toBe(true);
  expect(s.elements.filter((e) => e.groupIds.length)).toHaveLength(2);
  await expect(page.getByTestId('finance-balance')).toHaveText(/5\.000,00/);
  const before = signature(s.elements);

  // salvar, recarregar, reabrir
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  s = await state(page);
  expect(s.boards.find((b) => b.id === s.boardId)?.name).toBe('Jornada');
  expect(signature(s.elements)).toEqual(before);
  await expect(page.locator('[data-testid="image-missing"]')).toHaveCount(0);

  // exportar este quadro e importar como novo
  await page.getByRole('button', { name: /Exportar/ }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Este quadro/ }).click();
  const file = await (await dl).path();
  const boardsBefore = s.boards.length;
  await page.getByRole('button', { name: /Importar/ }).click();
  const ch2 = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await ch2).setFiles(file!);
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect.poll(async () => (await state(page)).boards.length).toBe(boardsBefore + 1);
  const imported = await state(page);
  expect(imported.boards.filter((b) => b.name === 'Jornada')).toHaveLength(2); // original preservado + cópia
  expect(signature(imported.elements)).toEqual(before);
  await expect(page.locator('[data-testid="image-missing"]')).toHaveCount(0); // imagem veio junto
  await expect(page.getByTestId('finance-balance')).toHaveText(/5\.000,00/);
  // registro visual para inspeção manual (test-results/)
  await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
  await page.screenshot({ path: test.info().outputPath('jornada-final.png') });
});
