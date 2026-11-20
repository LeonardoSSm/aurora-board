/**
 * Issue #22 — Smart Links (atalhos visuais). `window.open` é interceptado: nenhum teste navega para sites reais,
 * e cada teste confere que NENHUMA requisição saiu para fora do localhost (sem favicon/título automáticos).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drag, ready, state, toPage, waitSaved, type El } from './helpers';

const LINK = 'aurora.link';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
/** PNG 2×2 válido (bytes reais, não só a extensão). */
const PNG_2x2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');

const links = async (page: Page) => (await state(page)).elements.filter((e) => e.type === 'widget' && e.widgetType === LINK);
const byId = async (page: Page, id: string) => (await state(page)).elements.find((e) => e.id === id)!;
const center = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
const opened = (page: Page) => page.evaluate(() => (window as any).__opened as unknown[][]);

async function setup(page: Page) {
  const external: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url());
  });
  await page.addInitScript(() => {
    (window as any).__opened = [];
    window.open = ((...args: unknown[]) => { (window as any).__opened.push(args); return null; }) as typeof window.open;
  });
  await ready(page);
  return external;
}

/** Cola texto vindo de fora (Chromium/WebKit: ClipboardEvent real; Firefox: mesma função do handler). */
async function pasteExternal(page: Page, text: string) {
  await page.evaluate(async (t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    if (ev.clipboardData?.getData('text/plain') === t) document.dispatchEvent(ev);
    else await (window as any).__aurora.actions.pasteContent(t, [], null);
  }, text);
}

async function clickAt(page: Page, x: number, y: number, opts: { shift?: boolean } = {}) {
  const p = await toPage(page, x, y);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  if (opts.shift) await page.keyboard.up('Shift');
}

async function deselect(page: Page) {
  await page.evaluate(() => (window as any).__aurora.store.setState({ selectedIds: [] }));
}

test('colar URL cria [ícone] Nome; clique abre UMA aba; arrastar, selecionar e redimensionar não abrem', async ({ page }) => {
  const external = await setup(page);
  await pasteExternal(page, 'https://studio.youtube.com/');
  await expect.poll(async () => (await links(page)).length).toBe(1);
  const [l0] = await links(page);
  expect(l0.title).toBe('YouTube Studio');
  expect(l0.data).toMatchObject({ url: 'https://studio.youtube.com/', visual: { displayMode: 'shortcut', layout: 'horizontal', label: 'YouTube Studio' } });
  const sc = page.getByTestId('link-shortcut');
  await expect(sc).toHaveAttribute('data-state', 'ready');
  await expect(sc).toHaveAttribute('data-media', 'icon:youtube-studio');
  await expect(sc.getByTestId('link-shortcut-label')).toHaveText('YouTube Studio');
  await expect(sc).toHaveAccessibleName(/Abrir YouTube Studio/);
  // canvas sem campos de edição nem URL visível
  await expect(sc.locator('input, textarea, a')).toHaveCount(0);
  await expect(sc).not.toContainText('https://');

  // clique consciente: uma aba, nova, sem opener/referrer
  await deselect(page);
  await clickAt(page, center(l0).x, center(l0).y);
  expect(await opened(page)).toEqual([['https://studio.youtube.com/', '_blank', 'noopener,noreferrer']]);
  expect((await state(page)).selectedIds).toEqual([l0.id]);

  // arrastar move e NÃO abre
  await page.waitForTimeout(750); // fora da janela anti-duplo-clique: um clique a mais aqui abriria
  await drag(page, await toPage(page, center(l0).x, center(l0).y), await toPage(page, center(l0).x + 60, center(l0).y + 40));
  const l1 = await byId(page, l0.id);
  expect(Math.round(l1.x - l0.x)).toBe(60);
  expect(await opened(page)).toHaveLength(1);

  // Shift+clique e clique na borda só selecionam
  await deselect(page);
  await clickAt(page, center(l1).x, center(l1).y, { shift: true });
  await clickAt(page, l1.x + 2, center(l1).y);
  expect((await state(page)).selectedIds).toEqual([l0.id]);
  expect(await opened(page)).toHaveLength(1);

  // redimensionar pela alça do canto não abre; o atalho continua legível (nome visível)
  const se = await toPage(page, l1.x + l1.width + 5, l1.y + l1.height + 5);
  await drag(page, se, { x: se.x + 80, y: se.y + 24 });
  const l2 = await byId(page, l0.id);
  expect(l2.width).toBeGreaterThan(l1.width + 60);
  expect(await opened(page)).toHaveLength(1);
  await expect(sc.getByTestId('link-shortcut-label')).toBeVisible();

  // duplo clique: no máximo UMA aba
  await page.waitForTimeout(750);
  const c2 = await toPage(page, center(l2).x, center(l2).y);
  await page.mouse.dblclick(c2.x, c2.y);
  expect(await opened(page)).toHaveLength(2);

  // teclado: Enter no atalho selecionado abre; menu de contexto “Abrir link”
  await page.waitForTimeout(750);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Enter');
  expect(await opened(page)).toHaveLength(3);
  await page.waitForTimeout(750);
  await page.mouse.click(c2.x, c2.y, { button: 'right' });
  const menu = page.getByTestId('context-menu');
  for (const item of ['Abrir link', 'Editar atalho', 'Layout: Compacto', 'Converter para link clássico', 'Duplicar']) await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Abrir link/ }).click();
  expect(await opened(page)).toHaveLength(4);
  for (const call of await opened(page)) expect(call).toEqual(['https://studio.youtube.com/', '_blank', 'noopener,noreferrer']);

  // URL desconhecida: nome = domínio, ícone genérico
  await pasteExternal(page, 'https://www.exemplo-ficticio.org/painel?token=abc');
  await expect(page.locator('[data-testid="link-shortcut"][data-media="icon:globe"]')).toContainText('exemplo-ficticio.org');
  expect(external).toEqual([]);
});

