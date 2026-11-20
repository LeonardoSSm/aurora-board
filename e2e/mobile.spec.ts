/**
 * Cenários responsivos em viewport de celular (Pixel 7, toque).
 * Gestos com dois dedos são simulados com PointerEvents de toque (o Playwright não tem pinça nativa).
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state, toPage } from './helpers';

async function touch(page: Page, type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number) {
  await page.evaluate(({ type, id, x, y }) => {
    const c = document.querySelector('[data-testid="canvas"]')!;
    c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 }));
  }, { type, id, x, y });
}

test('layout de celular: canvas visível, painéis como sobreposição', async ({ page }) => {
  await ready(page);
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(canvas.width).toBeGreaterThan(vw * 0.9); // painéis não espremem o canvas
  expect((await state(page)).boards.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Biblioteca de componentes' }).tap();
  await expect(page.getByRole('complementary', { name: 'Biblioteca de componentes' })).toBeVisible();
  await page.locator('[data-library-item="aurora.tasks"]').tap();
  await expect(page.getByRole('complementary', { name: 'Biblioteca de componentes' })).toBeHidden(); // fecha após inserir
  expect((await state(page)).elements.some((e) => e.widgetType === 'aurora.tasks')).toBe(true);
  // propriedades abre por cima e fecha ao tocar fora
  await page.getByRole('button', { name: 'Painel de propriedades' }).tap();
  await expect(page.getByTestId('panel-backdrop')).toBeVisible();
  await page.getByTestId('panel-backdrop').tap({ position: { x: 20, y: 300 } });
  await expect(page.getByTestId('panel-backdrop')).toBeHidden();
});

test('desenhar com o dedo, selecionar com toque e pinça para zoom', async ({ page }) => {
  await ready(page);
  await page.locator('[data-tool-button="rectangle"]').tap();
  const a = await toPage(page, -60, -40), b = await toPage(page, 60, 40);
  await touch(page, 'pointerdown', 1, a.x, a.y);
  for (let i = 1; i <= 6; i++) await touch(page, 'pointermove', 1, a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
  await touch(page, 'pointerup', 1, b.x, b.y);
  let s = await state(page);
  const rect = s.elements.find((e) => e.type === 'rectangle')!;
  expect(rect.width).toBeGreaterThan(100);

  // toque fora deseleciona; toque na borda seleciona
  const empty = await toPage(page, 0, 300);
  await page.touchscreen.tap(empty.x, empty.y);
  expect((await state(page)).selectedIds).toEqual([]);
  const edge = await toPage(page, -60, 0);
  await page.touchscreen.tap(edge.x, edge.y);
  expect((await state(page)).selectedIds).toEqual([rect.id]);

  // pinça: dois dedos se afastando aumentam o zoom
  const z0 = (await state(page)).camera.zoom;
  const c = await toPage(page, 0, 200);
  await touch(page, 'pointerdown', 1, c.x - 40, c.y);
  await touch(page, 'pointerdown', 2, c.x + 40, c.y);
  for (let i = 1; i <= 5; i++) {
    await touch(page, 'pointermove', 1, c.x - 40 - i * 12, c.y);
    await touch(page, 'pointermove', 2, c.x + 40 + i * 12, c.y);
  }
  await touch(page, 'pointerup', 1, c.x - 100, c.y);
  await touch(page, 'pointerup', 2, c.x + 100, c.y);
  s = await state(page);
  expect(s.camera.zoom).toBeGreaterThan(z0 * 1.5);
  expect(s.elements.filter((e) => e.type === 'rectangle')).toHaveLength(1); // pinça não cria nem move elementos
  expect(s.elements[0].x).toBe(rect.x);
});

test('AI Tiles no celular: inserir pela biblioteca, logo visível, mover com o dedo, abrir configurações', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Biblioteca de componentes' }).tap();
  const section = page.getByTestId('library-section-aurora.ai-tile');
  await expect(section).toBeVisible();
  await section.locator('[data-library-item="aurora.ai-tile#claude"]').tap();
  await expect(page.getByRole('complementary', { name: 'Biblioteca de componentes' })).toBeHidden();
  const tile = page.locator('[data-testid="ai-tile"][data-provider="claude"]');
  await expect(tile.getByTestId('ai-tile-logo')).toHaveAttribute('data-logo', 'claude-color');
  const t0 = (await state(page)).elements.find((e) => e.widgetType === 'aurora.ai-tile')!;
  const from = await toPage(page, t0.x + t0.width / 2, t0.y + t0.height / 2);
  await touch(page, 'pointerdown', 1, from.x, from.y);
  for (let i = 1; i <= 6; i++) await touch(page, 'pointermove', 1, from.x + i * 10, from.y + i * 12);
  await touch(page, 'pointerup', 1, from.x + 60, from.y + 72);
  const t1 = (await state(page)).elements.find((e) => e.id === t0.id)!;
  expect(t1.x - t0.x).toBeGreaterThan(30);
  // duplo toque abre as configurações (painel por cima)
  const p = await toPage(page, t1.x + t1.width / 2, t1.y + t1.height / 2);
  await page.mouse.dblclick(p.x, p.y);
  await expect(page.getByTestId('ai-tile-inspector')).toBeVisible();
});

test.describe('checkpoints no celular', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('criar local, navegar por toque, indicador tocável, pinça sem conflito', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => (window as any).__aurora.actions.createBoard('Locais celular'));
    // Cria pelo painel Locais (“Salvar aqui” = centro da tela).
    await page.getByRole('button', { name: 'Locais (checkpoints) — G' }).tap();
    const panel = page.getByTestId('locations-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Salvar aqui/ }).tap();
    const dlg = page.getByTestId('checkpoint-dialog');
    await dlg.getByLabel('Nome do checkpoint').fill('Casa');
    await dlg.getByRole('button', { name: 'Salvar' }).tap();
    await page.getByRole('button', { name: 'Fechar locais' }).tap();
    const cp = (await page.evaluate(() => (window as any).__aurora.getState().checkpoints))[0];
    // Arrasta o canvas com o dedo (ferramenta Mão) para longe: o local sai da tela e vira indicador na borda.
    await page.getByRole('button', { name: 'Mão (pan)' }).tap();
    const box = (await page.getByTestId('canvas').boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    for (let k = 0; k < 4; k++) {
      await touch(page, 'pointerdown', 1, start.x, start.y);
      for (let i = 1; i <= 8; i++) await touch(page, 'pointermove', 1, start.x - i * 30, start.y);
      await touch(page, 'pointerup', 1, start.x - 240, start.y);
    }
    const ind = page.getByTestId('checkpoint-indicator');
    await expect(ind).toHaveCount(1);
    await expect(ind).toHaveAttribute('data-side', 'left');
    const b = (await ind.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(24); // área tocável
    expect(b.x).toBeGreaterThanOrEqual(box.x);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
    // Pinça continua funcionando (gesto no canvas, não no indicador).
    const z0 = (await state(page)).camera.zoom;
    const c = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 };
    await touch(page, 'pointerdown', 1, c.x - 40, c.y);
    await touch(page, 'pointerdown', 2, c.x + 40, c.y);
    for (let i = 1; i <= 6; i++) { await touch(page, 'pointermove', 1, c.x - 40 - i * 10, c.y); await touch(page, 'pointermove', 2, c.x + 40 + i * 10, c.y); }
    await touch(page, 'pointerup', 1, c.x - 100, c.y);
    await touch(page, 'pointerup', 2, c.x + 100, c.y);
    const z1 = (await state(page)).camera.zoom;
    expect(z1).toBeGreaterThan(z0 * 1.3);
    // Tocar no indicador centraliza o local.
    await ind.tap();
    await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating(), undefined, { polling: 'raf' });
    const s = await state(page);
    const vp = await page.evaluate(() => (window as any).__aurora.getState().viewport);
    expect(Math.abs(s.camera.x - (vp.width / 2 - cp.x * s.camera.zoom))).toBeLessThan(0.01);
    expect(Math.abs(s.camera.y - (vp.height / 2 - cp.y * s.camera.zoom))).toBeLessThan(0.01);
    await expect(page.getByTestId('checkpoint-marker')).toHaveCount(1);
  });
});

test('Aurora Wheel no celular (#15): toque longo não abre a roda; o botão “Criar” abre e o toque na fatia cria', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Roda celular'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const p = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
  // Toque longo (sem gesto implementado para toque nesta entrega): nada de roda.
  await touch(page, 'pointerdown', 1, p.x, p.y);
  await page.waitForTimeout(400);
  await touch(page, 'pointerup', 1, p.x, p.y);
  await expect(page.getByTestId('radial-menu')).toHaveCount(0);
  // Botão “Criar” na barra.
  const btn = page.getByTestId('radial-open-button');
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  const wheel = page.getByTestId('radial-menu');
  await expect(wheel).toBeVisible();
  const wb = (await wheel.boundingBox())!;
  const vw = page.viewportSize()!;
  expect(wb.x).toBeGreaterThanOrEqual(0);
  expect(wb.x + wb.width).toBeLessThanOrEqual(vw.width);
  await wheel.locator('[data-id="task"]').tap();
  await expect(wheel).toHaveCount(0);
  expect((await state(page)).elements.map((e) => e.widgetType)).toEqual(['aurora.tasks']);
});

test('Command Center no celular (#14): botão de busca visível, paleta cabe na tela e encontra o conteúdo', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const a = (window as any).__aurora;
    await a.actions.createBoard('Busca celular');
    a.actions.addWidget('aurora.notes', { x: 0, y: 0 }, { markdown: 'lista do mercado', mode: 'preview' }, { title: 'Compras' });
    a.store.setState({ editingWidgetId: null, selectedIds: [] });
  });
  const btn = page.getByRole('button', { name: 'Buscar (Ctrl+K)' });
  await expect(btn).toBeVisible();
  await btn.tap();
  const pal = page.getByTestId('command-center');
  await expect(pal).toBeVisible();
  const box = (await pal.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await pal.getByRole('combobox').fill('mercado');
  await expect(pal.getByTestId('command-row').first()).toContainText('Compras');
  await pal.getByTestId('command-row').first().tap();
  await expect(pal).toHaveCount(0);
  expect((await state(page)).selectedIds).toHaveLength(1);
});

test('AI Companion no celular (#13): tocar no personagem abre o mini chat dentro da tela; dock acessível', async ({ page }) => {
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [{ id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'mock' }] } }));
  await page.route('**/api/ai/chat', (r) => r.fulfill({ json: { text: 'resposta no celular', provider: 'anthropic', model: 'mock' } }));
  await ready(page);
  const id = await page.evaluate(async () => {
    const a = (window as any).__aurora;
    await a.actions.createBoard('Companion celular');
    const v = a.getState().viewport;
    const el = a.actions.addWidget('aurora.ai', { x: 0, y: 0 }, { companion: { displayMode: 'character', preset: 'aurora', name: 'Aurora', docked: true } }, { size: { width: 160, height: 200 } });
    a.store.setState({ selectedIds: [], camera: { x: v.width / 2, y: v.height / 2, zoom: 1 } });
    return el.id;
  });
  await page.locator(`[data-testid="companion-character"][data-id="${id}"] [data-testid="companion-open"]`).tap();
  const chat = page.getByTestId('companion-minichat');
  await expect(chat).toBeVisible();
  const box = (await chat.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await chat.getByRole('textbox').fill('oi');
  await chat.getByRole('button', { name: 'Enviar' }).tap();
  await expect(chat.getByTestId('companion-bubble').last()).toContainText('resposta no celular');
  await chat.getByRole('button', { name: 'Fechar conversa' }).tap();
  await expect(page.locator(`[data-testid="companion-dock-item"][data-id="${id}"]`)).toBeVisible();
});

