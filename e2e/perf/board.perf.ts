/**
 * Benchmark reproduzível do editor (ver docs/PERFORMANCE.md).
 * Para cada tamanho, cria um quadro com composição fixa (semente determinística), grava no IndexedDB
 * e mede operações reais (eventos de ponteiro no canvas → controlador → React → pintura).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test, type Page } from '@playwright/test';

const SIZES = (process.env.PERF_SIZES ?? '100,500,1000,2000,5000').split(',').map(Number);
const LABEL = process.env.PERF_LABEL ?? 'baseline';
/** random = pior caso (setas longas cruzando o quadro); near = realista (entre formas vizinhas). */
const ARROWS = process.env.PERF_ARROWS === 'near' ? 'near' : 'random';

interface Stats { median: number; p95: number; max: number }
const stats = (xs: number[]): Stats => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

/** Cria e grava o quadro de teste dentro da página (usa as fábricas reais do app). */
async function buildBoard(page: Page, n: number) {
  return page.evaluate(async ({ n, arrows }) => {
    const A = (window as any).__aurora;
    const E = A.elements;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    await A.actions.createBoard(`perf-${n}`);
    const asset = await A.actions.putAsset(new Blob([new Uint8Array(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGRgYAAAhAQX/7xHnBQAAAABJRU5ErkJggg==').split('').map((c) => c.charCodeAt(0)))], { type: 'image/png' }), 'p.png');
    const cols = Math.ceil(Math.sqrt(n));
    const shapes: any[] = [], els: any[] = [];
    const pos = (i: number) => ({ x: (i % cols) * 180, y: Math.floor(i / cols) * 130 });
    const nShapes = Math.round(n * 0.6), nText = Math.round(n * 0.12), nArrows = Math.round(n * 0.15), nWidgets = Math.max(1, Math.round(n * 0.03)), nImages = Math.max(1, Math.round(n * 0.02));
    let i = 0;
    for (let k = 0; k < nShapes; k++, i++) {
      const p = pos(i);
      const s = E.createShape(['rectangle', 'ellipse', 'diamond'][k % 3], p.x, p.y, 140, 90, { backgroundColor: k % 2 ? '#24436a' : 'transparent', roughness: k % 4 === 0 ? 0 : 1 });
      if (rnd() < 0.3) s.text = `Item ${k}`;
      shapes.push(s); els.push(s);
    }
    for (let k = 0; k < nText; k++, i++) { const p = pos(i); els.push(E.createText(p.x, p.y, `Texto ${k}\nsegunda linha`)); }
    for (let k = 0; k < nWidgets; k++, i++) {
      const p = pos(i);
      const types = ['aurora.notes', 'aurora.tasks', 'aurora.finance'];
      const data = [{ markdown: '# Nota\n- item', mode: 'preview' }, { items: [{ id: 'a', text: 'tarefa', status: 'todo', priority: 'medium', dueDate: '' }] }, { entries: [{ id: 'e', description: 'x', amountCents: 1000, kind: 'income', category: 'c', date: '', paid: true, installments: 1, installmentMode: 'split' }] }][k % 3];
      els.push(E.createWidget(types[k % 3], '1.0.0', `W${k}`, p.x, p.y, 160, 120, data));
    }
    for (let k = 0; k < nImages; k++, i++) { const p = pos(i); els.push(E.createImage(p.x, p.y, 120, 80, asset)); }
    for (let k = 0; k < nArrows && shapes.length > 1; k++) {
      const ai = Math.floor(rnd() * (shapes.length - 3));
      const a = arrows === 'near' ? shapes[ai] : shapes[Math.floor(rnd() * shapes.length)];
      const b = arrows === 'near' ? shapes[ai + 1 + Math.floor(rnd() * 2)] : shapes[Math.floor(rnd() * shapes.length)];
      if (a === b) continue;
      const ar = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
      ar.startBinding = { elementId: a.id, fixedPoint: null };
      ar.endBinding = { elementId: b.id, fixedPoint: null };
      els.push(ar);
    }
    // grupos: pares de formas vizinhas
    for (let k = 0; k + 1 < shapes.length && k < n * 0.1; k += 2) { const g = 'g_perf_' + k; shapes[k].groupIds = [g]; shapes[k + 1].groupIds = [g]; }
    const resolved = A.core.updateBoundArrows(els);
    A.actions.addElements(resolved, false);
    await A.actions.flushSave?.();
    return { count: A.getState().elements.length, boardId: A.getState().boardId };
  }, { n, arrows: ARROWS });
}

/** Tempo de trabalho até o próximo quadro pintado. */
const frame = (page: Page) => page.evaluate(() => new Promise<number>((r) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t))); }));

/** O retângulo do canvas é lido uma vez por cenário (ler a cada passo forçaria layout e distorceria a medição). */
async function cacheRect(page: Page) {
  await page.evaluate(() => { (window as any).__rect = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect(); });
}

async function pointer(page: Page, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  await page.evaluate(({ type, x, y, extra }) => {
    const c = document.querySelector('[data-testid="canvas"]')!;
    const r = (window as any).__rect;
    c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra }));
  }, { type, x, y, extra });
}

/** Mede N passos de uma interação: cada passo dispara o evento e espera o quadro seguinte. */
/**
 * Mede N passos de uma interação.
 * - frame: do evento até o 2º requestAnimationFrame (inclui pintura; piso ≈ 2 quadros ≈ 33 ms a 60 Hz)
 * - work: trabalho síncrono de JS + React disparado pelo passo (medido dentro da página, sem pintura)
 */
