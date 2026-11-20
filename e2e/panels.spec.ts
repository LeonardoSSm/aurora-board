/**
 * Issue #10: painéis laterais redimensionáveis e formulário de Propriedades legível (Consulta bancária).
 * Dados FICTÍCIOS apenas. As capturas de documentação são geradas com AURORA_DOC_SHOTS=1.
 */
import { expect, test, type Page } from '@playwright/test';
import { drag, drawShape, ready, state, toPage } from './helpers';

const SHOTS = process.env.AURORA_DOC_SHOTS === '1';

/** Contas fictícias com nomes longos + Consulta bancária selecionada, com IA em modo “Movimentações”. */
async function bankScenario(page: Page) {
  await page.evaluate(async () => {
    const w = window as any;
    const F = w.__aurora.finance;
    await F.ensureFinanceLoaded();
    await F.createAccount({ institutionName: 'Banco Fictício de Investimentos e Pagamentos S.A.', name: 'Conta corrente conjunta com nome bem comprido para testar quebra', type: 'checking' });
    await F.createAccount({ institutionName: 'Banco Fictício Beta', name: 'Cartão de crédito Platinum Internacional Fictício', type: 'credit_card' });
    const el = w.__aurora.actions.addWidget('aurora.bank-query', { x: -200, y: -100 }, { metric: 'expense', period: '2026-11', periodMode: 'range', from: '2026-09-01', to: '2026-11-30', aiShare: { mode: 'detail', includeCategories: true, includeMonths: true, includeAccountNames: true, includeDates: true, includeDescriptions: true, maxItems: 50 } }, { title: 'Despesas do banco' });
    w.__aurora.actions.setSelection([el.id]);
  });
  await expect(page.getByTestId('bank-inspector')).toBeVisible();
}

/** Controles do painel que passam das bordas (corte/rolagem horizontal). */
async function overflowReport(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="properties"]') as HTMLElement;
    const box = panel.getBoundingClientRect();
    const bad: string[] = [];
    panel.querySelectorAll('input, select, button, label, [role="radio"], pre, textarea').forEach((n) => {
      const r = (n as HTMLElement).getBoundingClientRect();
      if (r.width === 0) return;
      if (r.right > box.right + 0.5 || r.left < box.left - 0.5) bad.push(`${n.tagName}:${(n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 30)} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(box.left)}–${Math.round(box.right)})`);
    });
    return { scrollX: panel.scrollWidth - panel.clientWidth, bad };
  });
}

const widths = (page: Page) => page.evaluate(() => ({
  library: Math.round(document.querySelector('[data-testid="library-panel"]')!.getBoundingClientRect().width),
  properties: Math.round(document.querySelector('[data-testid="properties-panel"]')!.getBoundingClientRect().width),
  canvas: Math.round(document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect().width),
}));

async function setWidth(page: Page, side: 'library' | 'properties', width: number) {
  await page.evaluate(async ([s, w]) => { await (window as any).__aurora.actions.setPanelWidth(s, w); }, [side, width] as const);
}