test('Smart Links no celular (#22): toque abre uma aba; toque longo e arrasto com o dedo não abrem', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = ((...a: unknown[]) => { (window as any).__opened.push(a); return null; }) as typeof window.open;
  });
  await ready(page);
  const id = await page.evaluate(async () => {
    await (window as any).__aurora.actions.pasteContent('https://www.tiktok.com/', [], null);
    const s = (window as any).__aurora.getState();
    (window as any).__aurora.store.setState({ selectedIds: [] });
    return s.elements.find((e: any) => e.widgetType === 'aurora.link').id as string;
  });
  const el = () => state(page).then((s) => s.elements.find((e) => e.id === id)!);
  const e0 = await el();
  const c = await toPage(page, e0.x + e0.width / 2, e0.y + e0.height / 2);
  const opened = () => page.evaluate(() => (window as any).__opened.length as number);
  // toque curto
  await touch(page, 'pointerdown', 1, c.x, c.y);
  await touch(page, 'pointerup', 1, c.x, c.y);
  expect(await opened()).toBe(1);
  await page.waitForTimeout(750);
  // toque longo: seleciona, não abre
  await touch(page, 'pointerdown', 1, c.x, c.y);
  await page.waitForTimeout(700);
  await touch(page, 'pointerup', 1, c.x, c.y);
  expect(await opened()).toBe(1);
  expect((await state(page)).selectedIds).toEqual([id]);
  // arrastar com o dedo move, não abre
  await touch(page, 'pointerdown', 1, c.x, c.y);
  for (let i = 1; i <= 5; i++) await touch(page, 'pointermove', 1, c.x + i * 8, c.y + i * 6);
  await touch(page, 'pointerup', 1, c.x + 40, c.y + 30);
  expect((await el()).x - e0.x).toBeGreaterThan(20);
  expect(await opened()).toBe(1);
  await expect(page.getByTestId('link-shortcut')).toHaveAttribute('data-media', 'icon:tiktok');
});
