/**
 * Benchmark do ciclo 6: navegação (pan + zoom) com N GIFs animados visíveis.
 * Build de produção com ganchos, Chromium, movimento NÃO reduzido (GIFs animando).
 *   PERF_GIFS=0,25,100 npx playwright test -c playwright.perf.config.ts e2e/perf/gifs.perf.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from '@playwright/test';
import { loopingGif, toBase64 } from '../../tests/fixtures/gifEncoder';

const COUNTS = (process.env.PERF_GIFS ?? '0,25,100').split(',').map(Number);
test.use({ reducedMotion: 'no-preference' });

test('GIFs animados: pan e zoom', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  const gifs = Array.from({ length: 8 }, (_, i) => toBase64(loopingGif(0, 96 + i * 16)));
  const results: Record<string, unknown>[] = [];
  for (const n of COUNTS) {
    const r = await page.evaluate(async ({ n, gifs }) => {
      const A = (window as any).__aurora;
      await A.actions.createBoard(`perf-gifs-${n}`);
      const files: File[] = [];
      for (let i = 0; i < n; i++) {
        const bin = atob(gifs[i % gifs.length]);
        const u = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
        files.push(new File([u], `g${i}.gif`, { type: 'image/gif' }));
      }
      if (files.length) await A.actions.insertImageFiles(files, { x: 0, y: 0 });
      // Espalha numa grade que cabe na tela (todos visíveis e animando).
      const ids = A.getState().elements.map((e: any) => e.id);
      const cols = Math.ceil(Math.sqrt(Math.max(1, n)));
      A.actions.updateElements(new Set(ids), (e: any) => { const i = ids.indexOf(e.id); return { ...e, x: (i % cols) * 110, y: Math.floor(i / cols) * 110, width: 96, height: 96 }; });
      A.actions.setSelection([]);
      A.actions.zoomToFit?.();
      await new Promise((r) => setTimeout(r, 1000));
      const frame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));
      const times: number[] = [];
      let last = await frame();
      for (let i = 0; i < 120; i++) {
        const c = A.getState().camera;
        A.store.setState({ camera: { ...c, x: c.x + (i % 40 < 20 ? 6 : -6), zoom: c.zoom * (i % 60 < 30 ? 1.004 : 0.996) } });
        const t = await frame();
        times.push(t - last);
        last = t;
      }
      times.sort((a, b) => a - b);
      const avg = times.reduce((s, x) => s + x, 0) / times.length;
      return { gifs: n, frameAvgMs: +avg.toFixed(1), frameP95Ms: +times[Math.floor(times.length * 0.95)].toFixed(1), heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576) };
    }, { n, gifs });
    results.push(r);
    console.log(JSON.stringify(r));
  }
  mkdirSync('perf-results', { recursive: true });
  writeFileSync(`perf-results/${process.env.PERF_LABEL ?? 'gifs-animados'}.json`, JSON.stringify({ at: new Date().toISOString(), cpu: os.cpus()[0]?.model, results }, null, 2));
  console.table(results);
});
