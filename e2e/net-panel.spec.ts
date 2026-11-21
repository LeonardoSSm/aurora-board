/**
 * H2-C — painel “Acesso à rede”, dados protegidos, exemplo de dashboard público e ciclo de vida, no navegador.
 * Sem rede externa: /api/net/fetch é interceptado (page.route) — o transporte do app, a confirmação, o corretor e o
 * iframe são os reais. Dados sintéticos.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { ready, state } from './helpers';

const REPO = { stargazers_count: 42, forks_count: 7, open_issues_count: 3, description: 'Quadro visual sintético', pushed_at: '2026-11-20T10:00:00Z' };

/** Intercepta /api/net/fetch. `hold` deixa as consultas presas até `release()`. */
async function fakeApi(page: Page, opts: { hold?: boolean } = {}) {
  const seen: { url: string }[] = [];
  const held: Route[] = [];
  await page.route('**/api/net/fetch', async (route) => {
    const body = route.request().postDataJSON() as { url: string };
    seen.push(body);
    if (opts.hold) { held.push(route); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { status: 200, url: body.url, contentType: 'application/json', bytes: 180, responseType: 'json', data: REPO } }) });
  });
  return { seen, held };
}

const PROBE = `<div id="out">-</div><div id="err">-</div><button id="go">Consultar</button>
<script>
  document.getElementById('go').onclick = async () => {
    try {
      const r = await aurora.request({ url: 'https://api.github.com/repos/LeonardoSSm/aurora-board?segredo=NAO-MOSTRAR' });
      document.getElementById('out').textContent = 'ok:' + r.data.stargazers_count;
    } catch (e) { document.getElementById('err').textContent = e.code; }
  };
</script>`;

async function newBoard(page: Page, name: string) {
  await page.evaluate((n) => (window as any).__aurora.actions.createBoard(n), name);
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
}
async function addHtml(page: Page, html: string, title = 'Painel de rede', at = { x: 0, y: 0 }) {
  return page.evaluate(([h, t, p]) => {
    const { actions } = (window as any).__aurora;
    const w = actions.addWidget('aurora.sandbox-html', p, { html: h, state: null }, { title: t });
    actions.setSelection([]);
    return w.id as string;
  }, [html, title, at] as const);
}
const select = (page: Page, id: string) => page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
const frame = (page: Page) => page.frameLocator('iframe[sandbox]').first();
const dialog = (page: Page) => page.getByRole('dialog');