test.describe('Issue #10 — laterais redimensionáveis', () => {
  // Alças e larguras só existem fora do modo compacto (o projeto “mobile” cobre o compacto abaixo).
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 900, 'layout de desktop');

  test('arrastar cada alça muda só a sua lateral, sem selecionar texto, e o canvas acompanha', async ({ page }) => {
    await ready(page);
    const w0 = await widths(page);
    expect(w0).toMatchObject({ library: 256, properties: 288 });
    const right = (await page.getByTestId('resize-properties').boundingBox())!;
    await drag(page, { x: right.x + right.width / 2, y: right.y + 300 }, { x: right.x + right.width / 2 - 120, y: right.y + 320 });
    const w1 = await widths(page);
    expect(w1.properties).toBe(408);
    expect(w1.library).toBe(256);
    expect(w1.canvas).toBe(w0.canvas - 120);
    const left = (await page.getByTestId('resize-library').boundingBox())!;
    await drag(page, { x: left.x + left.width / 2, y: left.y + 300 }, { x: left.x + left.width / 2 + 80, y: left.y + 280 });
    const w2 = await widths(page);
    expect(w2).toMatchObject({ library: 336, properties: 408, canvas: w0.canvas - 200 });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(await page.evaluate(() => document.documentElement.classList.contains('panel-resizing'))).toBe(false);
  });

  test('limites: mínimo, máximo absoluto e canvas mínimo preservado', async ({ page }) => {
    await ready(page);
    const sep = page.getByTestId('resize-properties');
    await sep.focus();
    await page.keyboard.press('Home');
    await expect(sep).toHaveAttribute('aria-valuenow', '220');
    await page.keyboard.press('End');
    const max = Number(await sep.getAttribute('aria-valuemax'));
    await expect(sep).toHaveAttribute('aria-valuenow', String(max));
    // Janela 1440: 1440 − 360 (canvas) − 256 (Biblioteca) = 824 → limitado a 650.
    expect(max).toBe(650);
    await page.setViewportSize({ width: 1100, height: 900 });
    // A interface reage ao evento de redimensionamento da janela: espera o novo layout.
    await expect.poll(async () => (await widths(page)).canvas).toBeGreaterThanOrEqual(360);
    expect((await widths(page)).properties).toBeLessThan(650);
  });

  test('teclado e ARIA: setas, Shift+setas, Enter restaura; foco visível na alça', async ({ page }) => {
    await ready(page);
    const sep = page.getByTestId('resize-properties');
    await expect(sep).toHaveAttribute('role', 'separator');
    await expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    await expect(sep).toHaveAttribute('aria-label', 'Redimensionar Propriedades');
    await sep.focus();
    await page.keyboard.press('ArrowLeft'); // Propriedades cresce para a esquerda
    await expect(sep).toHaveAttribute('aria-valuenow', '304');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(sep).toHaveAttribute('aria-valuenow', '368');
    await page.keyboard.press('ArrowRight');
    await expect(sep).toHaveAttribute('aria-valuenow', '352');
    await page.keyboard.press('Enter');
    await expect(sep).toHaveAttribute('aria-valuenow', '288');
    const lib = page.getByTestId('resize-library');
    await lib.focus();
    await page.keyboard.press('ArrowRight');
    await expect(lib).toHaveAttribute('aria-valuenow', '272');
    await lib.dblclick();
    await expect(lib).toHaveAttribute('aria-valuenow', '256');
  });

  test('larguras persistem ao recarregar; “Largura padrão” restaura; valores inválidos são descartados', async ({ page }) => {
    await ready(page);
    await setWidth(page, 'properties', 500);
    await setWidth(page, 'library', 300);
    await page.reload();
    await ready(page);
    expect(await widths(page)).toMatchObject({ library: 300, properties: 500 });
    await page.getByTestId('reset-properties-width').click();
    await page.getByTestId('reset-library-width').click();
    expect(await widths(page)).toMatchObject({ library: 256, properties: 288 });
    await expect(page.getByTestId('reset-properties-width')).toHaveCount(0);
    // Valor adulterado no armazenamento local.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('aurora-board');
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'panelWidths', value: { library: 1e9, properties: 'x' } });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }));
    await page.reload();
    await ready(page);
    // 1e9 → 650 (máximo absoluto) → limitado pelo canvas mínimo; 'x' → padrão.
    const w = await widths(page);
    expect(w.properties).toBe(288);
    expect(w.library).toBe(650);
    expect(w.canvas).toBeGreaterThanOrEqual(360);
  });

  test('a largura não vai para o quadro nem para o backup', async ({ page }) => {
    await ready(page);
    await setWidth(page, 'properties', 480);
    const backup = await page.evaluate(async () => { const path = '/src/ui/fileActions.tsx'; const m = await import(/* @vite-ignore */ path); return (await m.buildWorkspaceExportText()).text as string; });
    expect(backup).not.toContain('panelWidths');
    expect(backup).not.toMatch(/480/);
  });

  test('canvas: cliques, seleção e coordenadas corretas depois de redimensionar; Locais acompanha a Biblioteca', async ({ page }) => {
    await ready(page);
    await setWidth(page, 'library', 420);
    await setWidth(page, 'properties', 460);
    // Desenha um retângulo pelas coordenadas do mundo (usa a área real do canvas) e confere a geometria.
    await drawShape(page, 'r', -100, -60, 100, 60);
    const rect = (await state(page)).elements.at(-1)!;
    expect([rect.type, Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]).toEqual(['rectangle', -100, -60, 200, 120]);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).__aurora.actions.setSelection([]));
    const edge = await toPage(page, -100, 0);
    await page.mouse.click(edge.x, edge.y);
    expect((await state(page)).selectedIds).toEqual([rect.id]);
    // Locais abre ancorado à direita da Biblioteca (420 + 12).
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('g');
    const box = (await page.getByTestId('locations-panel').boundingBox())!;
    expect(Math.round(box.x)).toBe(432);
  });

  for (const w of [220, 288, 420, 550]) {
    test(`Consulta bancária configurável sem corte em ${w}px`, async ({ page }) => {
      await ready(page);
      await setWidth(page, 'properties', w);
      await bankScenario(page);
      const r = await overflowReport(page);
      expect(r.bad, r.bad.join('\n')).toEqual([]);
      expect(r.scrollX).toBe(0);
      // Os dois campos do intervalo e o máximo de movimentações continuam utilizáveis.
      await page.getByTestId('bank-inspector').getByLabel('Até').fill('2026-10-31');
      await expect(page.getByTestId('bank-inspector').getByLabel('Até')).toHaveValue('2026-10-31');
      await expect(page.getByLabel('Máximo de movimentações')).toBeVisible();
      if (SHOTS) await page.locator('aside[aria-label="Propriedades"]').screenshot({ path: `docs/img/panels-${process.env.AURORA_DOC_TAG ?? 'depois'}-${w}.png` });
    });
  }

});

