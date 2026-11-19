import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drag, expectNear, ready, state, toPage, waitSaved, type El } from './helpers';

const center = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
const byTitle = async (page: Page, title: string) => (await state(page)).elements.find((e) => e.title === title)!;
const tileValue = (page: Page, title: string, testid = 'period-tile') =>
  page.locator(`[data-testid="${testid}"][aria-label^="${title}:"]`);

async function moveTo(page: Page, title: string, slot: { x: number; y: number }) {
  const e = await byTitle(page, title);
  await drag(page, await toPage(page, center(e).x, center(e).y), await toPage(page, slot.x, slot.y));
}

/** Insere um valor pela biblioteca, digita valor e nome no próprio bloco e posiciona. */
async function addValue(page: Page, kind: 'income' | 'expense', name: string, amount: string, slot: { x: number; y: number }) {
  await page.locator(`[data-library-item="aurora.value#${kind}"]`).click();
  const editor = page.getByTestId('inline-editor');
  await expect(editor.getByLabel('Valor', { exact: true })).toBeFocused();
  await editor.getByLabel('Valor', { exact: true }).fill(amount);
  await editor.getByLabel('Nome do valor').fill(name);
  await editor.getByLabel('Valor', { exact: true }).press('Enter');
  await expect(editor).toHaveCount(0);
  await moveTo(page, name, slot);
}

/** Conexão de dados com a ferramenta Conectar (tipo Dados), do centro da origem ao centro do destino. */
async function connect(page: Page, from: string, to: string) {
  const a = await byTitle(page, from), b = await byTitle(page, to);
  await page.keyboard.press('c');
  await page.getByRole('radio', { name: 'Dados' }).click();
  await drag(page, await toPage(page, center(a).x, center(a).y), await toPage(page, center(b).x, center(b).y), { steps: 12 });
  await page.keyboard.press('Escape');
  const arrow = (await state(page)).elements.find((e) => e.type === 'arrow' && e.startBinding?.elementId === a.id && e.endBinding?.elementId === b.id);
  expect(arrow, `conexão ${from} → ${to}`).toBeTruthy();
  return arrow!;
}

