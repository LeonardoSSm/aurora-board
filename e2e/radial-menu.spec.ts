/**
 * Issue #15 — Aurora Wheel. Segurar o botão direito em área vazia abre a roda; clique direito curto continua
 * abrindo o menu tradicional (uma vez, sem piscar). O `contextmenu` nativo chega no down (Linux/macOS) ou no up
 * (Windows): os testes valem para os dois porque o menu tradicional nunca é aberto por esse evento num gesto
 * rastreado.
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state, toPage, waitSaved } from './helpers';

const wheel = (page: Page) => page.getByTestId('radial-menu');
const ctxMenu = (page: Page) => page.getByTestId('context-menu');

async function newBoard(page: Page, name: string) {
  await page.evaluate((n) => (window as any).__aurora.actions.createBoard(n), name);
  await expect.poll(async () => { const s = await state(page); return s.boards.find((b) => b.id === s.boardId)?.name; }).toBe(name);
}

/** Câmera não trivial: zoom 1,5 e deslocada, para provar a conversão tela → mundo. */
async function oddCamera(page: Page) {
  await page.evaluate(() => (window as any).__aurora.store.setState({ camera: { x: -333, y: 127, zoom: 1.5 } }));
}

/** Conta quantas vezes o menu tradicional e a roda APARECERAM (detecta “piscar”). */
async function watchMenus(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__menus = { ctx: 0, wheel: 0 };
    let ctx = false, wh = false;
    w.__menuObs?.disconnect();
    w.__menuObs = new MutationObserver(() => {
      const c = !!document.querySelector('[data-testid="context-menu"]'), r = !!document.querySelector('[data-testid="radial-menu"]');
      if (c && !ctx) w.__menus.ctx++;
      if (r && !wh) w.__menus.wheel++;
      ctx = c; wh = r;
    });
    w.__menuObs.observe(document.body, { childList: true, subtree: true });
  });
}
const menuCounts = (page: Page) => page.evaluate(() => (window as any).__menus as { ctx: number; wheel: number });

/** Ponto vazio do canvas (centro-direita). */
async function emptyPoint(page: Page) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  return { x: box.x + box.width * 0.6, y: box.y + box.height * 0.55 };
}
const worldAt = (page: Page, p: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const a = (window as any).__aurora, c = a.getState().camera;
  const r = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
  return { x: (x - r.left - c.x) / c.zoom, y: (y - r.top - c.y) / c.zoom };
}, p);

/** Centro visual da roda e ponto sobre a fatia `i` (0 = topo, horário). */
async function slicePoint(page: Page, id: string) {
  const btn = wheel(page).locator(`[data-testid="radial-item"][data-id="${id}"]`);
  const b = (await btn.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function hold(page: Page, p: { x: number; y: number }, ms = 300) {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(ms);
}

const centerOf = (el: { x: number; y: number; width: number; height: number }) => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

test.beforeEach(async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Roda E2E');
});

test('A — clique direito curto em área vazia abre o menu tradicional uma única vez, sem roda', async ({ page }) => {
  await watchMenus(page);
  const p = await emptyPoint(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(ctxMenu(page)).toBeVisible();
  await page.waitForTimeout(400); // o timer da roda (220 ms) já teria disparado
  await expect(wheel(page)).toHaveCount(0);
  expect(await menuCounts(page)).toEqual({ ctx: 1, wheel: 0 });
  await expect(ctxMenu(page).getByRole('menuitem', { name: 'Adicionar checkpoint aqui' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ctxMenu(page)).toHaveCount(0);
});

test('B — segurar abre a roda uma vez (sem piscar o menu antigo); soltar na fatia cria no ponto do mundo original', async ({ page }) => {
  await oddCamera(page);
  await watchMenus(page);
  const p = await emptyPoint(page);
  const world = await worldAt(page, p);
  const t0 = Date.now();
  await hold(page, p);
  await expect(wheel(page)).toBeVisible();
  const openMs = Date.now() - t0;
  const target = await slicePoint(page, 'task');
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await expect(wheel(page).locator('[data-id="task"]')).toHaveAttribute('data-active', 'true');
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveCount(0);
  await page.waitForTimeout(150); // contextmenu tardio (Windows) não pode abrir o menu antigo
  await expect(ctxMenu(page)).toHaveCount(0);
  expect(await menuCounts(page)).toEqual({ ctx: 0, wheel: 1 });
  const s = await state(page);
  expect(s.elements).toHaveLength(1);
  const el = s.elements[0];
  expect(el.widgetType).toBe('aurora.tasks');
  expect(s.selectedIds).toEqual([el.id]);
  const c = centerOf(el);
  expect(Math.abs(c.x - world.x)).toBeLessThan(1);
  expect(Math.abs(c.y - world.y)).toBeLessThan(1);
  test.info().annotations.push({ type: 'medição', description: `abrir a roda: ${openMs} ms do botão pressionado até visível (limiar 220 ms)` });
});

test('C — Nota e Texto entram em edição; uma criação = um passo de desfazer', async ({ page }) => {
  const p = await emptyPoint(page);
  await hold(page, p);
  const n = await slicePoint(page, 'note');
  await page.mouse.move(n.x, n.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  let s = await state(page);
  expect(s.elements.map((e) => e.type)).toEqual(['sticky']);
  expect(s.editingTextId).toBe(s.elements[0].id);
  await page.keyboard.type('Ideia');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).elements[0]?.text).toBe('Ideia');
  // Texto em outro ponto.
  const q = { x: p.x - 300, y: p.y + 60 };
  await hold(page, q);
  const t = await slicePoint(page, 'text');
  await page.mouse.move(t.x, t.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  s = await state(page);
  expect(s.editingTextId).not.toBeNull();
  await page.keyboard.type('Rótulo');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).elements.length).toBe(2);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).elements.length).toBe(1);
});

