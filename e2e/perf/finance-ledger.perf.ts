/**
 * Benchmark do razão financeiro (ciclo F1). Build de produção com ganchos de teste, Chromium, IndexedDB real.
 * Para N movimentações sintéticas (fictícias): leitura do CSV, planejamento/deduplicação, gravação atômica,
 * reimportação (tudo duplicado), consulta do canvas, resumo do período, abertura da interface, reatividade
 * do filtro, recálculo do fluxo de dados com uma consulta bancária no quadro e memória.
 *   PERF_SIZES=100,1000,10000,50000 npx playwright test -c playwright.perf.config.ts e2e/perf/finance-ledger.perf.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { expect, test } from '@playwright/test';

const SIZES = (process.env.PERF_SIZES ?? '100,1000,10000,50000').split(',').map(Number);

test('razão financeiro: importação, deduplicação, consulta e interface', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  const results: Record<string, unknown>[] = [];
  for (const n of SIZES) {
    const r = await page.evaluate(async (n) => {
      const A = (window as any).__aurora;
      const F = A.finance;
      await F.ensureFinanceLoaded();
      await F.wipeFinanceData();
      const acc = await F.createAccount({ institutionName: 'Banco Sintético', name: 'Conta sintética', type: 'checking', openingBalance: { cents: 0, date: '2020-01-01' } });
      const descs = ['MERCADO FICTICIO', 'UBER VIAGEM', 'IFOOD PEDIDO', 'FARMACIA FICTICIA', 'PIX RECEBIDO', 'NETFLIX.COM', 'POSTO FICTICIO', 'PADARIA'];
      const lines = ['Data;Descrição;Valor;Documento'];
      for (let i = 0; i < n; i++) {
        const day = (i % 28) + 1, month = ((Math.floor(i / 28)) % 12) + 1, year = 2021 + Math.floor(i / 336) % 5;
        const v = i % 9 === 0 ? `${1000 + (i % 400)},${String(i % 100).padStart(2, '0')}` : `-${(i % 500) + 1},${String(i % 100).padStart(2, '0')}`;
        lines.push(`${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year};${descs[i % descs.length]} ${i};${v};D${i}`);
      }
      const csv = lines.join('\n');
      const t = () => performance.now();
      let t0 = t();
      const parsed = F.lib.parseCsvStatement(csv);
      const parseMs = t() - t0;
      t0 = t();
      const plan = F.prepareImport(acc.id, parsed);
      const planMs = t() - t0;
      t0 = t();
      await F.commitImportPlan(plan, { origin: 'csv', fileName: 'sintetico.csv' });
      const commitMs = t() - t0;
      t0 = t();
      const replan = F.prepareImport(acc.id, parsed);
      const dedupeMs = t() - t0;
      const s = F.getFinance();
      t0 = t();
      const q = F.lib.sanitizeBankQuery({ ledgerId: s.ledgerId, metric: 'expense', period: '2022-06' }, '2022-06');
      const qr = F.lib.runBankQuery(s, q);
      const queryMs = t() - t0;
      t0 = t();
      F.lib.summarizeFlows(s.transactions, s.accounts, {});
      const summaryMs = t() - t0;
      // Quadro com uma consulta bancária: recálculo do fluxo após mudança no razão.
      await A.actions.createBoard(`perf-razao-${n}`);
      A.actions.addWidget('aurora.bank-query', { x: 0, y: 0 }, { metric: 'expense', period: '2022-06', ledgerId: s.ledgerId }, { title: 'Despesas' });
      const tx = s.transactions[0];
      t0 = t();
      await F.classifyTransaction(tx.id, { category: 'Lazer' });
      A.core.getDataflow(A.getState().elements);
      const reactMs = t() - t0;
      const heap = (performance as any).memory?.usedJSHeapSize ?? 0;
      return { n, imported: F.getFinance().transactions.length, dupOnReimport: replan.totals.duplicateCount, parseMs, planMs, commitMs, dedupeMs, queryMs, summaryMs, reactMs, queryTx: qr.txs.length, heapMB: Math.round(heap / 1048576) };
    }, n);
    // Interface: abrir “Minhas contas” e filtrar transações.
    let t0 = Date.now();
    await page.getByTestId('open-finance').click();
    await expect(page.getByTestId('finance-overview')).toBeVisible({ timeout: 120_000 });
    const openMs = Date.now() - t0;
    await page.getByTestId('finance-tab-transactions').click();
    await expect(page.getByTestId('tx-count')).toBeVisible({ timeout: 120_000 });
    t0 = Date.now();
    await page.getByLabel('Buscar').fill('NETFLIX');
    await expect(page.getByTestId('tx-count')).not.toContainText(`${r.imported} movimenta`, { timeout: 60_000 });
    const filterMs = Date.now() - t0;
    await page.getByRole('button', { name: 'Fechar Minhas contas' }).click();
    results.push({ ...r, openMs, filterMs });
    console.log(JSON.stringify(results.at(-1)));
  }
  await page.evaluate(async () => { await (window as any).__aurora.finance.wipeFinanceData(); });
  mkdirSync('perf-results', { recursive: true });
  writeFileSync(`perf-results/${process.env.PERF_LABEL ?? 'financas-razao'}.json`, JSON.stringify({ at: new Date().toISOString(), cpu: os.cpus()[0]?.model, results }, null, 2));
  console.table(results);
});