test('Finanças visuais: valores → meses → fórmula e gráfico, reativo, persistente e exportável', async ({ page }) => {
  await ready(page);
  // 1. quadro vazio (novo)
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Finanças E2E'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);

  // 2. Janeiro 2027 pela biblioteca + painel (duplo clique)
  await page.locator('[data-library-item="aurora.finance-period#current"]').click();
  let m = (await state(page)).elements[0];
  const mp = await toPage(page, center(m).x, center(m).y);
  await page.mouse.dblclick(mp.x, mp.y);
  const inspector = page.getByTestId('period-inspector');
  await inspector.getByLabel('Mês', { exact: true }).selectOption('01');
  await inspector.getByLabel('Ano', { exact: true }).fill('2027');
  await expect.poll(async () => (await state(page)).elements[0].title).toBe('Janeiro 2027');
  await moveTo(page, 'Janeiro 2027', { x: 0, y: -170 });

  // 3–5. salário e despesa digitados no bloco, conectados a janeiro
  await addValue(page, 'income', 'Salário', '3.000', { x: -320, y: -230 });
  await addValue(page, 'expense', 'Aluguel', '1.200', { x: -320, y: -110 });
  await connect(page, 'Salário', 'Janeiro 2027');
  await connect(page, 'Aluguel', 'Janeiro 2027');

  // 6. saldo R$ 1.800,00 (comprometido 40%)
  await expect(tileValue(page, 'Janeiro 2027')).toHaveAttribute('data-value', /1\.800,00/);

  // 7–8. alterar a despesa para R$ 1.500 no próprio bloco → saldo R$ 1.500
  const al = await byTitle(page, 'Aluguel');
  const ap = await toPage(page, center(al).x, center(al).y);
  await page.mouse.dblclick(ap.x, ap.y);
  await page.getByTestId('inline-editor').getByLabel('Valor', { exact: true }).fill('1500');
  await page.getByTestId('inline-editor').getByLabel('Valor', { exact: true }).press('Enter');
  await expect(tileValue(page, 'Janeiro 2027')).toHaveAttribute('data-value', /1\.500,00/);

  // 9–10. Fevereiro pelo menu (“Criar mês seguinte”) com valores diferentes
  const jan = await byTitle(page, 'Janeiro 2027');
  const jp = await toPage(page, center(jan).x, center(jan).y);
  await page.mouse.click(jp.x, jp.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Criar mês seguinte' }).click();
  await expect.poll(async () => !!(await byTitle(page, 'Fevereiro 2027'))).toBe(true);
  await page.keyboard.press('Escape');
  await addValue(page, 'income', 'Freela', '3.200', { x: -320, y: 40 });
  await addValue(page, 'expense', 'Mercado', '600', { x: -320, y: 160 });
  await connect(page, 'Freela', 'Fevereiro 2027');
  await connect(page, 'Mercado', 'Fevereiro 2027');
  await expect(tileValue(page, 'Fevereiro 2027')).toHaveAttribute('data-value', /2\.600,00/);

  // 11. gráfico comparando os saldos dos meses
  await page.locator('[data-library-item="aurora.chart"]').click();
  await moveTo(page, 'Gráfico', { x: 260, y: 170 });
  await connect(page, 'Janeiro 2027', 'Gráfico');
  await connect(page, 'Fevereiro 2027', 'Gráfico');
  const chart = page.locator('[data-widget-root]').filter({ has: page.getByTestId('widget-title').getByText('Gráfico', { exact: true }) });
  await chart.getByRole('radio', { name: 'Saldos' }).click();
  await expect(chart.locator('[data-series="Jan 2027"]')).toContainText('1,5');
  await expect(chart.locator('[data-series="Fev 2027"]')).toContainText('2,6');

  // 12–13. fórmula somando os saldos (nomes lógicos vindos das conexões)
  await page.locator('[data-library-item="aurora.formula#blank"]').click();
  await page.getByTestId('inline-editor').getByLabel('Fórmula', { exact: true }).press('Escape');
  await moveTo(page, 'Fórmula', { x: -30, y: 200 });
  await connect(page, 'Janeiro 2027', 'Fórmula');
  await connect(page, 'Fevereiro 2027', 'Fórmula');
  const f = await byTitle(page, 'Fórmula');
  const fp = await toPage(page, center(f).x, center(f).y);
  await page.mouse.dblclick(fp.x, fp.y);
  await page.getByTestId('inline-editor').getByLabel('Fórmula', { exact: true }).fill('=SOMA(saldo_janeiro_2027, saldo_fevereiro_2027)');
  await page.getByTestId('inline-editor').getByLabel('Fórmula', { exact: true }).press('Enter');
  await expect(tileValue(page, 'Fórmula', 'formula-tile')).toHaveAttribute('data-value', /4\.100,00/);
  // Nenhuma conexão inválida.
  const statuses = await page.evaluate(() => [...(window as any).__aurora.core.getDataflow((window as any).__aurora.getState().elements).edges.values()].map((e: any) => e.status));
  expect(statuses.every((s: string) => s === 'ok')).toBe(true);

  // 14–15. recarregar e conferir
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  await expect(tileValue(page, 'Janeiro 2027')).toHaveAttribute('data-value', /1\.500,00/);
  await expect(tileValue(page, 'Fevereiro 2027')).toHaveAttribute('data-value', /2\.600,00/);
  await expect(tileValue(page, 'Fórmula', 'formula-tile')).toHaveAttribute('data-value', /4\.100,00/);

  // 16–17. duplicar a estrutura inteira: as cópias se ligam às cópias
  const before = (await state(page)).elements.length;
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await state(page)).elements.length).toBe(before * 2);
  const dup: { cents: number; sources: string[] }[] = await page.evaluate(() => {
    const a = (window as any).__aurora;
    const els = a.getState().elements;
    const flow = a.core.getDataflow(els);
    const formulas = els.filter((e: any) => e.widgetType === 'aurora.formula');
    return formulas.map((f: any) => {
      const sources = els.filter((e: any) => e.type === 'arrow' && e.endBinding?.elementId === f.id).map((e: any) => e.startBinding.elementId);
      return { cents: flow.outputs.get(f.id)?.result?.cents, sources };
    });
  });
  expect(dup.map((d) => d.cents)).toEqual([410000, 410000]);
  expect(dup[0].sources.some((s) => dup[1].sources.includes(s))).toBe(false); // cópia não aponta para os originais

  // 18. desfazer/refazer a duplicação
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).elements.length).toBe(before);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await state(page)).elements.length).toBe(before * 2);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).elements.length).toBe(before);

  // 22–23. SVG com resultados legíveis
  await page.getByRole('button', { name: /Exportar/ }).click();
  const svgDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Vetor do quadro/ }).click();
  const svg = readFileSync((await (await svgDl).path())!, 'utf8');
  for (const t of ['Janeiro 2027', 'Fevereiro 2027', 'Fórmula', 'Salário', 'Aluguel']) expect(svg).toContain(t);
  expect(svg).toMatch(/R\$(\s|&nbsp;| )1\.500,00/);
  expect(svg).toMatch(/R\$(\s|&nbsp;| )4\.100,00/);
  expect(await page.evaluate((t) => !new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror'), svg)).toBe(true);

  // 21. PNG
  await page.getByRole('button', { name: /Exportar/ }).click();
  const pngDl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Imagem do quadro/ }).click();
  const png = readFileSync((await (await pngDl).path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.length).toBeGreaterThan(20_000);

  // 19–20. JSON → importar como novo quadro: mesmos resultados
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
  expect((await state(page)).boards.filter((b) => b.name === 'Finanças E2E')).toHaveLength(2);
  await expect(tileValue(page, 'Fórmula', 'formula-tile')).toHaveAttribute('data-value', /4\.100,00/);
  await expect(tileValue(page, 'Janeiro 2027')).toHaveAttribute('data-value', /1\.500,00/);
  await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
  await page.screenshot({ path: test.info().outputPath('financas-visuais.png') });
});

