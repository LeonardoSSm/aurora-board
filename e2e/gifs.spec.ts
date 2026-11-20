/**
 * Ciclo 6 — GIFs animados no canvas. GIFs sintéticos gerados por tests/fixtures/gifEncoder.ts (licença do
 * projeto). A animação é verificada por capturas de tela do próprio elemento em momentos diferentes (o canvas
 * 2D sempre desenha o primeiro quadro de um GIF, por especificação, então não serve para isso).
 */
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ready, state } from './helpers';
import { loopingGif, staticGif, toBase64 } from '../tests/fixtures/gifEncoder';

// A configuração geral usa movimento reduzido; aqui o padrão é o de um usuário comum.
test.use({ reducedMotion: 'no-preference' });

async function board(page: Page) {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('GIFs E2E'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
}

/** Insere pelo seletor de arquivos (ferramenta Imagem). */
async function pickGif(page: Page, name: string, bytes: Uint8Array) {
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as any).__aurora.actions.setTool('image'));
  await (await chooser).setFiles({ name, mimeType: 'image/gif', buffer: Buffer.from(bytes) });
  await expect.poll(async () => (await state(page)).elements.filter((e) => e.type === 'image').length).toBeGreaterThan(0);
}

/** Arrastar e soltar um arquivo sobre o canvas (evento real com DataTransfer). */
async function dropGif(page: Page, name: string, bytes: Uint8Array) {
  await page.evaluate(({ b64, name }) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], name, { type: 'image/gif' }));
    const canvas = document.querySelector('[data-testid=canvas]')!;
    const r = canvas.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    canvas.dispatchEvent(new DragEvent('dragover', opts));
    canvas.dispatchEvent(new DragEvent('drop', opts));
  }, { b64: toBase64(bytes), name });
}

const img = (page: Page, id: string) => page.locator(`[data-element-id="${id}"] img`);

/** Animado = capturas do elemento mudam ao longo de ~1 s (quadros de 200 ms). */
async function isAnimating(page: Page, id: string, windowMs = 1000): Promise<boolean> {
  await expect(img(page, id)).toBeVisible();
  const shots: string[] = [];
  for (let t = 0; t < windowMs; t += 150) {
    shots.push((await img(page, id).screenshot()).toString('base64'));
    await page.waitForTimeout(150);
  }
  return new Set(shots).size > 1;
}

/** Chama uma ação de arquivo do app (mesma instância de módulo servida pelo Vite). */
const fileAction = (page: Page, name: string, args: unknown[]) =>
  page.evaluate(async ({ name, args }) => { const path = '/src/ui/fileActions.tsx'; const m = await import(/* @vite-ignore */ path); await m[name](...args); }, { name, args });

const images = async (page: Page) => (await state(page)).elements.filter((e) => e.type === 'image');

test('GIF com repetição anima no canvas; GIF que tocaria uma vez repete continuamente por padrão', async ({ page }) => {
  await board(page);
  await pickGif(page, 'laco.gif', loopingGif(0));
  await dropGif(page, 'uma-vez.gif', loopingGif('once'));
  await expect.poll(async () => (await images(page)).length).toBe(2);
  const [a, b] = await images(page);
  expect(await isAnimating(page, a.id)).toBe(true);
  await page.waitForTimeout(800); // o original pararia após 400 ms
  expect(await isAnimating(page, b.id)).toBe(true);
  await expect(img(page, b.id)).toHaveAttribute('data-gif', 'animate');
});

