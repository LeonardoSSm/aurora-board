/**
 * Benchmark das finanças visuais (ver docs/VISUAL_FINANCE.md → Desempenho).
 * Para N valores: N/10 meses (10 valores cada), uma fórmula por mês encadeada na anterior
 * (acumulado = saldo do mês + acumulado anterior) e um gráfico com todos os meses.
 * Mede: recálculo completo (frio), recálculo incremental após mudar 1 valor, tempo até pintar
 * a mudança, arrasto de um mês e memória (Chromium).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from '@playwright/test';

const SIZES = (process.env.PERF_SIZES ?? '100,500,1000').split(',').map(Number);

test('finanças visuais: recálculo e renderização', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  const results: Record<string, unknown>[] = [];
  for (const n of SIZES) {
    const r = await page.evaluate(async (n) => {
      const A = (window as any).__aurora;
      const E = A.elements;
      await A.actions.createBoard(`perf-financas-${n}`);
      const months = Math.max(1, Math.round(n / 10));
      const els: any[] = [];
      const link = (a: any, b: any, conn: Record<string, string>) => {
        const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0 }, 'data');
        l.startBinding = { elementId: a.id, fixedPoint: null };
        l.endBinding = { elementId: b.id, fixedPoint: null };
        l.connection = { ...l.connection, ...conn };
        return l;
      };
      const values: any[] = [];
      let prevFormula: any = null;
      const chart = E.createWidget('aurora.chart', '1.0.0', 'Saldos', -600, 0, 380, 300, { mode: 'sources', chartType: 'line' });
      els.push(chart);
      for (let m = 0; m < months; m++) {
        const y = 2027 + Math.floor(m / 12), mm = String((m % 12) + 1).padStart(2, '0');
        const mx = (m % 10) * 700, my = Math.floor(m / 10) * 1200;
        const month = E.createWidget('aurora.finance-period', '1.0.0', `M${m}`, mx + 220, my, 220, 150, { period: `${y}-${mm}`, currency: 'BRL' });
        els.push(month);
        for (let k = 0; k < 10; k++) {
          const v = E.createWidget('aurora.value', '1.0.0', `v${m}_${k}`, mx, my + k * 90, 176, 76, { valueType: 'money', currency: 'BRL', amountCents: 10000 + k * 137, financialRole: k === 0 ? 'income' : 'expense' });
          values.push(v);
          els.push(v, link(v, month, { sourcePort: 'value', targetPort: 'entries', variable: `v${k}` }));
        }
        const f = E.createWidget('aurora.formula', '1.0.0', `Acum ${m}`, mx + 220, my + 200, 210, 96, { expression: prevFormula ? '=saldo + anterior' : '=saldo' });
        els.push(f, link(month, f, { sourcePort: 'balance', targetPort: 'in', variable: 'saldo' }), link(month, chart, { sourcePort: 'summary', targetPort: 'series', variable: `m${m}` }));
        if (prevFormula) els.push(link(prevFormula, f, { sourcePort: 'result', targetPort: 'in', variable: 'anterior' }));
        prevFormula = f;
      }
      A.actions.addElements(els, false);
      A.actions.zoomToFit();
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frames();
      const elements = A.getState().elements;
      const spec = A.core.dataflowSpec;
      // Recálculo completo (sem reaproveitamento), 5 execuções.
      const cold: number[] = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); A.core.computeDataflow(elements, spec); cold.push(performance.now() - t); }
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      // Mudança de 1 valor: recálculo incremental e tempo até pintar.
      const incr: number[] = [], commitMs: number[] = [], paint: number[] = [];
      const target = values[Math.floor(values.length / 2)];
      // Recálculo incremental puro: mesmo grafo, 1 valor alterado, reaproveitando o resultado anterior.
      const base = A.core.computeDataflow(elements, spec);
      for (let i = 0; i < 10; i++) {
        const changed = elements.map((e: any) => (e.id === target.id ? { ...e, data: { ...e.data, amountCents: 30000 + i } } : e));
        const t = performance.now();
        A.core.computeDataflow(changed, spec, base);
        incr.push(performance.now() - t);
      }
      // No app: commit (histórico + seletores, que já recalculam o fluxo) e tempo até a mudança ser pintada.
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        A.actions.updateElements(new Set([target.id]), (e: any) => ({ ...e, data: { ...e.data, amountCents: 20000 + i } }));
        commitMs.push(performance.now() - t0);
        await frames();
        paint.push(performance.now() - t0);
      }
      // Resultado final correto (última fórmula acumula todos os meses).
      const flow = A.core.getDataflow(A.getState().elements);
      const last = flow.outputs.get(prevFormula.id)?.result;
      // Arrasto: mover um mês (setas ancoradas acompanham), 10 passos.
      const drag: number[] = [];
      const monthEl = els.find((e) => e.widgetType === 'aurora.finance-period');
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        A.actions.updateElements(new Set([monthEl.id]), (e: any) => ({ ...e, x: e.x + 5 }));
        await frames();
        drag.push(performance.now() - t);
      }
      const mem = (performance as any).memory?.usedJSHeapSize;
      return {
        values: n, months, formulas: months, edges: els.filter((e) => e.type === 'arrow').length, elements: A.getState().elements.length,
        coldRecomputeMs: +median(cold).toFixed(2),
        incrementalRecomputeMs: +median(incr).toFixed(2),
        commitWithRecomputeMs: +median(commitMs).toFixed(2),
        changeToPaintMs: +median(paint).toFixed(2),
        dragStepMs: +median(drag).toFixed(2),
        heapMB: mem ? +(mem / 1048576).toFixed(1) : null,
        lastFormulaCents: last?.cents ?? null,
      };
    }, n);
    results.push(r);
    console.log(JSON.stringify(r));
  }
  mkdirSync('perf-results', { recursive: true });
  writeFileSync('perf-results/financas-visuais.json', JSON.stringify({ when: new Date().toISOString(), cpu: os.cpus()[0]?.model, results }, null, 2));
});
