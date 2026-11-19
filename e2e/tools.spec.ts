/** Ferramentas manuais comparadas com o comportamento do Excalidraw. */
import { expect, test } from '@playwright/test';
import { drag, drawShape, emptyCanvasPoint, expectNear, ready, state, toPage } from './helpers';

test('frame: elementos dentro se movem junto; nome editável com duplo clique', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'f', -300, -200, 100, 150);
  await drawShape(page, 'r', -250, -120, -150, -60);
  let s = await state(page);
  const frame = s.elements.find((e) => e.type === 'frame')!;
  const rect = s.elements.find((e) => e.type === 'rectangle')!;
  expect((rect as unknown as { frameId: string }).frameId).toBe(frame.id);
  // arrastar pela borda do frame
  await drag(page, await toPage(page, 100, 0), await toPage(page, 150, 50));
  s = await state(page);
  expectNear(s.elements.find((e) => e.id === rect.id)!, { x: -200, y: -70 });
  // título (acima do canto superior esquerdo, na posição atual do frame)
  const f2 = (await state(page)).elements.find((e) => e.id === frame.id)!;
  const title = await toPage(page, f2.x + 20, f2.y - 12);
  await page.mouse.dblclick(title.x, title.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Sprint 1');
  await page.keyboard.press('Escape');
  expect((await state(page)).elements.find((e) => e.id === frame.id)!.text).toBe('Sprint 1');
});

test('borracha apaga só o que tocou e Ctrl+Z restaura', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', -200, 0, -100, 80);
  await drawShape(page, 'o', 50, 0, 150, 80);
  await page.keyboard.press('e');
  await drag(page, await toPage(page, -220, 40), await toPage(page, -80, 40));
  let s = await state(page);
  expect(s.elements.map((e) => e.type)).toEqual(['ellipse']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  s = await state(page);
  expect(s.elements.map((e) => e.type).sort()).toEqual(['ellipse', 'rectangle']);
});

test('bloqueio: não move, não apaga, não edita; desbloquear volta ao normal', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 100, 80);
  await page.getByRole('radio', { name: '#24436a' }).click(); // preenchido: arrastar pelo interior, longe das alças
  await page.keyboard.press('Control+Shift+l');
  await drag(page, await toPage(page, 50, 40), await toPage(page, 250, 40));
  let s = await state(page);
  expectNear(s.elements[0], { x: 0 });
  await page.keyboard.press('Delete');
  expect((await state(page)).elements).toHaveLength(1);
  await page.keyboard.press('Control+Shift+l');
  await drag(page, await toPage(page, 50, 40), await toPage(page, 250, 40));
  s = await state(page);
  expectNear(s.elements[0], { x: 200 });
});

test('texto independente: alça lateral quebra linha, canto escala a fonte', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('t');
  const p = await toPage(page, -200, 0);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('um texto razoavelmente comprido para quebrar');
  await page.keyboard.press('Escape');
  let el = (await state(page)).elements[0];
  const h0 = el.height, fs0 = el.style.fontSize;
  // alça direita (e): estreita → quebra em mais linhas, fonte igual
  await drag(page, await toPage(page, el.x + el.width + 5, el.y + el.height / 2), await toPage(page, el.x + el.width / 3, el.y + el.height / 2));
  el = (await state(page)).elements[0];
  expect(el.height).toBeGreaterThan(h0 * 1.8);
  expect(el.style.fontSize).toBe(fs0);
  // canto (se): aumenta → fonte maior
  await drag(page, await toPage(page, el.x + el.width + 5, el.y + el.height + 5), await toPage(page, el.x + el.width * 2, el.y + el.height * 2));
  el = (await state(page)).elements[0];
  expect(el.style.fontSize).toBeGreaterThan(fs0 * 1.4);
});

test('rotação: forma gira, texto acompanha e continua editável', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', -100, -50, 100, 50);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Girado');
  await page.keyboard.press('Escape');
  // alça de rotação: acima do centro do topo
  const top = await toPage(page, 0, -50);
  await drag(page, { x: top.x, y: top.y - 31 }, await toPage(page, 200, 0));
  let el = (await state(page)).elements[0] as unknown as { angle: number; text: string };
  expect(Math.abs(el.angle)).toBeGreaterThan(1); // ~90°
  const bg = await emptyCanvasPoint(page);
  await page.mouse.click(bg.x, bg.y);
  const c = await toPage(page, 0, 0);
  await page.mouse.dblclick(c.x, c.y);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  el = (await state(page)).elements[0] as unknown as { angle: number; text: string };
  expect(el.text).toBe('Girado!');
});