test('“Como no arquivo” respeita a repetição do GIF; “Pausar” mostra o primeiro quadro', async ({ page }) => {
  await board(page);
  await pickGif(page, 'uma-vez.gif', loopingGif('once'));
  const [el] = await images(page);
  await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), el.id);
  await expect(page.getByTestId('gif-info')).toContainText('2 quadros');
  await expect(page.getByTestId('gif-info')).toContainText('toca uma vez');
  await page.getByTestId('gif-controls').getByRole('radio', { name: 'Como no arquivo' }).click();
  await page.waitForTimeout(900);
  expect(await isAnimating(page, el.id, 800)).toBe(false); // terminou e ficou parado
  await page.getByTestId('gif-controls').getByRole('radio', { name: 'Repetir sempre' }).click();
  expect(await isAnimating(page, el.id)).toBe(true);
  await page.getByTestId('gif-controls').getByRole('radio', { name: 'Pausar' }).click();
  await expect(page.getByTestId('gif-static-badge')).toBeVisible();
  expect(await isAnimating(page, el.id, 800)).toBe(false);
  // Desfazer volta à reprodução.
  await page.evaluate(() => (window as any).__aurora.actions.undo());
  await expect(page.getByTestId('gif-static-badge')).toHaveCount(0);
  expect((await images(page))[0].animation?.playback).not.toBe('pause');
});

test.describe('movimento reduzido', () => {
  test.use({ reducedMotion: 'reduce' });
  test('com movimento reduzido o GIF fica parado (selo) até o usuário escolher Reproduzir', async ({ page }) => {
    await board(page);
    await pickGif(page, 'laco.gif', loopingGif(0));
    const [el] = await images(page);
    await expect(img(page, el.id)).toHaveAttribute('data-gif', 'static');
    await expect(page.getByTestId('gif-static-badge')).toBeVisible();
    expect(await isAnimating(page, el.id, 800)).toBe(false);
    await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), el.id);
    await page.getByTestId('gif-controls').getByRole('radio', { name: 'Reproduzir' }).click();
    expect(await isAnimating(page, el.id)).toBe(true);
  });
  test('preferência geral “Sempre” anima mesmo com movimento reduzido; “Nunca” para tudo', async ({ page }) => {
    await board(page);
    await pickGif(page, 'laco.gif', loopingGif(0));
    const [el] = await images(page);
    await page.evaluate(() => (window as any).__aurora.actions.setSelection([]));
    await page.getByTestId('animation-prefs').getByRole('radio', { name: 'Sempre' }).click();
    expect(await isAnimating(page, el.id)).toBe(true);
    await page.getByTestId('animation-prefs').getByRole('radio', { name: 'Nunca' }).click();
    await expect(img(page, el.id)).toHaveAttribute('data-gif', 'static');
    // A preferência é geral e persiste.
    await page.reload();
    await ready(page);
    await expect(page.locator('[data-gif]').first()).toHaveAttribute('data-gif', 'static');
    await page.evaluate(() => (window as any).__aurora.actions.setAnimationPrefs({ mode: 'system' }));
  });
});

test('persistência, duplicar, redimensionar e agrupar mantêm a animação', async ({ page }) => {
  await board(page);
  await pickGif(page, 'uma-vez.gif', loopingGif('once'));
  const [el] = await images(page);
  await page.evaluate((id) => {
    const A = (window as any).__aurora;
    A.actions.setSelection([id]);
    A.actions.duplicateSelected();
  }, el.id);
  await expect.poll(async () => (await images(page)).length).toBe(2);
  const copy = (await images(page)).find((e) => e.id !== el.id)!;
  expect(copy.assetId).toBe(el.assetId);
  await page.evaluate(({ a, b }) => {
    const A = (window as any).__aurora;
    A.actions.updateElements(new Set([a]), (e: any) => ({ ...e, width: e.width * 2, height: e.height * 2 }));
    A.actions.setSelection([a, b]);
    A.actions.groupSelection();
  }, { a: el.id, b: copy.id });
  expect(await isAnimating(page, el.id)).toBe(true);
  expect(await isAnimating(page, copy.id)).toBe(true);
  await page.waitForFunction(() => (window as any).__aurora.getState().saveState === 'saved');
  await page.reload();
  await ready(page);
  const after = await images(page);
  expect(after).toHaveLength(2);
  expect(after.every((e) => e.groupIds.length === 1)).toBe(true);
  expect(await isAnimating(page, after[0].id)).toBe(true);
});