test('Propriedades: nome, URL, layout, ícone e imagem; inválido não abre; persistência e backup', async ({ page }) => {
  const external = await setup(page);
  // inserção nova pela biblioteca: placeholder “Configurar link”; clique não abre nada e leva às Propriedades
  await page.locator(`[data-library-item="${LINK}#shortcut"]`).click();
  const [n0] = await links(page);
  const sc = page.locator(`[data-element-id="${n0.id}"] [data-testid="link-shortcut"]`);
  await expect(sc).toHaveAttribute('data-state', 'unconfigured');
  await expect(sc).toContainText('Configurar link');
  await deselect(page);
  await clickAt(page, center(n0).x, center(n0).y);
  expect(await opened(page)).toEqual([]);
  const insp = page.getByTestId('link-inspector');
  const url = insp.getByLabel('Endereço (URL)');
  await expect(url).toBeFocused();

  // URL perigosa: erro NO INSPETOR, dado não muda, nada abre
  await url.fill('javascript:alert(1)');
  await url.press('Enter');
  await expect(insp.getByTestId('link-url-error')).toContainText('não são aceitos');
  expect((await byId(page, n0.id)).data.url).toBe('');
  await expect(insp.getByRole('button', { name: 'Abrir link' })).toBeDisabled();

  // URL válida: nome automático pelo domínio conhecido
  await url.fill('https://www.youtube.com/@canal-ficticio');
  await url.press('Enter');
  await expect(sc).toHaveAttribute('data-state', 'ready');
  await expect(sc).toHaveAttribute('data-media', 'icon:youtube');
  await expect(sc.getByTestId('link-shortcut-label')).toHaveText('YouTube');

  // renomear não altera a URL
  await insp.getByLabel('Nome exibido').fill('Military Fails — YouTube');
  await expect(sc.getByTestId('link-shortcut-label')).toHaveText('Military Fails — YouTube');
  const n1 = await byId(page, n0.id);
  expect(n1.data.url).toBe('https://www.youtube.com/@canal-ficticio');
  expect(n1.title).toBe('Military Fails — YouTube'); // título acompanhava o automático
  // limpar o nome volta ao automático (site), sem título preso ao nome antigo
  await insp.getByLabel('Nome exibido').fill('');
  await expect(sc.getByTestId('link-shortcut-label')).toHaveText('YouTube');
  await insp.getByLabel('Nome exibido').fill('Military Fails — YouTube');
  await expect(sc.getByTestId('link-shortcut-label')).toHaveText('Military Fails — YouTube');

  // ícone manual e layout card (tamanho de referência)
  await insp.getByRole('radio', { name: 'Ícone Vídeo' }).click();
  await expect(sc).toHaveAttribute('data-media', 'icon:video');
  await insp.getByRole('radio', { name: 'Card' }).click();
  await expect(sc).toHaveAttribute('data-layout', 'card');
  expect([(await byId(page, n0.id)).width, (await byId(page, n0.id)).height]).toEqual([220, 200]);

  // Enter num controle das Propriedades aciona o controle — não abre o atalho selecionado (revisão do PR #23)
  await insp.getByRole('radio', { name: 'Compacto' }).focus();
  await page.keyboard.press('Enter');
  await expect(sc).toHaveAttribute('data-layout', 'compact');
  await insp.getByRole('radio', { name: 'Ícone Link' }).focus();
  await page.keyboard.press('Enter');
  await expect(sc).toHaveAttribute('data-media', 'icon:link');
  expect(await opened(page)).toEqual([]);
  await insp.getByRole('radio', { name: 'Ícone Vídeo' }).click();
  await insp.getByRole('radio', { name: 'Card' }).click();

  // imagem enviada (PNG pelos bytes) → asset local, sem base64 no quadro
  await insp.getByRole('radio', { name: 'Imagem', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await insp.getByRole('button', { name: /Escolher imagem/ }).click();
  await (await chooser).setFiles({ name: 'capa.png', mimeType: 'image/png', buffer: PNG_2x2 });
  await expect(sc.getByTestId('link-shortcut-image')).toBeVisible();
  const n2 = await byId(page, n0.id);
  expect(n2.data.visual.assetId).toMatch(/^a_/);
  expect(JSON.stringify(n2.data)).not.toContain('base64');

  // arquivo que não é imagem é recusado com mensagem no inspetor
  const chooser2 = page.waitForEvent('filechooser');
  await insp.getByRole('button', { name: /Trocar imagem/ }).click();
  await (await chooser2).setFiles({ name: 'falso.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"></svg>') });
  await expect(insp.getByText(/Não foi possível usar a imagem/)).toBeVisible();
  expect((await byId(page, n0.id)).data.visual.assetId).toBe(n2.data.visual.assetId);

  // desfazer volta o layout anterior; refazer reaplica
  const before = (await byId(page, n0.id)).data.visual;
  await page.getByTestId('canvas').focus();
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await byId(page, n0.id)).data.visual.assetId).toBe(''); // desfaz o envio (a escolha da fonte é outra entrada)
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(async () => (await byId(page, n0.id)).data.visual).toEqual(before);

  // reload: nome, layout e imagem continuam
  await page.keyboard.press(`${mod}+s`);
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  const sc2 = page.locator(`[data-element-id="${n0.id}"] [data-testid="link-shortcut"]`);
  await expect(sc2).toHaveAttribute('data-layout', 'card');
  await expect(sc2.getByTestId('link-shortcut-image')).toBeVisible();
  await expect(sc2.getByTestId('link-shortcut-label')).toHaveText('Military Fails — YouTube');

  // backup do quadro inclui o asset; importar como novo quadro mantém a imagem
  await page.getByRole('button', { name: /Exportar/ }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Este quadro/ }).click();
  const file = (await (await dl).path())!;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  expect(json.assets.map((a: { id: string }) => a.id)).toContain(n2.data.visual.assetId);
  await page.getByRole('button', { name: /Importar/ }).click();
  const fc = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await fc).setFiles(file);
  const boardBefore = (await state(page)).boardId;
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect.poll(async () => (await state(page)).boards.length).toBeGreaterThan(1);
  // a troca para o quadro importado é assíncrona: só segue com ele aberto (senão o próximo bloco cai no antigo)
  await expect.poll(async () => { const s = await state(page); return s.boardId !== boardBefore && s.elements.some((e) => e.widgetType === LINK); }).toBe(true);
  await page.waitForFunction(() => (window as any).__aurora.getState().status === 'ready');
  await expect(page.getByTestId('link-shortcut-image')).toBeVisible();

  // referência sem asset: cai no ícone, sem quebrar
  const missingId = await page.evaluate(() => {
    const a = (window as any).__aurora;
    const el = a.actions.addWidget('aurora.link', { x: 400, y: 0 }, { url: 'https://example.com/', visual: { displayMode: 'shortcut', layout: 'horizontal', iconMode: 'uploaded', assetId: 'a_naoexiste' } });
    a.actions.focusElement(el.id); // o canvas desmonta blocos fora da vista: enquadra antes de verificar
    return el.id as string;
  });
  await expect(page.locator(`[data-element-id="${missingId}"] [data-testid="link-shortcut"]`)).toHaveAttribute('data-media', 'icon:globe');
  expect(external).toEqual([]);
});

