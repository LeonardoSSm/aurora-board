/**
 * H2 — HTML Network Bridge no navegador real: aurora.request() no iframe isolado, confirmação, negação,
 * isolamento (fetch direto continua bloqueado), mensagens forjadas. Sem rede externa: o transporte é simulado
 * pela página (window.__aurora.net.setTransport) ou pela rota /api/net/fetch interceptada.
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state } from './helpers';

const PROBE = `<div id="out">-</div><div id="err">-</div><div id="direct">-</div><div id="net">-</div><div id="hdr">-</div>
<button id="go">Consultar</button>
<script>
  document.getElementById('net').textContent = String(aurora.network.available);
  const go = async () => {
    try {
      const r = await aurora.request({ url: 'https://api.exemplo.com.br/repos/x', responseType: 'json' });
      document.getElementById('out').textContent = 'stars:' + r.data.stargazers_count + ':' + r.status;
    } catch (e) {
      document.getElementById('err').textContent = e.name + ':' + e.code;
    }
  };
  document.getElementById('go').onclick = go;
  // fetch direto continua bloqueado pela CSP do documento isolado.
  fetch('https://api.exemplo.com.br/direto').then(() => { document.getElementById('direct').textContent = 'VAZOU'; }, (e) => { document.getElementById('direct').textContent = 'bloqueado'; });
  aurora.request({ url: 'https://api.exemplo.com.br/h', headers: { Authorization: 'x' } }).catch((e) => { document.getElementById('hdr').textContent = e.code; });
</script>`;

async function setup(page: Page, transport: 'ok' | 'none' = 'ok') {
  await ready(page);
  await page.evaluate(() => (window as any).__aurora.actions.createBoard('Rede HTML E2E'));
  await expect.poll(async () => (await state(page)).elements.length).toBe(0);
  if (transport === 'ok') {
    await page.evaluate(() => {
      const w = window as any;
      w.__netCalls = [];
      w.__aurora.net.setTransport(async (req: { url: string }) => {
        w.__netCalls.push(req.url);
        return { ok: true, result: { status: 200, url: req.url, contentType: 'application/json', bytes: 30, responseType: 'json', data: { stargazers_count: 7 } } };
      });
    });
  }
  return page.evaluate((probe) => {
    const { actions } = (window as any).__aurora;
    const h = actions.addWidget('aurora.sandbox-html', { x: 0, y: 0 }, { html: probe, state: null }, { title: 'Painel de rede' });
    actions.setSelection([]);
    return h.id as string;
  }, PROBE);
}

const frame = (page: Page) => page.frameLocator('iframe[sandbox]').first();
const calls = (page: Page) => page.evaluate(() => ((window as any).__netCalls ?? []).length as number);

test.describe('H2 — HTML Network Bridge', () => {
  test('A: confirmação contextual → “Permitir sempre” → HTML atualiza; segunda consulta sem nova pergunta', async ({ page }) => {
    const id = await setup(page);
    const f = frame(page);
    await expect(f.locator('#net')).toHaveText('true');
    await expect(f.locator('#direct')).toHaveText('bloqueado');
    await expect(f.locator('#hdr')).toHaveText('headers_not_allowed');
    await f.locator('#go').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('net-consent-widget')).toHaveText('Painel de rede');
    await expect(dlg.getByTestId('net-consent-origin')).toHaveText('https://api.exemplo.com.br');
    await expect(dlg).toContainText('GET');
    await dlg.getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(f.locator('#out')).toHaveText('stars:7:200');
    expect(await calls(page)).toBe(1);
    const grants = await page.evaluate(() => (window as any).__aurora.getState().htmlNetGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ elementId: id, origin: 'https://api.exemplo.com.br', method: 'GET', kind: 'network' });
    await f.locator('#out').evaluate((el) => { el.textContent = '-'; });
    await f.locator('#go').click();
    await expect(f.locator('#out')).toHaveText('stars:7:200');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await calls(page)).toBe(2);
    // A autorização não vai para o quadro (nem para o backup).
    const s = await state(page);
    expect(JSON.stringify(s.elements)).not.toContain('htmlNetGrants');
    expect(JSON.stringify(s.elements)).not.toContain(grants[0].key);
  });

  test('B: negar → erro estruturado no HTML, nada consultado; build sem transporte → indisponível', async ({ page }) => {
    await setup(page);
    const f = frame(page);
    await f.locator('#go').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Negar' }).click();
    await expect(f.locator('#err')).toHaveText('AuroraRequestError:permission_denied');
    expect(await calls(page)).toBe(0);
    // Sem transporte: indisponível, sem janela de confirmação.
    await page.evaluate(() => (window as any).__aurora.net.setTransport(null));
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    const g = frame(page);
    await expect(g.locator('#net')).toHaveText('false');
    await g.locator('#go').click();
    await expect(g.locator('#err')).toHaveText('AuroraRequestError:unavailable');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('C: mensagens forjadas fora do iframe (ou com token falso) são ignoradas', async ({ page }) => {
    await setup(page);
    await frame(page).locator('#net').waitFor();
    await page.evaluate(() => {
      window.postMessage({ type: 'aurora:request', token: 'x', id: 'f1', url: 'https://api.exemplo.com.br/forjado' }, '*');
    });
    // O próprio iframe tentando com um token inventado.
    await frame(page).locator('body').evaluate(() => parent.postMessage({ type: 'aurora:request', token: 'inventado', id: 'f2', url: 'https://api.exemplo.com.br/forjado' }, '*'));
    await page.waitForTimeout(400);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await calls(page)).toBe(0);
  });
});