test('PNG/SVG exportam o primeiro quadro de forma determinística; JSON preserva o GIF original', async ({ page }) => {
  await board(page);
  const bytes = loopingGif('once');
  await pickGif(page, 'uma-vez.gif', bytes);
  await pickGif(page, 'parado.gif', staticGif());
  // Duas exportações SVG em momentos diferentes da animação: idênticas e com o primeiro quadro.
  const exportOnce = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), fileAction(page, 'exportImage', ['svg', false])]);
    return readFile((await dl.path())!, 'utf8');
  };
  const s1 = await exportOnce();
  await page.waitForTimeout(300);
  const s2 = await exportOnce();
  expect(s1).toBe(s2);
  expect(s1).not.toContain(toBase64(bytes)); // não embute o GIF animado
  expect(s1).toContain('data:image/gif;base64,');
  // JSON do quadro: o GIF original, byte a byte.
  const [dl] = await Promise.all([page.waitForEvent('download'), fileAction(page, 'exportCurrentBoardJSON', [])]);
  const json = JSON.parse(await readFile((await dl.path())!, 'utf8'));
  expect(json.assets.map((a: any) => a.dataURL)).toContain(`data:image/gif;base64,${toBase64(bytes)}`);
  // PNG também sai (estático) sem erro.
  const [png] = await Promise.all([page.waitForEvent('download'), fileAction(page, 'exportImage', ['png', false])]);
  expect((await readFile((await png.path())!)).subarray(1, 4).toString()).toBe('PNG');
});

test('vários GIFs: pan e zoom continuam funcionando; ao voltar à tela o GIF não reinicia do zero', async ({ page }) => {
  await board(page);
  const files = Array.from({ length: 24 }, (_, i) => ({ name: `g${i}.gif`, bytes: loopingGif(0, 48 + i) }));
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as any).__aurora.actions.setTool('image'));
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: 'image/gif', buffer: Buffer.from(f.bytes) })));
  await expect.poll(async () => (await images(page)).length).toBe(24);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    await page.evaluate((i) => {
      const A = (window as any).__aurora;
      const c = A.getState().camera;
      A.store.setState({ camera: { ...c, x: c.x + (i % 2 ? 40 : -40), zoom: Math.max(0.5, Math.min(2, c.zoom * (i % 4 < 2 ? 1.05 : 0.95))) } });
    }, i);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  expect(Date.now() - t0).toBeLessThan(10_000);
  const [first] = await images(page);
  expect(await isAnimating(page, first.id)).toBe(true);
  await page.evaluate(() => (window as any).__aurora.actions.setSelection([])); // selecionado nunca é desmontado
  // Sai da tela (desmontado) e volta: mesma URL de exibição → o navegador retoma a animação.
  const before = await img(page, first.id).getAttribute('src');
  await page.evaluate(() => { const A = (window as any).__aurora; const c = A.getState().camera; (window as any).__c = c; A.store.setState({ camera: { ...c, x: c.x - 50_000 } }); });
  await expect(img(page, first.id)).toHaveCount(0);
  await page.evaluate(() => (window as any).__aurora.store.setState({ camera: (window as any).__c }));
  expect(await img(page, first.id).getAttribute('src')).toBe(before);
  expect(await isAnimating(page, first.id)).toBe(true);
});

test('colar um GIF da área de transferência insere a imagem animada', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit não entrega clipboardData em eventos de colar sintéticos (ver KNOWN_ISSUES › Testes)');
  await board(page);
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], 'colado.gif', { type: 'image/gif' }));
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, toBase64(loopingGif('once')));
  await expect.poll(async () => (await images(page)).length).toBe(1);
  const [el] = await images(page);
  await page.waitForTimeout(600);
  expect(await isAnimating(page, el.id)).toBe(true);
});

test('arquivo .gif inválido mostra erro amigável e nada é inserido', async ({ page }) => {
  await board(page);
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as any).__aurora.actions.setTool('image'));
  await (await chooser).setFiles({ name: 'falso.gif', mimeType: 'image/gif', buffer: Buffer.from('isto não é um gif') });
  await expect(page.getByText(/não é uma imagem válida/)).toBeVisible();
  expect(await images(page)).toHaveLength(0);
});
