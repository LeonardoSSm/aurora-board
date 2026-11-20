import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drag, emptyCanvasPoint, expectNear, ready, state, toPage, waitSaved, type El } from './helpers';

const TILE = 'aurora.ai-tile';
const LOGO: Record<string, string> = { chatgpt: 'openai', codex: 'codex-color', claude: 'claude-color', 'claude-code': 'claudecode-color', gemini: 'gemini-color', grok: 'grok' };

const tiles = async (page: Page) => (await state(page)).elements.filter((e) => e.type === 'widget' && e.widgetType === TILE);
const byProvider = async (page: Page, p: string) => (await tiles(page)).find((t) => t.data.providerId === p)!;
const center = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
const signature = (els: El[]) =>
  els
    .filter((e) => e.widgetType === TILE)
    .map((e) => ({ id: e.id, title: e.title, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height), data: e.data, groups: e.groupIds.length }))
    .sort((a, b) => a.id.localeCompare(b.id));

/** Insere pela biblioteca (clique) e arrasta o tile novo, que nasce no centro, até `slot` (mundo). */
async function insertAndPlace(page: Page, provider: string, slot: { x: number; y: number }) {
  await page.locator(`[data-library-item="${TILE}#${provider}"]`).click();
  const t = await byProvider(page, provider);
  await drag(page, await toPage(page, center(t).x, center(t).y), await toPage(page, slot.x, slot.y));
  expectNear(center(await byProvider(page, provider)), slot, 1.5);
}

