/**
 * Benchmark da navegação espacial (ver docs/SPATIAL_NAVIGATION.md → Desempenho).
 * Para cada tamanho de quadro e quantidade de checkpoints: custo da camada de indicadores por quadro
 * de câmera, viagem entre extremos (quadros, maior intervalo), zoom contínuo pela roda e pan durante
 * a animação. Build de produção, movimento NÃO reduzido.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });
const ELEMENTS = (process.env.PERF_ELEMENTS ?? '100,1000,5000').split(',').map(Number);
const CHECKPOINTS = (process.env.PERF_CHECKPOINTS ?? '0,10,50,100').split(',').map(Number);

test('navegação espacial: indicadores, viagem e zoom', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  const results: Record<string, unknown>[] = [];
  for (const n of ELEMENTS) {
    for (const k of CHECKPOINTS) {
      const r = await page.evaluate(async ({ n, k }) => {
        const A = (window as any).__aurora;
        const E = A.elements;
        await A.actions.createBoard(`perf-nav-${n}-${k}`);
        const cols = Math.ceil(Math.sqrt(n));
        const els: any[] = [];
        for (let i = 0; i < n; i++) els.push(E.createShape(['rectangle', 'ellipse', 'diamond'][i % 3], (i % cols) * 220, Math.floor(i / cols) * 160, 140, 90));
        A.actions.addElements(els, false);
        const span = cols * 220;
        for (let i = 0; i < k; i++) {
          const ang = (i / Math.max(1, k)) * Math.PI * 2;
          A.checkpoints.addCheckpoint({ name: `Local ${i + 1}`, x: span / 2 + Math.cos(ang) * span * 3, y: span / 2 + Math.sin(ang) * span * 3 });
        }
        const frame = () => new Promise<number>((res) => requestAnimationFrame((t) => res(t)));
        const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
        const vp = A.getState().viewport;
        // 1) Pan quadro a quadro (camada de indicadores reposiciona a cada câmera): tempo até pintar.
        A.store.setState({ camera: { x: vp.width / 2, y: vp.height / 2, zoom: 1 } });
        await frame(); await frame();
        const pan: number[] = [];
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now();
          const c = A.getState().camera;
          A.actions.panBy(-37, -11);
          void c;
          await frame();
          pan.push(performance.now() - t0);
        }
        const layer = document.querySelector('[data-testid="checkpoint-layer"]');
        const indicators = layer ? layer.querySelectorAll('[data-testid="checkpoint-indicator"]').length : 0;
        // 2) Viagem entre extremos: quadros e maior intervalo entre quadros.
        A.checkpoints.addCheckpoint({ name: 'Extremo', x: -span * 20, y: -span * 20 });
        const target = A.getState().checkpoints.at(-1).id;
        const times: number[] = [];
        const t0 = performance.now();
        A.checkpoints.navigateToCheckpoint(target);
        while (A.core.isCameraAnimating() && performance.now() - t0 < 3000) times.push(await frame());
        const gaps = times.slice(1).map((t, i) => t - times[i]);
        const cam = A.getState().camera;
        const cp = A.getState().checkpoints.at(-1);
        const exact = Math.abs(cam.x - (vp.width / 2 - cp.x * cam.zoom)) < 0.01 && Math.abs(cam.y - (vp.height / 2 - cp.y * cam.zoom)) < 0.01;
        // 3) Zoom contínuo: 20 eventos de roda reais no canvas, um por quadro.
        const canvas = document.querySelector('[data-testid="canvas"]')!;
        const rect = canvas.getBoundingClientRect();
        const wheel: number[] = [];
        for (let i = 0; i < 20; i++) {
          const s = performance.now();
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: i < 10 ? -100 : 100, deltaMode: 0, clientX: rect.left + 300, clientY: rect.top + 200, bubbles: true, cancelable: true }));
          await frame();
          wheel.push(performance.now() - s);
        }
        while (A.core.isCameraAnimating()) await frame();
        // 4) Pan durante a animação: cancela na hora, sem quadros residuais.
        A.checkpoints.navigateToCheckpoint(A.getState().checkpoints[0]?.id ?? target);
        await frame(); await frame();
        A.actions.panBy(10, 0);
        const afterPan = JSON.stringify(A.getState().camera);
        await frame(); await frame(); await frame();
        const residual = JSON.stringify(A.getState().camera) !== afterPan;
        const mem = (performance as any).memory?.usedJSHeapSize;
        return {
          elements: n, checkpoints: k, indicatorsShown: indicators,
          panStepMs: +median(pan).toFixed(2), panP95Ms: +[...pan].sort((a, b) => a - b)[Math.floor(pan.length * 0.95)].toFixed(2),
          travelFrames: times.length, travelMaxGapMs: +Math.max(0, ...gaps).toFixed(1), travelExact: exact,
          wheelStepMs: +median(wheel).toFixed(2),
          residualFramesAfterPan: residual,
          heapMB: mem ? +(mem / 1048576).toFixed(1) : null,
        };
      }, { n, k });
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
  mkdirSync('perf-results', { recursive: true });
  writeFileSync('perf-results/navegacao-espacial.json', JSON.stringify({ when: new Date().toISOString(), cpu: os.cpus()[0]?.model, results }, null, 2));
});
