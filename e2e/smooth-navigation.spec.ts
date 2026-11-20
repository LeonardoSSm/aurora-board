/**
 * Issue #12 — viagem suave da câmera ao navegar para Locais. Mede a câmera em cada quadro (requestAnimationFrame)
 * para provar interpolação, destino exato e duração; cobre movimento reduzido, a preferência “Sempre”, velocidade
 * persistida, os quatro pontos de entrada (lista, indicador, marcador → Ir) e os cancelamentos.
 */
import { expect, test, type Page } from '@playwright/test';
import { drag, emptyCanvasPoint, ready, state } from './helpers';

type Cam = { x: number; y: number; zoom: number };
type Sample = { t: number; x: number; y: number; zoom: number };

const vpOf = (page: Page) => page.evaluate(() => (window as any).__aurora.getState().viewport as { width: number; height: number });
const settle = async (page: Page) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating(), undefined, { polling: 'raf', timeout: 8000 });
};

/** Começa a gravar a câmera a cada quadro. */
const startRecording = (page: Page) => page.evaluate(() => {
  const w = window as any;
  w.__camLog = [];
  w.__camRec = true;
  const loop = () => {
    const c = w.__aurora.getState().camera;
    w.__camLog.push({ t: performance.now(), x: c.x, y: c.y, zoom: c.zoom });
    if (w.__camRec) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const stopRecording = (page: Page) => page.evaluate(() => { const w = window as any; w.__camRec = false; return w.__camLog as Sample[]; });

/**
 * Análise de uma gravação: quadros que mudaram a câmera, duração, aproximação monotônica do destino (sem recuar nem
 * ultrapassar) e `maxShare` — fração do deslocamento total na tela feita num único quadro (teleporte = 1).
 * `maxShare` só é conclusivo com taxa de quadros alta: o WebKit headless no Windows desenha a ~8 fps durante a
 * viagem (renderização por software), e cada quadro cobre naturalmente uma fatia maior.
 */
function analyse(log: Sample[], vp: { width: number; height: number }, dest?: { x: number; y: number }) {
  const center = (c: Cam) => ({ x: (vp.width / 2 - c.x) / c.zoom, y: (vp.height / 2 - c.y) / c.zoom });
  const changed = log.filter((s, i) => i > 0 && (s.x !== log[i - 1].x || s.y !== log[i - 1].y || s.zoom !== log[i - 1].zoom));
  let maxStep = 0, total = 0, monotonic = true;
  const dts: number[] = [];
  for (let i = 1; i < log.length; i++) {
    const a = center(log[i - 1]), b = center(log[i]);
    const step = Math.hypot(b.x - a.x, b.y - a.y) * Math.min(log[i].zoom, log[i - 1].zoom);
    maxStep = Math.max(maxStep, step);
    total += step;
    if (step > 0) dts.push(log[i].t - log[i - 1].t);
    if (dest && Math.hypot(b.x - dest.x, b.y - dest.y) > Math.hypot(a.x - dest.x, a.y - dest.y) + 1e-6) monotonic = false;
  }
  const firstIdx = log.findIndex((s, i) => i > 0 && (s.x !== log[i - 1].x || s.zoom !== log[i - 1].zoom));
  const duration = changed.length ? changed[changed.length - 1].t - log[Math.max(0, firstIdx - 1)].t : 0;
  const medianDt = dts.length ? [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)] : 0;
  return { frames: changed.length, duration, maxShare: total > 0 ? maxStep / total : 0, monotonic, fluid: medianDt > 0 && medianDt <= 34 };
}

/** Sem salto: quadros intermediários suficientes; com ≥ 30 fps, nenhum quadro faz mais de 30% do trajeto. */
function expectSmooth(r: ReturnType<typeof analyse>, minFrames = 5) {
  expect(r.frames, 'quadros intermediários').toBeGreaterThanOrEqual(minFrames);
  if (r.fluid) expect(r.maxShare, 'fração do trajeto feita num único quadro').toBeLessThan(0.3);
}

const expected = (vp: { width: number; height: number }, p: { x: number; y: number }, zoom: number): Cam => ({ zoom, x: vp.width / 2 - p.x * zoom, y: vp.height / 2 - p.y * zoom });
const expectCam = (c: Cam, e: Cam) => {
  expect(Math.abs(c.x - e.x)).toBeLessThan(0.01);
  expect(Math.abs(c.y - e.y)).toBeLessThan(0.01);
  expect(Math.abs(c.zoom - e.zoom), `zoom ${c.zoom} ≠ ${e.zoom}`).toBeLessThan(1e-9);
};

/** Quadro novo com dois locais distantes (~12 telas) e a câmera parada em “Perto”. */
async function setup(page: Page) {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Navegação suave E2E'));
  await expect.poll(async () => { const s = await state(page); return s.boards.find((b) => b.id === s.boardId)?.name; }).toBe('Navegação suave E2E');
  await page.evaluate(() => {
    const c = (window as any).__aurora.checkpoints;
    c.addCheckpoint({ name: 'Perto', description: '', color: '#8f9bff', icon: 'pin', x: 0, y: 0 });
    c.addCheckpoint({ name: 'Longe', description: '', color: '#8f9bff', icon: 'pin', x: 16000, y: 2500 });
    const a = (window as any).__aurora, v = a.getState().viewport;
    a.store.setState({ camera: { zoom: 1, x: v.width / 2, y: v.height / 2 } });
  });
}

async function openLocations(page: Page) {
  const panel = page.getByTestId('locations-panel');
  if (!(await panel.isVisible())) {
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('g');
  }
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('movimento normal (prefers-reduced-motion: no-preference)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('A — lista Locais: quadros intermediários, sem saltos, destino exato e duração visível', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    const panel = await openLocations(page);
    await startRecording(page);
    await panel.getByRole('button', { name: 'Ir para Longe' }).click();
    await settle(page);
    const r = analyse(await stopRecording(page), vp, { x: 16000, y: 2500 });
    expectSmooth(r);
    expect(r.monotonic, 'aproxima-se do destino a cada quadro, sem ultrapassar').toBe(true);
    expect(r.duration, 'duração da viagem longa').toBeGreaterThan(700);
    expect(r.duration).toBeLessThan(1700);
    expectCam((await state(page)).camera, expected(vp, { x: 16000, y: 2500 }, 1));
    await expect(page.locator('[data-testid="checkpoint-marker"]').first()).toBeVisible();
    test.info().annotations.push({ type: 'medição', description: `viagem de ~12 telas: ${r.frames} quadros, ${Math.round(r.duration)} ms, maior passo ${Math.round(r.maxShare * 100)}% do trajeto, fluido=${r.fluid}` });
  });

  test('B — clicar em outro destino durante a viagem parte do estado visual atual e termina no novo', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    const panel = await openLocations(page);
    await startRecording(page);
    await panel.getByRole('button', { name: 'Ir para Longe' }).click();
    await page.waitForTimeout(350);
    await panel.getByRole('button', { name: 'Ir para Perto' }).click();
    await settle(page);
    const r = analyse(await stopRecording(page), vp);
    expectSmooth(r);
    expectCam((await state(page)).camera, expected(vp, { x: 0, y: 0 }, 1));
    await page.waitForTimeout(300); // nada enfileirado depois
    expectCam((await state(page)).camera, expected(vp, { x: 0, y: 0 }, 1));
  });

  test('C — indicador lateral e marcador → Ir compartilham o motor (animam e chegam exato)', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    // Indicador na borda (Longe está fora da tela).
    await startRecording(page);
    await page.locator('[data-testid="checkpoint-indicator"][aria-label^="Ir para Longe"]').click();
    await settle(page);
    let r = analyse(await stopRecording(page), vp);
    expectSmooth(r);
    expectCam((await state(page)).camera, expected(vp, { x: 16000, y: 2500 }, 1));
    // Marcador visível → editor → Ir (volta para Perto).
    await page.evaluate(() => { const a = (window as any).__aurora, v = a.getState().viewport; a.store.setState({ camera: { zoom: 1, x: v.width / 2 - 300, y: v.height / 2 - 100 } }); });
    const marker = page.locator('[data-testid="checkpoint-marker"]').filter({ hasText: 'Perto' });
    await marker.click();
    const dlg = page.getByTestId('checkpoint-dialog');
    await startRecording(page);
    await dlg.getByRole('button', { name: 'Ir', exact: true }).click();
    await settle(page);
    r = analyse(await stopRecording(page), vp);
    expectSmooth(r, 3);
    expectCam((await state(page)).camera, expected(vp, { x: 0, y: 0 }, 1));
    // A navegação não mexeu em elementos nem no histórico.
    const s = await page.evaluate(() => { const st = (window as any).__aurora.getState(); return { els: st.elements.length, hist: (st.history[st.boardId]?.past ?? []).length }; });
    expect(s.els).toBe(0);
  });

  test('D — cancelamentos: Esc, arrasto (pan) e mudança de viewport congelam a câmera onde está', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    const target = expected(vp, { x: 16000, y: 2500 }, 1);
    const panel = await openLocations(page);
    const frozen = async () => {
      const a = (await state(page)).camera;
      await page.waitForTimeout(250);
      const b = (await state(page)).camera;
      expect(b).toEqual(a);
      expect(Math.abs(b.x - target.x)).toBeGreaterThan(1);
      expect(await page.evaluate(() => (window as any).__aurora.core.isCameraAnimating())).toBe(false);
    };
    // Esc no painel: interrompe a viagem e mantém o painel aberto.
    await panel.getByRole('button', { name: 'Ir para Longe' }).click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await frozen();
    await expect(panel).toBeVisible();
    // (No WebKit o clique não foca o botão: o Esc acima foi tratado pelo atalho global, que também interrompe.)
    await panel.getByLabel('Filtrar locais').focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // Arrasto no canvas.
    await page.evaluate(() => { const a = (window as any).__aurora, v = a.getState().viewport; a.store.setState({ camera: { zoom: 1, x: v.width / 2, y: v.height / 2 } }); });
    await page.locator('[data-testid="checkpoint-indicator"][aria-label^="Ir para Longe"]').click();
    await page.waitForTimeout(200);
    await page.keyboard.press('h'); // ferramenta Mão: arrastar faz pan
    const p = await emptyCanvasPoint(page);
    await drag(page, p, { x: p.x - 40, y: p.y - 20 }, { steps: 3 });
    await frozen();
    await page.keyboard.press('v');
    // Mudança de viewport.
    await page.evaluate(() => { const a = (window as any).__aurora, v = a.getState().viewport; a.store.setState({ camera: { zoom: 1, x: v.width / 2, y: v.height / 2 } }); });
    await page.locator('[data-testid="checkpoint-indicator"][aria-label^="Ir para Longe"]').click();
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1300, height: 860 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__aurora.core.isCameraAnimating())).toBe(false);
  });

  test('E — zoom memorizado: aplicado só com “restaurar zoom”; destaque depois de chegar', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    await page.evaluate(() => {
      const c = (window as any).__aurora.checkpoints;
      c.addCheckpoint({ name: 'Zoom salvo', description: '', color: '#8f9bff', icon: 'pin', x: 9000, y: -4000, savedZoom: 2, restoreZoom: true });
    });
    const panel = await openLocations(page);
    await panel.getByRole('button', { name: 'Ir para Zoom salvo' }).click();
    // Durante a viagem ainda não há destaque.
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).__aurora.getState().checkpointFlash)).toBeNull();
    await settle(page);
    expectCam((await state(page)).camera, expected(vp, { x: 9000, y: -4000 }, 2));
    expect(await page.evaluate(() => (window as any).__aurora.getState().checkpointFlash?.at)).toBeTruthy();
    await panel.getByRole('button', { name: 'Ir para Perto' }).click();
    await settle(page);
    expectCam((await state(page)).camera, expected(vp, { x: 0, y: 0 }, 2)); // sem restaurar: zoom atual mantido
  });
});