test('AI Tiles: biblioteca, logos, edição, conexões, persistência e exportações', async ({ page, browserName }) => {
  await ready(page);

  // 1–3: seção de IAs na biblioteca com as seis logos corretas; busca por nome/empresa
  const section = page.getByTestId(`library-section-${TILE}`);
  await expect(section).toBeVisible();
  await expect(section.getByText('Inteligências Artificiais')).toBeVisible();
  for (const name of ['ChatGPT', 'Codex', 'Claude', 'Claude Code', 'Gemini', 'Grok']) await expect(section.getByRole('button', { name: `Inserir ${name}`, exact: true })).toBeVisible();
  await expect(section.locator('img')).toHaveCount(6);
  const search = page.getByPlaceholder('Buscar componentes');
  await search.fill('anthropic');
  await expect(section.locator('[data-library-item]')).toHaveCount(2);
  await search.fill('');

  // 4–8: inserir por clique e posicionar em duas linhas
  await insertAndPlace(page, 'chatgpt', { x: -380, y: -220 });
  await insertAndPlace(page, 'claude', { x: -150, y: -220 });
  await insertAndPlace(page, 'gemini', { x: 80, y: -220 });
  await insertAndPlace(page, 'grok', { x: -380, y: -20 });
  await insertAndPlace(page, 'codex', { x: -150, y: -20 });

  // 9: Claude Code por arrastar-e-soltar da biblioteca até um ponto do quadro
  const canvas = page.getByTestId('canvas');
  const cbox = (await canvas.boundingBox())!;
  const dropAt = await toPage(page, 80, -20);
  if (browserName !== 'webkit') {
    await page.locator(`[data-library-item="${TILE}#claude-code"]`).dragTo(canvas, { targetPosition: { x: dropAt.x - cbox.x, y: dropAt.y - cbox.y } });
  } else {
    // O Playwright/WebKit não completa arrastar-e-soltar HTML5 nativo: dispara a mesma sequência de eventos
    // (dragstart no item da biblioteca → dragover/drop no canvas) com um DataTransfer real.
    await page.evaluate(({ sel, x, y }) => {
      const dt = new DataTransfer();
      const item = document.querySelector(sel)!;
      const canvasEl = document.querySelector('[data-testid="canvas"]')!;
      item.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      canvasEl.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      canvasEl.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, { sel: `[data-library-item="${TILE}#claude-code"]`, x: dropAt.x, y: dropAt.y });
  }
  await expect.poll(async () => (await tiles(page)).length).toBe(6);
  expectNear(center(await byProvider(page, 'claude-code')), { x: 80, y: -20 }, 3);

  // 10: cada tile mostra a logo local correta (sem cabeçalho de widget)
  for (const [p, logo] of Object.entries(LOGO)) {
    const tile = page.locator(`[data-testid="ai-tile"][data-provider="${p}"]`);
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId('ai-tile-logo')).toHaveAttribute('data-logo', logo);
    await expect(tile.getByTestId('ai-tile-logo')).toHaveAttribute('href', /^data:image\/svg\+xml/);
  }
  await expect(page.locator('[data-frame="bare"] header')).toHaveCount(0);

  // 11: arrastar
  const g0 = await byProvider(page, 'grok');
  await drag(page, await toPage(page, center(g0).x, center(g0).y), await toPage(page, center(g0).x + 30, center(g0).y + 40));
  expectNear(await byProvider(page, 'grok'), { x: g0.x + 30, y: g0.y + 40 }, 1.5);

  // 12: redimensionar pela alça do canto; Ctrl+Z desfaz
  const gm = await byProvider(page, 'gemini');
  await page.mouse.click((await toPage(page, center(gm).x, center(gm).y)).x, (await toPage(page, center(gm).x, center(gm).y)).y);
  await drag(page, await toPage(page, gm.x + gm.width + 5, gm.y + gm.height + 5), await toPage(page, gm.x + gm.width + 65, gm.y + gm.height + 45));
  const gm2 = await byProvider(page, 'gemini');
  expect(gm2.width).toBeGreaterThan(gm.width + 40);
  await page.keyboard.press('Control+z');
  expectNear(await byProvider(page, 'gemini'), { width: gm.width, height: gm.height }, 0.5);
  await page.keyboard.press('Control+y');
  expectNear(await byProvider(page, 'gemini'), { width: gm2.width }, 0.5);

  // 13: agrupar dois tiles
  const chat = await byProvider(page, 'chatgpt');
  const cl = await byProvider(page, 'claude');
  await page.mouse.click((await toPage(page, center(chat).x, center(chat).y)).x, (await toPage(page, center(chat).x, center(chat).y)).y);
  await page.keyboard.down('Shift');
  await page.mouse.click((await toPage(page, center(cl).x, center(cl).y)).x, (await toPage(page, center(cl).x, center(cl).y)).y);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+g');
  const grouped = [await byProvider(page, 'chatgpt'), await byProvider(page, 'claude')];
  expect(grouped[0].groupIds).toHaveLength(1);
  expect(grouped[1].groupIds).toEqual(grouped[0].groupIds);

  // 14: conectar dois tiles com seta ancorada; mover o tile leva a seta junto
  const empty = await emptyCanvasPoint(page);
  await page.mouse.click(empty.x, empty.y);
  const cx = await byProvider(page, 'codex');
  const cc = await byProvider(page, 'claude-code');
  await page.keyboard.press('a');
  await drag(page, await toPage(page, center(cx).x, center(cx).y), await toPage(page, center(cc).x, center(cc).y), { steps: 10 });
  let s = await state(page);
  const arrow = s.elements.find((e) => e.type === 'arrow')!;
  expect([arrow.startBinding?.elementId, arrow.endBinding?.elementId]).toEqual([cx.id, cc.id]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await drag(page, await toPage(page, center(cc).x, center(cc).y), await toPage(page, center(cc).x + 40, center(cc).y + 60));
  s = await state(page);
  const arrow2 = s.elements.find((e) => e.id === arrow.id)!;
  expect(arrow2.endBinding?.elementId).toBe(cc.id);
  expect(Math.round(arrow2.y + arrow2.height)).not.toBe(Math.round(arrow.y + arrow.height));

  // 15: duplo clique abre as configurações; editar descrição sem disparar atalhos
  const ccNow = await byProvider(page, 'claude-code');
  const cp = await toPage(page, center(ccNow).x, center(ccNow).y);
  await page.mouse.dblclick(cp.x, cp.y);
  const desc = page.getByLabel('Descrição do tile');
  await expect(desc).toBeFocused();
  await desc.pressSequentially('Implementa e revisa');
  expect((await state(page)).tool).toBe('select');
  await expect.poll(async () => (await byProvider(page, 'claude-code')).data.description).toBe('Implementa e revisa');

  // 16: alterar o modo visual (tamanho de referência do modo)
  await page.getByTestId('ai-tile-inspector').getByRole('radio', { name: 'Detalhado' }).click();
  const det = await byProvider(page, 'claude-code');
  expect([det.data.displayMode, det.width, det.height]).toEqual(['detailed', 200, 150]);
  await expect(page.locator('[data-testid="ai-tile"][data-provider="claude-code"]')).toHaveAttribute('data-mode', 'detailed');
  await expect(page.locator('[data-testid="ai-tile"][data-provider="claude-code"]').getByText('Implementa e revisa')).toBeVisible();

  // menu de contexto: ações do tile + genéricas
  await page.mouse.click(cp.x, cp.y, { button: 'right' });
  const menu = page.getByTestId('context-menu');
  for (const item of ['Editar tile', 'Abrir ferramenta', 'Vincular assistente…', 'Duplicar', 'Agrupar', 'Excluir']) await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible();
  await page.keyboard.press('Escape');

  // 17–18: salvar, recarregar e conferir tudo
  const before = signature((await state(page)).elements);
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  expect(signature((await state(page)).elements)).toEqual(before);
  await expect(page.locator('[data-testid="ai-tile-logo"]')).toHaveCount(6);
  const arrowAfter = (await state(page)).elements.find((e) => e.type === 'arrow')!;
  expect([arrowAfter.startBinding?.elementId, arrowAfter.endBinding?.elementId]).toEqual([cx.id, cc.id]);

  // 22–23 (antes de importar, para exportar o quadro original): SVG com as seis logos embutidas
  await page.getByRole('button', { name: /Exportar/ }).click();
  const svgDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Vetor do quadro/ }).click();
  const svg = readFileSync((await (await svgDl).path())!, 'utf8');
  expect(svg.match(/<image href="data:image\/svg\+xml/g)).toHaveLength(6);
  for (const n of ['ChatGPT', 'Claude', 'Gemini', 'Codex', 'Claude Code', 'Implementa e revisa']) expect(svg).toContain(n);
  expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // nada hospedado externamente
  const parseOk = await page.evaluate((t) => !new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror'), svg);
  expect(parseOk).toBe(true);

  // 21, 23: PNG com as cores das marcas (laranja Claude/Claude Code, azuis Gemini/Codex)
  await page.getByRole('button', { name: /Exportar/ }).click();
  const pngDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Imagem do quadro/ }).click();
  const png = readFileSync((await (await pngDl).path())!).toString('base64');
  const colors = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let orange = 0, blue = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (Math.abs(r - 217) < 20 && Math.abs(g - 119) < 20 && Math.abs(b - 87) < 20) orange++;
      if (b > 200 && r < 140 && g < 190) blue++;
      if (r > 240 && g > 240 && b > 240) white++;
    }
    return { w: bmp.width, h: bmp.height, orange, blue, white };
  }, png);
  expect(colors.w).toBeGreaterThan(400);
  expect(colors.orange).toBeGreaterThan(200);
  expect(colors.blue).toBeGreaterThan(100);
  expect(colors.white).toBeGreaterThan(200);

  // 19–20: exportar JSON e importar como novo quadro (original preservado)
  await page.getByRole('button', { name: /Exportar/ }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Este quadro/ }).click();
  const file = await (await dl).path();
  const boardsBefore = (await state(page)).boards.length;
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser).setFiles(file!);
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect.poll(async () => (await state(page)).boards.length).toBe(boardsBefore + 1);
  const imported = await state(page);
  const name = imported.boards.find((b) => b.id === imported.boardId)!.name;
  expect(imported.boards.filter((b) => b.name === name)).toHaveLength(2); // original preservado + cópia
  expect(signature(imported.elements)).toEqual(before);
  await expect(page.locator('[data-testid="ai-tile-logo"]')).toHaveCount(6);
  await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
  await page.screenshot({ path: test.info().outputPath('ai-tiles-final.png') });
});