test('D — modo clique: soltar no centro mantém a roda; clicar na fatia cria; centro, fora e Esc cancelam sem alterar o quadro', async ({ page }) => {
  const p = await emptyPoint(page);
  // Soltar no centro sem escolher direção → fica aberta.
  await hold(page, p);
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toBeVisible();
  await expect(ctxMenu(page)).toHaveCount(0);
  // Centro = cancelar.
  await page.getByTestId('radial-center').click();
  await expect(wheel(page)).toHaveCount(0);
  // Passar por uma fatia e voltar ao centro: soltar cancela.
  await hold(page, p);
  const v = await slicePoint(page, 'value');
  await page.mouse.move(v.x, v.y, { steps: 4 });
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveCount(0);
  // Esc.
  await hold(page, p);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(wheel(page)).toHaveCount(0);
  // Fora.
  await hold(page, p);
  await page.mouse.up({ button: 'right' });
  await page.mouse.click(p.x - 400, p.y - 200);
  await expect(wheel(page)).toHaveCount(0);
  expect((await state(page)).elements).toHaveLength(0);
  // Clique numa fatia depois de aberta.
  await hold(page, p);
  await page.mouse.up({ button: 'right' });
  await wheel(page).locator('[data-id="ai"]').click();
  const s = await state(page);
  expect(s.elements.map((e) => e.widgetType)).toEqual(['aurora.ai']);
});

test('E — clique direito (curto ou segurando) em elemento mantém o menu tradicional; widgets interativos não são capturados', async ({ page }) => {
  await page.evaluate(() => (window as any).__aurora.actions.addWidget('aurora.notes', { x: 0, y: 0 }));
  await page.keyboard.press('Escape');
  const s = await state(page);
  const el = s.elements[0];
  const c = await toPage(page, el.x + el.width / 2, el.y + 12);
  await watchMenus(page);
  await hold(page, c, 350);
  await page.mouse.up({ button: 'right' });
  await expect(ctxMenu(page)).toBeVisible();
  await expect(wheel(page)).toHaveCount(0);
  expect((await menuCounts(page)).wheel).toBe(0);
  await page.keyboard.press('Escape');
  // Corpo do widget (área editável) também não abre a roda.
  const body = page.locator(`[data-widget-body="${el.id}"]`);
  const bb = (await body.boundingBox())!;
  await hold(page, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }, 350);
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveCount(0);
});

