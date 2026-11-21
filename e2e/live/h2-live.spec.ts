/**
 * Homologação REAL do H2 (HTML Network Bridge) — exige internet; fora da CI (`npm run test:live`).
 *
 * Nada é simulado: sobe o Vite e o servidor local de verdade (portas próprias), usa um perfil de navegador
 * PERSISTENTE, consulta a API pública do GitHub e o httpbin.org pelo caminho completo
 * (iframe → host → /api/net/fetch → servidor → internet), e reinicia navegador + servidores no meio para
 * provar a persistência das autorizações. O teste compara a resposta com uma consulta independente do Node.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB = 5193, API = 8807;
const BASE = `http://localhost:${WEB}`;
const GH = 'https://api.github.com/repos/LeonardoSSm/aurora-board';
const PROBE = `<div id="out">-</div><div id="err">-</div><div id="direct">-</div><div id="fast">-</div><div id="slow">-</div>
<button id="go">GitHub</button><button id="f">httpbin</button><button id="s">lento</button><button id="c">cancelar</button><button id="t">tempo</button>
<script>
  const $ = (i) => document.getElementById(i);
  fetch('https://api.github.com/zen').then(() => { $('direct').textContent = 'VAZOU'; }, () => { $('direct').textContent = 'bloqueado'; });
  $('go').onclick = async () => {
    $('out').textContent = '…'; $('err').textContent = '-';
    try {
      const r = await aurora.request({ url: '${GH}' });
      $('out').textContent = r.status + '|' + r.data.full_name + '|' + r.data.stargazers_count + '|' + r.contentType;
    } catch (e) { $('err').textContent = e.code; $('out').textContent = '-'; }
  };
  $('f').onclick = async () => {
    try { const r = await aurora.request({ url: 'https://httpbin.org/get?h2=live' }); $('fast').textContent = r.status + '|' + r.data.args.h2 + '|' + (r.data.headers['User-Agent'] || ''); }
    catch (e) { $('fast').textContent = 'erro:' + e.code; }
  };
  let ctrl = null;
  $('s').onclick = async () => {
    ctrl = new AbortController(); $('slow').textContent = 'esperando';
    try { await aurora.request({ url: 'https://httpbin.org/delay/8', timeoutMs: 15000, signal: ctrl.signal }); $('slow').textContent = 'terminou'; }
    catch (e) { $('slow').textContent = 'erro:' + e.code; }
  };
  $('c').onclick = () => ctrl && ctrl.abort();
  $('t').onclick = async () => {
    $('slow').textContent = 'esperando';
    try { await aurora.request({ url: 'https://httpbin.org/delay/8', timeoutMs: 2000 }); $('slow').textContent = 'terminou'; }
    catch (e) { $('slow').textContent = 'erro:' + e.code; }
  };
</script>`;

const procs: ChildProcess[] = [];
function startServers() {
  const env = { ...process.env, AURORA_API_PORT: String(API) };
  const opts = { cwd: process.cwd(), env, shell: true, stdio: 'ignore' as const, detached: process.platform !== 'win32' };
  procs.push(spawn(`npx vite --port ${WEB} --strictPort`, opts));
  procs.push(spawn('npx tsx server/index.ts', opts)); // sem --env-file: nenhuma chave de IA do usuário
}
function stopServers() {
  for (const p of procs.splice(0)) {
    if (!p.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else try { process.kill(-p.pid, 'SIGTERM'); } catch { /* já saiu */ }
  }
}
async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const [w, a] = await Promise.all([fetch(BASE), fetch(`http://127.0.0.1:${API}/api/net/status`)]);
      if (w.ok && a.ok) return;
    } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('servidores não subiram');
}
async function waitDown() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${API}/api/net/status`); } catch { return; }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const evidence: Record<string, unknown> = {};
const netLog: { url: string; status: number; ok?: boolean; data?: string }[] = [];
function watch(page: Page) {
  page.on('response', async (r) => {
    if (!r.url().includes('/api/net/fetch')) return;
    let body: { ok?: boolean; result?: { status: number; data?: { full_name?: string } }; error?: { code: string } } = {};
    try { body = await r.json(); } catch { /* sem corpo */ }
    netLog.push({ url: r.url(), status: r.status(), ok: body.ok, data: body.result?.data?.full_name ?? body.error?.code });
  });
  page.on('requestfailed', (r) => { if (r.url().includes('/api/net/fetch')) netLog.push({ url: r.url(), status: 0, data: `falhou:${r.failure()?.errorText}` }); });
}
const frame = (page: Page) => page.frameLocator('iframe[sandbox]').first();

test.setTimeout(240_000);
test('H2 ao vivo: GitHub real, autorização por domínio, revogação, cancelamento, tempo, persistência após reinício', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'aurora-h2-live-'));
  let ctx: BrowserContext | null = null;
  try {
    startServers();
    await waitUp();
    ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    watch(page);
    await page.goto(BASE);
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready', undefined, { timeout: 60_000 });
    const id = await page.evaluate(async (html) => {
      const { actions } = (window as any).__aurora;
      await actions.createBoard('Homologação H2 ao vivo');
      const w = actions.addWidget('aurora.sandbox-html', { x: 0, y: 0 }, { html, state: null }, { title: 'GitHub ao vivo' });
      actions.setSelection([]);
      return w.id as string;
    }, PROBE);
    const f = frame(page);

    // 9. fetch direto no iframe continua bloqueado (CSP do sandbox), mesmo com internet disponível.
    await expect(f.locator('#direct')).toHaveText('bloqueado');

    // 3–5. Consulta real ao GitHub com confirmação por domínio.
    await f.locator('#go').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('net-consent-origin')).toHaveText('https://api.github.com');
    await expect(dlg.getByTestId('net-consent-widget')).toHaveText('GitHub ao vivo');
    await dlg.getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(f.locator('#out')).toHaveText(/^200\|LeonardoSSm\/aurora-board\|\d+\|application\/json$/, { timeout: 20_000 });
    const shown = (await f.locator('#out').innerText()).split('|');
    const direct = await (await fetch(GH, { headers: { 'user-agent': 'aurora-h2-live-check' } })).json() as { stargazers_count: number; full_name: string };
    expect(Number(shown[2])).toBe(direct.stargazers_count);
    evidence.github = { widget: shown.join('|'), node: `${direct.full_name}|${direct.stargazers_count}` };

    // Outro domínio exige outra autorização (escopo por origem).
    await f.locator('#f').click();
    await expect(dlg.getByTestId('net-consent-origin')).toHaveText('https://httpbin.org');
    await dlg.getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
    await expect(f.locator('#fast')).toHaveText(/^200\|live\|AuroraBoard-NetBridge\/1/, { timeout: 20_000 });
    evidence.httpbin = await f.locator('#fast').innerText();

    // 8. Cancelamento real (httpbin /delay/8) e tempo esgotado real.
    await f.locator('#s').click();
    await expect(f.locator('#slow')).toHaveText('esperando');
    await page.waitForTimeout(1500);
    await f.locator('#c').click();
    await expect(f.locator('#slow')).toHaveText('erro:aborted');
    await f.locator('#t').click();
    await expect(f.locator('#slow')).toHaveText('erro:timeout', { timeout: 15_000 });
    evidence.cancel = netLog.filter((x) => x.url.includes('/api/net/fetch')).slice(-2);

    // 6. Revogar o GitHub pelo painel → nova consulta pede de novo; negar → bloqueada e nada enviado.
    await page.evaluate((x) => (window as any).__aurora.actions.setSelection([x]), id);
    await page.getByTestId('net-panel').getByRole('button', { name: 'Revogar https://api.github.com' }).click();
    const before = netLog.length;
    await f.locator('#go').click();
    await dlg.getByRole('button', { name: 'Negar' }).click();
    await expect(f.locator('#err')).toHaveText('permission_denied');
    await page.waitForTimeout(500);
    expect(netLog.length).toBe(before);
    evidence.revoked = await f.locator('#err').innerText();
    await expect(page.getByTestId('net-last')).not.toContainText('repos');

    // 7. Reinício completo: fecha o navegador, derruba e sobe Vite + servidor, reabre o MESMO perfil.
    await ctx.close();
    ctx = null;
    stopServers();
    await waitDown();
    startServers();
    await waitUp();
    ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    watch(page);
    await page.goto(BASE);
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready', undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).__aurora.getState().htmlNetGrants.map((g: { origin: string }) => g.origin))).toEqual(['https://httpbin.org']);
    const g = frame(page);
    await g.locator('#f').click();
    await expect(g.locator('#fast')).toHaveText(/^200\|live\|/, { timeout: 20_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0); // permanente sobreviveu ao reinício
    await g.locator('#go').click();
    await expect(page.getByRole('dialog').getByTestId('net-consent-origin')).toHaveText('https://api.github.com'); // revogado continua revogado
    await page.getByRole('dialog').getByRole('button', { name: 'Negar' }).click();
    evidence.afterRestart = { httpbin: await g.locator('#fast').innerText(), github: await g.locator('#err').innerText() };
    evidence.netLog = netLog.map((x) => ({ status: x.status, ok: x.ok, data: x.data }));
  } finally {
    await ctx?.close().catch(() => undefined);
    stopServers();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* arquivos presos no Windows */ }
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'h2-live-evidence.json'), JSON.stringify({ at: new Date().toISOString(), ...evidence }, null, 2));
  }
});