test('AI Tile: link https, vínculo com bloco de IA e estado honesto sem chave', async ({ page }) => {
  // Servidor simulado com só a chave Anthropic configurada (o status é lido uma vez e fica em cache).
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [{ id: 'openai', name: 'OpenAI', configured: false, defaultModel: 'x' }, { id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'y' }, { id: 'gemini', name: 'Gemini', configured: false, defaultModel: 'z' }] } }));
  await ready(page);
  await page.locator(`[data-library-item="${TILE}#claude"]`).click();
  await page.locator(`[data-library-item="${TILE}#chatgpt"]`).click();
  const claude = await byProvider(page, 'claude');
  const chat = await byProvider(page, 'chatgpt');
  // separa os dois
  await drag(page, await toPage(page, center(chat).x, center(chat).y), await toPage(page, center(chat).x - 250, center(chat).y + 250)); // separa (o bloco de IA dele nasce à direita, abaixo do Claude)

  // Sem vínculo: visual
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('data-integration', 'visual');
  const cp = await toPage(page, center(claude).x, center(claude).y);
  await page.mouse.dblclick(cp.x, cp.y);
  const inspector = page.getByTestId('ai-tile-inspector');

  // link: inválido é recusado, https é aceito e abre em nova aba
  const link = inspector.getByLabel('Link externo');
  await link.fill('javascript:alert(1)');
  await expect(inspector.getByText('Use um endereço https:// válido.')).toBeVisible();
  await link.press('Enter');
  expect((await byProvider(page, 'claude')).data.externalUrl).toBe('https://claude.ai/');
  await link.fill('https://claude.ai/new');
  await link.press('Enter');
  await expect.poll(async () => (await byProvider(page, 'claude')).data.externalUrl).toBe('https://claude.ai/new');
  const popup = page.waitForEvent('popup');
  await page.route('https://claude.ai/**', (r) => r.fulfill({ body: 'ok' }));
  await inspector.getByRole('button', { name: 'Abrir ferramenta' }).click();
  expect((await popup).url()).toBe('https://claude.ai/new');

  // criar assistente vinculado: bloco Assistente IA com provedor Anthropic + seta
  await inspector.getByRole('button', { name: /Criar assistente vinculado/ }).click();
  const s = await state(page);
  const ai = s.elements.find((e) => e.type === 'widget' && e.widgetType === 'aurora.ai')!;
  expect(ai.data.provider).toBe('anthropic');
  expect((await byProvider(page, 'claude')).data.linkedWidgetId).toBe(ai.id);
  expect(s.elements.some((e) => e.type === 'arrow' && e.startBinding?.elementId === claude.id && e.endBinding?.elementId === ai.id)).toBe(true);
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('data-integration', 'configured');

  // ChatGPT não pode ser ligado ao bloco Anthropic; vinculado ao OpenAI sem chave → "não configurada"
  const chatNow = await byProvider(page, 'chatgpt');
  const chp = await toPage(page, center(chatNow).x, center(chatNow).y);
  await page.mouse.dblclick(chp.x, chp.y);
  await expect(inspector.getByLabel('Bloco de IA vinculado').locator('option')).toHaveCount(1);
  await inspector.getByRole('button', { name: /Criar assistente vinculado/ }).click();
  await expect(page.locator('[data-provider="chatgpt"]')).toHaveAttribute('data-integration', 'not-configured');

  // Abrir assistente enquadra e seleciona o bloco vinculado
  await page.mouse.click(cp.x, cp.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Abrir assistente' }).click();
  expect((await state(page)).selectedIds).toEqual([ai.id]);

  // Remover vínculo volta a visual
  const claudeNow = await byProvider(page, 'claude');
  // Ponto na parte direita do tile: depois do enquadramento ele pode ficar parcialmente sob a Biblioteca.
  const p2 = await toPage(page, claudeNow.x + claudeNow.width * 0.8, center(claudeNow).y);
  await page.mouse.click(p2.x, p2.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Remover vínculo' }).click();
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('data-integration', 'visual');
});

test('AI Tile Grok: só visual, sem opção de vínculo', async ({ page }) => {
  await ready(page);
  await page.locator(`[data-library-item="${TILE}#grok"]`).click();
  const g = await byProvider(page, 'grok');
  const p = await toPage(page, center(g).x, center(g).y);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu.getByRole('menuitem', { name: 'Abrir ferramenta' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Vincular/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(p.x, p.y);
  await expect(page.getByTestId('ai-tile-inspector').getByText('Sem integração funcional nesta versão')).toBeVisible();
});
