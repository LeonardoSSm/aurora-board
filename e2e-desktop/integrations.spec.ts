/**
 * D1-B — integrações do Aurora Board Desktop pelo IPC tipado (sem servidor HTTP): IA, HTML Network Bridge,
 * Meu Pluggy e pré-visualização de links rodam no processo principal com o mesmo serviço da web.
 * Sem chaves reais: as variáveis de IA/Pluggy são zeradas no ambiente do app de teste.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const NO_KEYS = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '', PLUGGY_ITEM_IDS: '' };
const profiles: string[] = [];
function profile() {
  const p = mkdtempSync(join(tmpdir(), 'aurora-desktop-ipc-'));
  profiles.push(p);
  return p;
}
test.afterAll(() => { for (const p of profiles) try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows pode segurar arquivos */ } });

const call = (page: Page, id: string, op: unknown, body?: unknown) => page.evaluate(([i, o, b]) => (window as any).auroraDesktop.api.call(i, o, b), [id, op, body] as const);

test('IPC tipado: operações da allowlist respondem; o resto é recusado pelo processo principal', async () => {
  const s = await launch(profile(), NO_KEYS);
  const { page } = s;
  try {
    expect(Object.keys(await page.evaluate(() => (window as any).auroraDesktop)).sort()).toEqual(['api', 'isDesktop', 'lifecycle', 'platform', 'secrets']);
    expect(await page.evaluate(() => Object.isFrozen((window as any).auroraDesktop.api))).toBe(true);
    expect(await call(page, 'h1', { op: 'health' })).toEqual({ status: 200, body: { ok: true } });
    const prov = await call(page, 'p1', { op: 'ai.providers' });
    expect(prov.status).toBe(200);
    expect(prov.body.providers.map((p: { id: string; configured: boolean }) => [p.id, p.configured])).toEqual([['openai', false], ['anthropic', false], ['gemini', false]]);
    const chat = await call(page, 'c1', { op: 'ai.chat' }, { provider: 'openai', system: 's', messages: [{ role: 'user', content: 'oi' }] });
    expect(chat.status).toBe(400);
    expect(chat.body.error).toMatch(/Configurações do aplicativo/);
    expect(await call(page, 'n1', { op: 'net.status' })).toMatchObject({ status: 200, body: { available: true } });
    expect(await call(page, 'n2', { op: 'net.fetch' }, { url: 'https://127.0.0.1/' })).toMatchObject({ status: 400, body: { ok: false, error: { code: 'blocked_url' } } });
    expect(await call(page, 'n3', { op: 'net.fetch' }, { url: 'https://api.github.com/', headers: { cookie: 'x' } })).toMatchObject({ status: 400, body: { error: { code: 'headers_not_allowed' } } });
    expect(await call(page, 'g1', { op: 'pluggy.status' })).toMatchObject({ status: 200, body: { configured: false } });
    expect(await call(page, 'g2', { op: 'pluggy.accounts', itemId: 'x' })).toMatchObject({ status: 503, body: { code: 'not_configured' } });
    // Fora da allowlist / malformado.
    for (const [op, status] of [[{ op: 'pairing.code' }, 404], [{ op: 'net.other' }, 404], [{ op: 'pluggy.other' }, 404], [{ op: 'shell.exec', cmd: 'calc' }, 404], ['ai.providers', 404], [{ op: 'health', extra: 1 }, 400], [{ op: 'pluggy.accounts', itemId: 'x'.repeat(101) }, 400]] as const) {
      expect((await call(page, 'x' + Math.random().toString(36).slice(2, 8), op)).status, JSON.stringify(op)).toBe(status);
    }
    expect((await call(page, 'id inválido!', { op: 'health' })).status).toBe(400);
    expect((await call(page, 'b1', { op: 'health' }, { inesperado: true })).status).toBe(400);
    expect((await call(page, 'b2', { op: 'linkPreview' }, { url: 'x'.repeat(2 * 1024 * 1024 + 10) })).status).toBe(413);
    // Pareamento LAN não existe no desktop (sem porta aberta).
    await expect(page.getByRole('button', { name: /Parear outro computador/ })).toHaveCount(0);
  } finally {
    await s.close();
  }
});

test('widget HTML → aurora.request() → IPC → processo principal → DNS real (domínio inexistente) → erro estruturado', async () => {
  const s = await launch(profile(), NO_KEYS);
  const { page } = s;
  try {
    await page.locator('[data-library-item="aurora.sandbox-html"]').click();
    await page.getByRole('button', { name: 'Editar HTML' }).click();
    await page.locator('[data-type="widget"] textarea').fill(`<div id="r">-</div><button id="go">ir</button><script>
      document.getElementById('go').onclick = async () => {
        try { await aurora.request({ url: 'https://aurora-d1-ipc-teste-q7k2m9.com.br/x' }); document.getElementById('r').textContent = 'ok'; }
        catch (e) { document.getElementById('r').textContent = e.code + '|' + aurora.network.available; }
      };</script>`);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    const f = page.frameLocator('iframe[sandbox]').first();
    await expect(f.locator('#go')).toBeVisible();
    await expect(f.locator('#r')).toHaveText('-');
    // Sai da edição/seleção antes de usar o iframe e repete o clique até a confirmação aparecer (no Windows da
    // CI o primeiro clique às vezes chegava antes do iframe aceitar eventos). Cliques extras viram UMA confirmação.
    await page.keyboard.press('Escape');
    await expect(async () => {
      await f.locator('#go').click();
      await expect(page.getByRole('dialog').getByTestId('net-consent-origin')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('net-consent-origin')).toHaveText('https://aurora-d1-ipc-teste-q7k2m9.com.br');
    await dlg.getByRole('button', { name: 'Permitir uma vez' }).click();
    // O pedido chegou ao processo principal: o servidor-de-rede resolveu o DNS e devolveu erro estruturado.
    await expect(f.locator('#r')).toHaveText(/^(dns_error|network_error)\|true$/, { timeout: 20_000 });
  } finally {
    await s.close();
  }
});