test('links antigos seguem Clássicos; conversão reversível; quatro redes com layouts mistos; busca e SVG', async ({ page }) => {
  const external = await setup(page);
  // bloco antigo (sem `visual`) → layout clássico idêntico, com os campos no bloco
  const legacyId = await page.evaluate(() => {
    const a = (window as any).__aurora;
    return a.actions.addWidget('aurora.link', { x: 150, y: 250 }, { url: 'https://exemplo-antigo.org/doc', description: 'Referência antiga', preview: null, visual: undefined }, { size: { width: 320, height: 210 }, title: 'Link' }).id as string;
  });
  // addWidget usa createData (atalho); grava os dados exatamente como um backup antigo, sem `visual`
  await page.evaluate((id) => {
    const a = (window as any).__aurora;
    a.actions.updateElements(new Set([id]), (e: any) => ({ ...e, data: { url: 'https://exemplo-antigo.org/doc', description: 'Referência antiga', preview: null } }));
  }, legacyId);
  const legacy = page.locator(`[data-element-id="${legacyId}"]`);
  await expect(legacy.locator('input')).toHaveValue('https://exemplo-antigo.org/doc');
  await expect(legacy.locator('textarea')).toHaveValue('Referência antiga');
  await expect(legacy.getByTestId('link-shortcut')).toHaveCount(0);
  const lc = center(await byId(page, legacyId));
  const lp = await toPage(page, lc.x, lc.y - 90); // cabeçalho
  await page.mouse.click(lp.x, lp.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: /^Converter em atalho visual/ }).click();
  await expect(legacy.getByTestId('link-shortcut')).toHaveAttribute('data-state', 'ready');
  await expect(legacy.getByTestId('link-shortcut')).toContainText('exemplo-antigo.org');
  const insp = page.getByTestId('link-inspector');
  await page.evaluate((id) => (window as any).__aurora.actions.openWidgetInspector(id), legacyId);
  // título personalizado do bloco é independente do nome exibido (revisão do PR #23)
  await page.getByLabel('Título do bloco').fill('Referências do projeto');
  await expect(legacy.getByTestId('link-shortcut')).toContainText('Referências do projeto');
  await insp.getByLabel('Nome exibido').fill('Docs');
  await expect(legacy.getByTestId('link-shortcut')).toContainText('Docs');
  await insp.getByLabel('Nome exibido').fill('');
  expect((await byId(page, legacyId)).title).toBe('Referências do projeto');
  await insp.getByRole('radio', { name: 'Clássico' }).click();
  await expect(legacy.locator('textarea')).toHaveValue('Referência antiga');
  expect((await byId(page, legacyId)).data).toMatchObject({ url: 'https://exemplo-antigo.org/doc', description: 'Referência antiga', preview: null });

  // quatro redes pela biblioteca, layouts mistos
  const ids: Record<string, string> = {};
  const layouts: Record<string, string> = { youtube: 'horizontal', tiktok: 'compact', instagram: 'card', facebook: 'horizontal' };
  const slots: Record<string, { x: number; y: number }> = { youtube: { x: -300, y: -200 }, tiktok: { x: 0, y: -200 }, instagram: { x: 250, y: -200 }, facebook: { x: -300, y: -100 } };
  for (const site of Object.keys(layouts)) {
    await page.locator(`[data-library-item="${LINK}#site-${site}"]`).click();
    const el = (await links(page)).find((e) => e.data.url?.includes(`${site}.com`))!;
    ids[site] = el.id;
    if (layouts[site] !== 'horizontal') await insp.getByRole('radio', { name: layouts[site] === 'compact' ? 'Compacto' : 'Card' }).click();
    const now = await byId(page, el.id);
    await drag(page, await toPage(page, now.x + 3, now.y + 3), await toPage(page, slots[site].x + 3, slots[site].y + 3));
  }
  for (const [site, layout] of Object.entries(layouts)) {
    const sc = page.locator(`[data-element-id="${ids[site]}"] [data-testid="link-shortcut"]`);
    await expect(sc).toHaveAttribute('data-layout', layout);
    await expect(sc).toHaveAttribute('data-media', `icon:${site}`);
  }
  expect(await opened(page)).toEqual([]); // inserir/mover/configurar nunca abre

  // busca universal (#14): acha pelo nome exibido, sem expor a URL
  await page.getByTestId('canvas').focus();
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByTestId('command-center');
  await expect(palette).toBeVisible();
  await page.keyboard.type('Instagram');
  await expect(palette.getByTestId('command-row').filter({ hasText: 'Instagram' }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
  await page.screenshot({ path: test.info().outputPath('smart-links.png') });

  // exportação SVG reflete o visual (nomes + ícones locais), sem nada externo
  await page.evaluate(() => (window as any).__aurora.store.setState({ selectedIds: [] }));
  await page.getByRole('button', { name: /Exportar/ }).click();
  const svgDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Vetor do quadro/ }).click();
  const svg = readFileSync((await (await svgDl).path())!, 'utf8');
  for (const n of ['YouTube', 'TikTok', 'Instagram', 'Facebook']) expect(svg).toContain(`>${n}</text>`);
  expect(svg).not.toMatch(/(href|src)="https?:\/\//);
  expect(await page.evaluate((t) => !new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror'), svg)).toBe(true);
  expect(external).toEqual([]);
});

test('opt-in da imagem remota vale só para a imagem autorizada: trocar URL no modo Clássico e repré-visualizar não reaproveita', async ({ page }) => {
  const IMG_A = 'https://cdn.site-a.test/og.png';
  const IMG_B = 'https://cdn.site-b.test/og.png';
  let preview = { title: 'Site A', description: 'a', image: IMG_A, siteName: 'A' };
  await page.route('**/api/link-preview', (r) => r.fulfill({ json: preview }));
  await page.route('https://cdn.site-*.test/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG_2x2 }));
  const external = await setup(page);
  await page.evaluate(() => (window as any).__aurora.actions.pasteContent('https://site-a.test/', [], { x: 0, y: 0 }));
  const [l] = await links(page);
  const sc = page.locator(`[data-element-id="${l.id}"] [data-testid="link-shortcut"]`);
  await page.evaluate((id) => (window as any).__aurora.actions.openWidgetInspector(id), l.id);
  const insp = page.getByTestId('link-inspector');
  await insp.getByRole('button', { name: 'Pré-visualizar' }).click();
  await insp.getByRole('radio', { name: 'Do site' }).click();
  await expect(sc).toHaveAttribute('data-media', 'icon:globe'); // sem opt-in: nada remoto
  expect(external.filter((u) => u.includes('cdn.site-'))).toEqual([]);
  await insp.getByRole('button', { name: 'Exibir imagem de cdn.site-a.test' }).click();
  await expect(sc).toHaveAttribute('data-media', 'remote');
  expect((await byId(page, l.id)).data.visual.remoteImageConsent.src).toBe(IMG_A);

  // Clássico: troca a URL no próprio bloco e busca nova pré-visualização (outro host de imagem)
  await insp.getByRole('radio', { name: 'Clássico' }).click();
  const block = page.locator(`[data-element-id="${l.id}"]`);
  await block.locator('input').fill('https://site-b.test/');
  preview = { title: 'Site B', description: 'b', image: IMG_B, siteName: 'B' };
  await block.getByRole('button', { name: /Pré-visualizar/ }).click();
  await expect.poll(async () => (await byId(page, l.id)).data.preview?.image).toBe(IMG_B);
  await insp.getByRole('radio', { name: 'Atalho visual' }).click();
  await expect(sc).toHaveAttribute('data-media', 'icon:globe'); // não carrega a imagem do host novo sozinho
  await expect(insp.getByTestId('link-consent-stale')).toBeVisible();
  await expect(insp.getByRole('button', { name: 'Exibir imagem de cdn.site-b.test' })).toBeVisible();
  expect(external.filter((u) => u.includes('cdn.site-b.test'))).toEqual([]);
  expect(await opened(page)).toEqual([]);
});