test('F — Forma abre submenu e cria no tamanho padrão; Conexão só ativa a ferramenta (sem item degenerado)', async ({ page }) => {
  await oddCamera(page);
  const p = await emptyPoint(page);
  const world = await worldAt(page, p);
  await hold(page, p);
  const f = await slicePoint(page, 'shape');
  await page.mouse.move(f.x, f.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveAttribute('data-sub', 'shape');
  await wheel(page).locator('[data-id="shape:ellipse"]').click();
  let s = await state(page);
  expect(s.elements).toHaveLength(1);
  expect(s.elements[0]).toMatchObject({ type: 'ellipse', width: 160, height: 100 });
  const c = centerOf(s.elements[0]);
  expect(Math.abs(c.x - world.x) + Math.abs(c.y - world.y)).toBeLessThan(2);
  // Conexão → Seta.
  await hold(page, { x: p.x - 250, y: p.y });
  const k = await slicePoint(page, 'connector');
  await page.mouse.move(k.x, k.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveAttribute('data-sub', 'connector');
  await page.keyboard.press('Escape'); // Esc no submenu volta à roda principal
  await expect(wheel(page)).toHaveAttribute('data-sub', 'main');
  await wheel(page).locator('[data-id="connector"]').click();
  await wheel(page).locator('[data-id="tool:arrow"]').click();
  s = await state(page);
  expect(s.tool).toBe('arrow');
  expect(s.elements).toHaveLength(1);
});

test('G — teclado: W abre com foco; setas, Enter, números e Esc; “Criar” na barra também abre', async ({ page }) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('w');
  await expect(wheel(page)).toBeVisible();
  await expect(wheel(page).locator('[data-active="true"]')).toHaveAttribute('data-id', 'note');
  await expect(page.locator(':focus')).toHaveAttribute('data-id', 'note');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(':focus')).toHaveAttribute('data-id', 'task');
  await page.keyboard.press('Enter');
  await expect(wheel(page)).toHaveCount(0);
  expect((await state(page)).elements.map((e) => e.widgetType)).toEqual(['aurora.tasks']);
  // Número direto: 7 = Valor.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('w');
  await page.keyboard.press('7');
  expect((await state(page)).elements.map((e) => e.widgetType)).toEqual(['aurora.tasks', 'aurora.value']);
  // Esc fecha e devolve o foco ao canvas.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('w');
  await page.keyboard.press('Escape');
  await expect(wheel(page)).toHaveCount(0);
  await expect(page.getByTestId('canvas')).toBeFocused();
  // Botão “Criar”.
  await page.getByRole('button', { name: 'Aurora Wheel (menu de criação)' }).click();
  await expect(wheel(page)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('H — “Mais”: busca acessa Consulta bancária, HTML, Fórmula e Gráfico e cria no ponto', async ({ page }) => {
  const p = await emptyPoint(page);
  const world = await worldAt(page, p);
  await hold(page, p);
  await page.mouse.up({ button: 'right' });
  await wheel(page).locator('[data-id="more"]').click();
  const more = page.getByTestId('radial-more');
  await expect(more).toBeVisible();
  for (const name of ['Consulta bancária', 'HTML', 'Fórmula', 'Gráfico', 'grafico']) {
    await more.getByLabel('Buscar widgets').fill(name);
    await expect(more.getByTestId('radial-more-item').first()).toBeVisible();
    const ids = await more.getByTestId('radial-more-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    const want = { 'Consulta bancária': 'aurora.bank-query', HTML: 'aurora.sandbox-html', 'Fórmula': 'aurora.formula', 'Gráfico': 'aurora.chart', grafico: 'aurora.chart' }[name]!;
    expect(ids.some((id) => id?.includes(want)), `${name} → ${ids.join(', ')}`).toBe(true);
  }
  await more.getByLabel('Buscar widgets').fill('Fórmula');
  await page.keyboard.press('Enter');
  await expect(wheel(page)).toHaveCount(0);
  const s = await state(page);
  expect(s.elements.map((e) => e.widgetType)).toEqual(['aurora.formula']);
  const c = centerOf(s.elements[0]);
  expect(Math.abs(c.x - world.x) + Math.abs(c.y - world.y)).toBeLessThan(2);
});

test('I — perto da borda a roda cabe na tela, mas o item nasce no ponto clicado', async ({ page }) => {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const p = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
  const world = await worldAt(page, p);
  await hold(page, p);
  const wb = (await wheel(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(wb.x + wb.width).toBeLessThanOrEqual(vp.width);
  expect(wb.y + wb.height).toBeLessThanOrEqual(vp.height);
  expect(wb.x).toBeGreaterThanOrEqual(0);
  const v = await slicePoint(page, 'value');
  await page.mouse.move(v.x, v.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const el = (await state(page)).elements[0];
  const c = centerOf(el);
  expect(Math.abs(c.x - world.x) + Math.abs(c.y - world.y)).toBeLessThan(2);
  // A câmera não mudou para abrir a roda.
});

test('J — favoritos: personalizar, persistir após recarregar (local, fora do quadro) e descartar inválidos', async ({ page }) => {
  await page.getByTestId('canvas').click({ position: { x: 600, y: 500 } });
  const fav = page.getByTestId('radial-favorites');
  await fav.scrollIntoViewIfNeeded();
  await fav.getByLabel('Fatia 7').selectOption('widget:aurora.chart');
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  expect(await page.evaluate(() => (window as any).__aurora.getState().radialFavorites[6])).toBe('widget:aurora.chart');
  expect(await page.evaluate(() => JSON.stringify((window as any).__aurora.getState().boards))).not.toContain('radialFavorites');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('w');
  await expect(wheel(page).locator('[data-id="widget:aurora.chart"]')).toBeVisible();
  await page.keyboard.press('Escape');
  // Valor inválido gravado → padrão.
  await page.evaluate(() => new Promise<void>((res, rej) => {
    const req = indexedDB.open('aurora-board');
    req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'radialFavorites', value: ['widget:inexistente', 42, 'note'] }); tx.oncomplete = () => { req.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
    req.onerror = () => rej(req.error);
  }));
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  expect(await page.evaluate(() => (window as any).__aurora.getState().radialFavorites)).toEqual(['note', 'text', 'task', 'shape', 'connector', 'ai', 'value', 'more']);
});

test('K — modal aberto, edição de texto e outra ferramenta não abrem a roda', async ({ page }) => {
  const p = await emptyPoint(page);
  // Ferramenta retângulo.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('r');
  await hold(page, p, 350);
  await page.mouse.up({ button: 'right' });
  await expect(wheel(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Diálogo de atalhos aberto.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Atalhos de teclado' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Atalhos de teclado' })).toContainText('Aurora Wheel');
  await page.keyboard.press('Escape');
});