test.describe('H2-C — Acesso à rede', () => {
  test('E: painel mostra estado, destino, método e última consulta (sem caminho/consulta); revogar individual e todos', async ({ page }) => {
    const api = await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Painel de rede E2E');
    const id = await addHtml(page, PROBE);
    await select(page, id);
    const panel = page.getByTestId('net-panel');
    await expect(panel.getByTestId('net-state')).toHaveText('desativado');
    await frame(page).locator('#go').click();
    await expect(panel.getByTestId('net-state')).toHaveText('aguardando autorização');
    await dialog(page).getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(frame(page).locator('#out')).toHaveText('ok:42');
    await expect(panel.getByTestId('net-state')).toHaveText('autorizado');
    const dest = panel.getByTestId('net-destination');
    await expect(dest).toContainText('https://api.github.com');
    await expect(dest).toContainText('GET');
    await expect(dest).toContainText('Sempre neste dispositivo');
    await expect(panel.getByTestId('net-last')).toContainText('200 · api.github.com');
    await expect(panel).not.toContainText('segredo');
    await expect(panel).not.toContainText('/repos/');
    expect(api.seen).toHaveLength(1);

    // Revogar o destino: a próxima consulta pede de novo; negar aparece como bloqueio.
    await panel.getByRole('button', { name: 'Revogar https://api.github.com' }).click();
    await expect(panel.getByTestId('net-state')).toHaveText('desativado');
    await frame(page).locator('#go').click();
    await dialog(page).getByRole('button', { name: 'Negar' }).click();
    await expect(frame(page).locator('#err')).toHaveText('permission_denied');
    await expect(panel.getByTestId('net-blocked')).toContainText('Bloqueadas: 1');
    await expect(panel.getByTestId('net-blocked')).toContainText('permission_denied');
    expect(api.seen).toHaveLength(1);

    // “Uma vez” só vale para esta execução e também é revogável; “Revogar acesso” tira tudo.
    await page.evaluate(() => (window as any).__aurora.actions.setSelection([]));
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    await select(page, id);
    await frame(page).locator('#go').click();
    await dialog(page).getByRole('button', { name: 'Permitir uma vez' }).click();
    await expect(frame(page).locator('#out')).toHaveText('ok:42');
    await expect(page.getByTestId('net-destination')).toContainText('Uma vez (esta execução)');
    await page.getByTestId('net-revoke-all').click();
    await expect(page.getByTestId('net-destinations')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__aurora.getState().htmlNetGrants.length)).toBe(0);
  });

  test('F: dados bancários conectados → confirmação específica lista a fonte; negar bloqueia; painel avisa', async ({ page }) => {
    const api = await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Rede sensível E2E');
    const ids = await page.evaluate((probe) => {
      const { actions, elements: E } = (window as any).__aurora;
      const q = actions.addWidget('aurora.bank-query', { x: -500, y: 0 }, { metric: 'expense', period: '2026-11', periodMode: 'month' }, { title: 'Despesas do banco' });
      const h = actions.addWidget('aurora.sandbox-html', { x: 0, y: 0 }, { html: probe, state: null, bridge: { version: 1, inputs: [{ id: 'gasto', label: 'Gasto', type: 'money' }], outputs: [], ai: { mode: 'none', outputs: [], confirmedDigest: '', confirmedAt: 0 } } }, { title: 'Painel com banco' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: q.id, fixedPoint: null };
      l.endBinding = { elementId: h.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'value', targetPort: 'gasto' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return { q: q.id as string, h: h.id as string };
    }, PROBE);
    await frame(page).locator('#go').click();
    const d = dialog(page);
    await expect(d.getByTestId('net-consent-sensitive')).toContainText('Despesas do banco');
    await expect(d.getByTestId('net-consent-sensitive')).toContainText('dados bancários');
    await expect(d.getByTestId('net-consent-sensitive')).toContainText('diferente da autorização para IA');
    await expect(d.getByTestId('net-consent-inputs')).toContainText('Despesas do banco');
    await d.getByRole('button', { name: 'Negar' }).click();
    await expect(frame(page).locator('#err')).toHaveText('permission_denied');
    expect(api.seen).toHaveLength(0);
    await select(page, ids.h);
    await expect(page.getByTestId('net-sensitive')).toContainText('Despesas do banco');
  });

  test('G: exemplo “Dashboard público” — nada consulta ao abrir; Atualizar consulta, mostra KPIs e publica saída', async ({ page }) => {
    const api = await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Dashboard público E2E');
    const id = await addHtml(page, '<p>vazio</p>', 'Dashboard GitHub');
    await select(page, id);
    await page.getByLabel('Exemplo de HTML').selectOption('net-github');
    await page.getByTestId('bridge-use-example').click();
    await dialog(page).getByRole('button', { name: 'Substituir' }).click();
    const f = frame(page);
    await expect(f.locator('#go')).toBeVisible();
    await page.waitForTimeout(500);
    expect(api.seen, 'nenhuma consulta ao abrir o exemplo').toHaveLength(0);
    await f.locator('#go').click();
    await dialog(page).getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(f.locator('#stars')).toHaveText('42');
    await expect(f.locator('#forks')).toHaveText('7');
    await expect(f.locator('#issues')).toHaveText('3');
    await expect(f.locator('#status')).toContainText('Atualizado');
    expect(api.seen.map((x) => x.url)).toEqual(['https://api.github.com/repos/LeonardoSSm/aurora-board']);
    // Atualizar manualmente de novo, sem nova confirmação.
    await f.locator('#go').click();
    await expect.poll(() => api.seen.length).toBe(2);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('bridge-outputs')).toContainText('publicado');
  });

  test('H: excluir o bloco com a confirmação aberta fecha a janela; consulta pendente não chega a um bloco novo', async ({ page }) => {
    const api = await fakeApi(page, { hold: true });
    await ready(page);
    await newBoard(page, 'Ciclo de vida E2E');
    const id = await addHtml(page, PROBE);
    await frame(page).locator('#go').click();
    await expect(dialog(page)).toBeVisible();
    await page.evaluate((x) => { const { actions } = (window as any).__aurora; actions.setSelection([x]); actions.deleteSelected(); }, id);
    await expect(dialog(page)).toHaveCount(0);
    expect(api.seen).toHaveLength(0);
    // Remontagem: bloco novo, consulta presa no servidor; desfazer/refazer não mistura respostas.
    const id2 = await addHtml(page, PROBE, 'Outro painel');
    await frame(page).locator('#go').click();
    await dialog(page).getByRole('button', { name: 'Permitir uma vez' }).click();
    await expect.poll(() => api.seen.length).toBe(1);
    await page.evaluate((x) => { const { actions } = (window as any).__aurora; actions.setSelection([x]); actions.deleteSelected(); }, id2);
    await api.held[0].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { status: 200, url: 'https://api.github.com/x', contentType: 'application/json', bytes: 2, responseType: 'json', data: { stargazers_count: 1 } } }) }).catch(() => undefined);
    await addHtml(page, PROBE, 'Terceiro');
    await expect(frame(page).locator('#out')).toHaveText('-');
  });

  test('J: estado gravado com dados do banco; fonte excluída bloqueia; “Limpar estado e recarregar” libera', async ({ page }) => {
    const api = await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Estado marcado E2E');
    const SAVER = PROBE.replace('<script>', '<script>aurora.onInputs((i) => aurora.setState({ copia: i.gasto ? 1 : 0 }));');
    const ids = await page.evaluate((probe) => {
      const { actions, elements: E } = (window as any).__aurora;
      const q = actions.addWidget('aurora.bank-query', { x: -500, y: 0 }, { metric: 'expense', period: '2026-11', periodMode: 'month' }, { title: 'Banco' });
      const h = actions.addWidget('aurora.sandbox-html', { x: 0, y: 0 }, { html: probe, state: null, bridge: { version: 1, inputs: [{ id: 'gasto', label: 'Gasto', type: 'money' }], outputs: [], ai: { mode: 'none', outputs: [], confirmedDigest: '', confirmedAt: 0 } } }, { title: 'Guarda estado' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: q.id, fixedPoint: null };
      l.endBinding = { elementId: h.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'value', targetPort: 'gasto' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return { q: q.id as string, h: h.id as string };
    }, SAVER);
    await expect.poll(async () => (await state(page)).elements.find((e) => e.id === ids.h)?.data.stateTaint?.sources).toEqual([ids.q]);
    // Exclui a consulta bancária (e a conexão): a origem dos dados guardados não é mais verificável.
    await page.evaluate((q) => { const { actions } = (window as any).__aurora; actions.setSelection([q]); actions.deleteSelected(); }, ids.q);
    await select(page, ids.h);
    await expect(page.getByTestId('net-state')).toHaveText('bloqueado');
    await frame(page).locator('#go').click();
    await expect(frame(page).locator('#err')).toHaveText('sensitive_blocked');
    await expect(dialog(page)).toHaveCount(0);
    await page.getByTestId('net-clear-state').click();
    await expect.poll(async () => { const d = (await state(page)).elements.find((e) => e.id === ids.h)?.data; return [d?.state, d?.stateTaint]; }).toEqual([{ copia: 0 }, undefined]);
    await expect(page.getByTestId('net-state')).toHaveText('desativado');
    await frame(page).locator('#go').click();
    await expect(dialog(page).getByTestId('net-consent-sensitive')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Permitir uma vez' }).click();
    await expect(frame(page).locator('#out')).toHaveText('ok:42');
    expect(api.seen).toHaveLength(1);
  });

  test('K (Codex PR #33): “Limpar estado” com gravações represadas não restaura dados sem a marca; painel reflete a decisão completa', async ({ page }) => {
    await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Rajada de estado E2E');
    // Grava estado sem parar (50/s > limite de 10/s): sempre há uma gravação represada no limitador do host.
    const FLOOD = PROBE.replace('<script>', '<script>let n = 0, cur = null; const gen = Math.random().toString(36).slice(2); aurora.onInputs((i) => { cur = i.gasto; }); setInterval(() => aurora.setState({ copia: cur ? cur.cents : -1, n: ++n, gen }), 20);');
    const ids = await page.evaluate((probe) => {
      const { actions, elements: E } = (window as any).__aurora;
      const q = actions.addWidget('aurora.bank-query', { x: -500, y: 0 }, { metric: 'expense', period: '2026-11', periodMode: 'month' }, { title: 'Banco' });
      const h = actions.addWidget('aurora.sandbox-html', { x: 0, y: 0 }, { html: probe, state: null, bridge: { version: 1, inputs: [{ id: 'gasto', label: 'Gasto', type: 'money' }], outputs: [], ai: { mode: 'none', outputs: [], confirmedDigest: '', confirmedAt: 0 } } }, { title: 'Rajada' });
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
      l.startBinding = { elementId: q.id, fixedPoint: null };
      l.endBinding = { elementId: h.id, fixedPoint: null };
      l.connection = { ...l.connection, sourcePort: 'value', targetPort: 'gasto' };
      actions.addElements([l], false);
      actions.setSelection([]);
      return { q: q.id as string, h: h.id as string };
    }, FLOOD);
    await expect.poll(async () => (await state(page)).elements.find((e) => e.id === ids.h)?.data.stateTaint?.sources).toEqual([ids.q]);
    // Registra qualquer instante, depois de limpar, em que reapareça um estado gravado pela execução ANTERIOR
    // (gravação represada no limitador) ou um estado com conteúdo sem a marca de dados protegidos.
    await page.evaluate((h) => {
      const w = window as any;
      w.__violations = [];
      w.__oldGen = w.__aurora.getState().elements.find((e: any) => e.id === h)?.data.state?.gen;
      w.__armed = false;
      w.__aurora.store.subscribe((s: any) => {
        if (!w.__armed) return;
        const d = s.elements.find((e: any) => e.id === h)?.data;
        if (d?.state?.gen === w.__oldGen) w.__violations.push('estado antigo restaurado');
        if (d?.state && !d.stateTaint) w.__violations.push('sem marca');
      });
    }, ids.h);
    expect(await page.evaluate(() => typeof (window as any).__oldGen)).toBe('string');
    await select(page, ids.h);
    await page.getByTestId('net-clear-state').evaluate((b) => { (window as any).__armed = true; (b as HTMLButtonElement).click(); });
    await page.waitForTimeout(1600);
    expect(await page.evaluate(() => [...new Set((window as any).__violations)])).toEqual([]);

    // Painel: “sempre” concedido com o banco; mudar a consulta bancária invalida só a específica → não “autorizado”.
    await frame(page).locator('#go').click();
    await expect(dialog(page).getByTestId('net-consent-sensitive')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(frame(page).locator('#out')).toHaveText('ok:42');
    await expect(page.getByTestId('net-state')).toHaveText('autorizado');
    await page.evaluate((q) => (window as any).__aurora.actions.updateWidgetData(q, (d: any) => ({ ...d, metric: 'income' })), ids.q);
    await expect(page.getByTestId('net-state')).not.toHaveText('autorizado');
    await expect(page.getByTestId('net-stale')).toBeVisible();
  });

  test('I: painel “Acesso à rede” cabe em 220 px', async ({ page }) => {
    await fakeApi(page);
    await ready(page);
    await newBoard(page, 'Painel estreito E2E');
    const id = await addHtml(page, PROBE);
    await frame(page).locator('#go').click();
    await dialog(page).getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(frame(page).locator('#out')).toHaveText('ok:42');
    await select(page, id);
    await page.evaluate(async () => { await (window as any).__aurora.actions.setPanelWidth('properties', 220); });
    await expect(page.getByTestId('net-destination')).toBeVisible();
    const bad = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="net-panel"]') as HTMLElement;
      const box = (document.querySelector('[data-testid="properties"]') as HTMLElement).getBoundingClientRect();
      return [...panel.querySelectorAll('button, li, span, div')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map((n) => n.outerHTML.slice(0, 80));
    });
    expect(bad).toEqual([]);
  });
});