test('antes/depois: captura de documentação em 288px', async ({ page }) => {
  test.skip(!SHOTS, 'só gera capturas com AURORA_DOC_SHOTS=1');
  await ready(page);
  await bankScenario(page);
  await page.locator('aside[aria-label="Propriedades"]').screenshot({ path: `docs/img/panels-${process.env.AURORA_DOC_TAG ?? 'depois'}-288.png` });
  console.log(JSON.stringify(await overflowReport(page)));
});

test('todos os widgets: painel de Propriedades sem controles cortados na largura mínima (220px)', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 900, 'layout de desktop');
  await ready(page);
  await setWidth(page, 'properties', 220);
  const ids: string[] = await page.evaluate(async () => {
    const path = '/src/widgets/registry.ts';
    const m = await import(/* @vite-ignore */ path);
    return m.listWidgets().filter((w: any) => w.status !== 'planned').map((w: any) => w.id);
  });
  expect(ids.length).toBeGreaterThan(10);
  const problems: string[] = [];
  for (const id of ids) {
    await page.evaluate((t) => { const a = (window as any).__aurora.actions; a.setState?.({ editingWidgetId: null }); const el = a.addWidget(t, { x: 0, y: 0 }); if (el) a.setSelection([el.id]); }, id);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const s = (window as any).__aurora.getState(); if (!s.selectedIds.length) { const last = s.elements.at(-1); (window as any).__aurora.actions.setSelection([last.id]); } });
    const r = await overflowReport(page);
    if (r.bad.length || r.scrollX > 0) problems.push(`${id}: scrollX=${r.scrollX} ${r.bad.join(' | ')}`);
    await page.evaluate(() => (window as any).__aurora.actions.deleteSelected());
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('modo compacto (≤ 899 px): painel sobreposto, sem alça, limitado à janela', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await ready(page);
  await setWidth(page, 'properties', 650);
  await page.getByRole('button', { name: 'Painel de propriedades' }).click();
  const panel = page.getByTestId('properties-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('resize-properties')).toHaveCount(0);
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(820 * 0.85 + 1);
  await expect(page.getByTestId('panel-backdrop')).toBeVisible();
  await page.getByTestId('panel-backdrop').click({ position: { x: 10, y: 300 } });
  await expect(panel).toHaveCount(0);
});