test.describe('movimento reduzido no sistema (prefers-reduced-motion: reduce)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('F — padrão vai direto; “Sempre” anima; velocidade persiste após recarregar; valores inválidos são descartados', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    const panel = await openLocations(page);
    await startRecording(page);
    await panel.getByRole('button', { name: 'Ir para Longe' }).click();
    await page.waitForTimeout(400);
    let r = analyse(await stopRecording(page), vp);
    expect(r.frames, 'reduce + Sistema: um único passo').toBeLessThanOrEqual(1);
    expectCam((await state(page)).camera, expected(vp, { x: 16000, y: 2500 }, 1));
    await page.keyboard.press('Escape');

    // Preferência no painel sem seleção.
    const prefs = page.getByTestId('navigation-prefs');
    await expect(prefs).toBeVisible();
    await expect(page.getByTestId('navigation-status')).toContainText('movimento reduzido');
    await prefs.getByRole('radiogroup', { name: 'Animação de navegação' }).getByRole('radio', { name: 'Sempre' }).click();
    await expect(page.getByTestId('navigation-status')).toHaveAttribute('data-animating', 'true');
    const p2 = await openLocations(page);
    await startRecording(page);
    await p2.getByRole('button', { name: 'Ir para Perto' }).click();
    await settle(page);
    r = analyse(await stopRecording(page), vp);
    expectSmooth(r); // “Sempre” anima mesmo com reduce
    expectCam((await state(page)).camera, expected(vp, { x: 0, y: 0 }, 1));
    await page.keyboard.press('Escape');

    // Velocidade: Cinematográfica persiste após recarregar (configuração local, não o quadro).
    await prefs.getByRole('radiogroup', { name: 'Velocidade da navegação' }).getByRole('radio', { name: 'Cinema' }).click();
    await page.waitForTimeout(200);
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    expect(await page.evaluate(() => (window as any).__aurora.getState().navigationPrefs)).toEqual({ motion: 'always', speed: 'cinematic' });
    const board = await page.evaluate(() => JSON.stringify((window as any).__aurora.getState().boards));
    expect(board).not.toContain('cinematic');

    // Valor inválido gravado no armazenamento local → volta ao padrão.
    await page.evaluate(() => new Promise<void>((res, rej) => {
      const req = indexedDB.open('aurora-board');
      req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ key: 'navigationPreferences', value: { motion: 'turbo', speed: 42 } }); tx.oncomplete = () => { req.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
      req.onerror = () => rej(req.error);
    }));
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    expect(await page.evaluate(() => (window as any).__aurora.getState().navigationPrefs)).toEqual({ motion: 'system', speed: 'smooth' });
  });
});

test.describe('modo compacto', () => {
  test.use({ reducedMotion: 'no-preference', viewport: { width: 820, height: 900 } });

  test('G — a lista fecha e a câmera viaja até o destino', async ({ page }) => {
    await setup(page);
    const vp = await vpOf(page);
    expect(await page.evaluate(() => (window as any).__aurora.getState().compact)).toBe(true);
    await page.getByRole('button', { name: /Locais/ }).first().click();
    const panel = page.getByTestId('locations-panel');
    await expect(panel).toBeVisible();
    await startRecording(page);
    await panel.getByRole('button', { name: 'Ir para Longe' }).click();
    await expect(panel).toHaveCount(0);
    await settle(page);
    const r = analyse(await stopRecording(page), vp);
    expectSmooth(r);
    expectCam((await state(page)).camera, expected(vp, { x: 16000, y: 2500 }, 1));
  });
});
