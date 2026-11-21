/**
 * Aurora Board Desktop (D1) — testes no APLICATIVO ELECTRON (não no Vite). Ver e2e-desktop/harness.ts para os dois
 * modos (app montado em `desktop-app/` ou o executável empacotado em AURORA_DESKTOP_EXECUTABLE).
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const profiles: string[] = [];
function profile() {
  const p = mkdtempSync(join(tmpdir(), 'aurora-desktop-e2e-'));
  profiles.push(p);
  return p;
}
test.afterAll(() => { for (const p of profiles) try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows pode segurar arquivos */ } });

test('abre a janela própria com o frontend em aurora://app, sem Node no renderer e com CSP', async () => {
  const s = await launch(profile());
  const { page } = s;
  try {
    expect(await page.title()).toContain('Aurora Board');
    expect(page.url()).toBe('aurora://app/index.html');
    const env = await page.evaluate(() => ({
      require: typeof (window as any).require,
      process: typeof (window as any).process,
      module: typeof (window as any).module,
      buffer: typeof (window as any).Buffer,
      electron: typeof (window as any).electron,
      desktop: Object.keys((window as any).auroraDesktop ?? {}).sort(),
      frozen: Object.isFrozen((window as any).auroraDesktop),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
      origin: location.origin,
      hooks: typeof (window as any).__aurora,
    }));
    expect(env).toMatchObject({ require: 'undefined', process: 'undefined', module: 'undefined', buffer: 'undefined', electron: 'undefined', frozen: true, origin: 'aurora://app' });
    expect(env.desktop).toEqual(['isDesktop', 'platform']);
    expect(env.csp).toContain("script-src 'self'");
    expect(env.csp).toContain("connect-src 'self'");
    expect(env.hooks).toBe('undefined'); // build distribuído: sem ganchos internos
    // Cabeçalhos do protocolo próprio (os mesmos da hospedagem).
    const headers = await page.evaluate(async () => Object.fromEntries((await fetch('/index.html')).headers));
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    // Só o frontend é servido: nada do processo principal, nada fora da pasta.
    const blocked = await page.evaluate(async () => Promise.all(['/../package.json', '/%2e%2e/main.cjs', '/main.cjs', '/preload.cjs', '/..%2fmain.cjs'].map(async (p) => (await fetch(p)).status)));
    expect(blocked).toEqual([404, 404, 404, 404, 404]);
    if (s.main) {
      const prefs = await s.main.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
        return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox, webSecurity: p.webSecurity, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames, webviewTag: p.webviewTag };
      });
      expect(prefs).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, nodeIntegrationInSubFrames: false, webviewTag: false });
    }
  } finally {
    await s.close();
  }
});

test('navegação para fora e janelas novas são bloqueadas; links externos vão para o navegador do sistema', async () => {
  const s = await launch(profile());
  const { page } = s;
  try {
    if (s.main) await s.main.evaluate(({ shell }) => { (globalThis as any).__opened = []; shell.openExternal = async (u: string) => { (globalThis as any).__opened.push(u); }; });
    await page.evaluate(() => { location.href = 'https://example.com/'; });
    await page.waitForTimeout(800);
    expect(page.url()).toBe('aurora://app/index.html');
    await page.evaluate(() => { location.href = 'file:///C:/Windows/win.ini'; });
    await page.waitForTimeout(500);
    expect(page.url()).toBe('aurora://app/index.html');
    const pages = () => page.context().pages().length;
    const before = pages();
    await page.evaluate(() => { window.open('file:///C:/Windows/win.ini'); window.open('javascript:alert(1)'); window.open('aurora://app/index.html'); });
    // Só no modo com processo principal o navegador do sistema é simulado (o empacotado abriria o navegador real).
    if (s.main) await page.evaluate(() => { window.open('https://example.com/docs', '_blank', 'noopener'); });
    await page.waitForTimeout(800);
    expect(pages()).toBe(before);
    if (s.main) expect(await s.main.evaluate(() => (globalThis as any).__opened)).toEqual(['https://example.com/docs']);
    // Permissões sensíveis negadas.
    const geo = await page.evaluate(() => new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('permitido'), (e) => r('negado:' + e.code), { timeout: 3000 })));
    expect(geo).toMatch(/^negado/);
    const media = await page.evaluate(async () => { try { await navigator.mediaDevices.getUserMedia({ video: true }); return 'permitido'; } catch (e) { return 'negado:' + (e as Error).name; } });
    expect(media).toMatch(/^negado/);
  } finally {
    await s.close();
  }
});

test('widget HTML continua isolado: sem ponte desktop, sem Node, sem acesso ao documento principal nem rede direta', async () => {
  const s = await launch(profile());
  const { page } = s;
  try {
    await page.locator('[data-library-item="aurora.sandbox-html"]').click();
    const frame = page.frameLocator('iframe[sandbox]').first();
    await expect(frame.locator('#v')).toHaveText('0'); // o script do exemplo rodou no documento isolado
    const f = page.frames().find((x) => x.url().endsWith('/sandbox.html'))!;
    expect(f).toBeTruthy();
    const probe = await f.evaluate(async () => {
      const r: Record<string, unknown> = {
        origin: self.origin,
        desktop: typeof (window as any).auroraDesktop,
        require: typeof (window as any).require,
        process: typeof (window as any).process,
        rtc: typeof (window as any).RTCPeerConnection,
        aurora: typeof (window as any).aurora?.request,
      };
      try { r.parent = typeof (parent as any).auroraDesktop; } catch (e) { r.parent = 'bloqueado:' + (e as Error).name; }
      try { r.top = (top as any).document ? 'acessou' : 'nada'; } catch (e) { r.top = 'bloqueado:' + (e as Error).name; }
      try { await fetch('https://example.com/'); r.fetch = 'VAZOU'; } catch { r.fetch = 'bloqueado'; }
      try { await fetch('aurora://app/index.html'); r.appFetch = 'VAZOU'; } catch { r.appFetch = 'bloqueado'; }
      return r;
    });
    expect(probe).toEqual({ origin: 'null', desktop: 'undefined', require: 'undefined', process: 'undefined', rtc: 'undefined', aurora: 'function', parent: 'bloqueado:SecurityError', top: 'bloqueado:SecurityError', fetch: 'bloqueado', appFetch: 'bloqueado' });
  } finally {
    await s.close();
  }
});

test('dados persistem no perfil do app depois de fechar e abrir de novo (IndexedDB em aurora://app)', async () => {
  const dir = profile();
  let s = await launch(dir);
  try {
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(0); // primeiro quadro, vazio
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await expect(s.page.locator('[data-type="widget"]').first()).toBeVisible();
    await s.page.waitForTimeout(1500); // autosave
  } finally {
    await s.close();
  }
  s = await launch(dir);
  try {
    await expect(s.page.locator('[data-type="widget"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(1);
  } finally {
    await s.close();
  }
});