test('valor: edição rápida não ativa atalhos; texto vira valor só por ação explícita', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Valores E2E'));
  await page.locator('[data-library-item="aurora.value#money"]').click();
  const editor = page.getByTestId('inline-editor');
  // "r", "o", "t" seriam atalhos de ferramenta fora do campo.
  await editor.getByLabel('Nome do valor').fill('');
  await editor.getByLabel('Nome do valor').pressSequentially('Reserva total');
  await editor.getByLabel('Valor', { exact: true }).fill('abc');
  await editor.getByLabel('Valor', { exact: true }).press('Enter');
  await expect(editor.getByRole('alert')).toContainText('Valor inválido');
  await editor.getByLabel('Valor', { exact: true }).fill('2.500,75');
  await editor.getByLabel('Valor', { exact: true }).press('Enter');
  const s = await state(page);
  expect(s.tool).toBe('select');
  const v = s.elements[0];
  expect([v.title, v.data.amountCents]).toEqual(['Reserva total', 250075]);
  // Esc cancela sem alterar
  const p = await toPage(page, center(v).x, center(v).y);
  await page.mouse.dblclick(p.x, p.y);
  await editor.getByLabel('Valor', { exact: true }).fill('9');
  await editor.getByLabel('Valor', { exact: true }).press('Escape');
  expect((await state(page)).elements[0].data.amountCents).toBe(250075);

  // Texto com número continua texto até o usuário pedir a conversão.
  await page.keyboard.press('t');
  const tp = await toPage(page, -200, 200);
  await page.mouse.click(tp.x, tp.y);
  await page.keyboard.type('Aluguel 1.500');
  await page.keyboard.press('Escape');
  let t = (await state(page)).elements.find((e) => e.type === 'text')!;
  expect(t.text).toBe('Aluguel 1.500');
  const tc = await toPage(page, t.x + 5, t.y + t.height / 2);
  await page.mouse.click(tc.x, tc.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Converter em valor' }).click();
  t = (await state(page)).elements.find((e) => e.id === t.id)!;
  expect([t.type, t.widgetType, t.title, t.data.amountCents]).toEqual(['widget', 'aurora.value', 'Aluguel', 150000]);
  expectNear(t, { x: t.x }, 0);
});