async function measureSteps(page: Page, steps: number, step: (i: number) => Promise<void>) {
  const frames: number[] = [], works: number[] = [];
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => { (window as any).__workStart = performance.now(); });
    await step(i);
    works.push(await page.evaluate(() => new Promise<number>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now() - (window as any).__workStart - ((window as any).__rt ?? 0)); c.port2.postMessage(0); })));
    const t0 = await page.evaluate(() => performance.now());
    await frame(page);
    frames.push((await page.evaluate(() => performance.now())) - t0 + works[works.length - 1]);
  }
  return { frame: stats(frames), work: stats(works) };
}

const screenOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const s = (window as any).__aurora.getState();
    const e = s.elements.find((x: any) => x.id === id);
    return { x: e.x * s.camera.zoom + s.camera.x, y: e.y * s.camera.zoom + s.camera.y, w: e.width * s.camera.zoom, h: e.height * s.camera.zoom };
  }, id);

test('benchmark de quadros grandes', async ({ page, browser }) => {
  const results: Record<string, unknown>[] = [];
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  for (const n of SIZES) {
    const { count, boardId } = await buildBoard(page, n);
    // abrir: troca para outro quadro e volta (leitura do IndexedDB + validação + renderização)
    const other = await page.evaluate(() => (window as any).__aurora.getState().boards.find((b: any) => !b.name.startsWith('perf-')).id);
    await page.evaluate((id) => (window as any).__aurora.actions.openBoard(id), other);
    const openMs = await page.evaluate(async (id) => {
      const t = performance.now();
      await (window as any).__aurora.actions.openBoard(id);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t;
    }, boardId);

    // visão "tudo visível" (pior caso: sem culling) e visão aproximada (zoom 1)
    for (const view of ['fit', 'zoom1'] as const) {
      await page.evaluate((view) => { const a = (window as any).__aurora.actions; if (view === 'fit') a.zoomToFit(); else { a.zoomToFit(); a.zoomAt(1); } }, view);
      await frame(page);
      await cacheRect(page);
      const visible = await page.evaluate(() => document.querySelectorAll('[data-element-id]').length);
      // alvo: forma preenchida mais próxima do centro
      const target = await page.evaluate(() => {
        const s = (window as any).__aurora.getState();
        const cx = (s.viewport.width / 2 - s.camera.x) / s.camera.zoom, cy = (s.viewport.height / 2 - s.camera.y) / s.camera.zoom;
        let best: any = null, bd = Infinity;
        for (const e of s.elements) if (e.type === 'rectangle' && e.style.backgroundColor !== 'transparent') { const d = Math.hypot(e.x - cx, e.y - cy); if (d < bd) { bd = d; best = e; } }
        return best.id;
      });
      const b = await screenOf(page, target);
      // seleção (clique)
      const select = await measureSteps(page, 10, async () => { await pointer(page, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2); await pointer(page, 'pointerup', b.x + b.w / 2, b.y + b.h / 2); });
      // arrasto do elemento (move + setas ancoradas)
      await pointer(page, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2);
      const drag = await measureSteps(page, 40, (i) => pointer(page, 'pointermove', b.x + b.w / 2 + i * 3, b.y + b.h / 2 + i * 2, { button: -1 }));
      await pointer(page, 'pointerup', b.x + b.w / 2 + 120, b.y + b.h / 2 + 80);
      const b2 = await screenOf(page, target);
      // redimensionar pela alça SE
      const hx = b2.x + b2.w + 5, hy = b2.y + b2.h + 5;
      await pointer(page, 'pointerdown', hx, hy);
      const resize = await measureSteps(page, 30, (i) => pointer(page, 'pointermove', hx + i * 2, hy + i, { button: -1 }));
      await pointer(page, 'pointerup', hx + 60, hy + 30);
      // zoom (Ctrl+roda) e pan
      const zoom = await measureSteps(page, 20, (i) => page.evaluate((i) => {
        const c = document.querySelector('[data-testid="canvas"]')!;
        const r = (window as any).__rect;
        c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + 400, clientY: r.top + 300, deltaY: i % 2 ? 40 : -40, ctrlKey: true, bubbles: true, cancelable: true }));
      }, i));
      const pan = await measureSteps(page, 30, () => page.evaluate(() => (window as any).__aurora.actions.panBy(6, 4)));
      results.push({ n, count, view, visible, openMs: +openMs.toFixed(1), select, drag, resize, zoom, pan });
    }
    // custos isolados: conexões, serialização do diário/autosave, memória
    const costs = await page.evaluate(() => {
      const A = (window as any).__aurora;
      const els = A.getState().elements;
      let t = performance.now();
      for (let i = 0; i < 5; i++) A.core.updateBoundArrows(els);
      const arrowsAll = (performance.now() - t) / 5;
      t = performance.now();
      const json = JSON.stringify({ elements: els });
      const stringify = performance.now() - t;
      t = performance.now();
      structuredClone(els);
      const clone = performance.now() - t;
      (globalThis as any).gc?.();
      const mem = (performance as any).memory?.usedJSHeapSize ?? 0;
      return { arrowsAllMs: +arrowsAll.toFixed(2), journalStringifyMs: +stringify.toFixed(2), journalBytes: json.length, idbCloneMs: +clone.toFixed(2), heapMB: +(mem / 1048576).toFixed(1) };
    });
    results.push({ n, view: 'custos', ...costs });
    console.log(`n=${n}`, JSON.stringify(results.filter((r) => r.n === n)));
  }
  const env = { label: LABEL, date: new Date().toISOString(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), os: `${os.platform()} ${os.release()}`, browser: `chromium ${browser.version()}`, viewport: '1440x900', arrows: ARROWS, build: 'vite build + preview (produção)' };
  mkdirSync('perf-results', { recursive: true });
  writeFileSync(`perf-results/${LABEL}.json`, JSON.stringify({ env, results }, null, 1));
  console.log('ENV', JSON.stringify(env));
});
