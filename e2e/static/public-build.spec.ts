/**
 * Ciclo S1 — homologação local do build PÚBLICO (playwright.static.config.ts).
 * Só a interface do usuário: o build público não tem window.__aurora. Dados fictícios, sem rede externa.
 */
import { expect, test, type Page } from '@playwright/test';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const w = (id: string, widgetType: string, x: number, y: number, data: unknown, title = id) => ({ id, type: 'widget', widgetType, title, x, y, width: 300, height: 240, data });

const BACKUP = {
  format: 'aurora-board', schemaVersion: 3, exportedAt: 1, app: 'Aurora Board 1.0.0',
  boards: [{
    id: 'b_publico', name: 'Quadro público S1',
    elements: [
      w('n1', 'aurora.notes', 0, 0, { mode: 'preview', markdown: '# Nota\n[link](https://example.invalid/pagina)\n\n![remota](https://example.invalid/rastreio.png)\n\n![local](data:image/png;base64,' + PNG_1x1 + ')' }, 'Nota'),
      w('d1', 'aurora.documents', 340, 0, { selected: 'doc1', docs: [{ id: 'doc1', name: 'foto.png', mimeType: 'image/png', size: 68, assetId: 'a_png', url: '', description: '', tags: [], addedAt: 1 }, { id: 'doc2', name: 'leia.txt', mimeType: 'text/plain', size: 5, assetId: 'a_txt', url: '', description: '', tags: [], addedAt: 1 }] }, 'Docs'),
      w('s1', 'aurora.sandbox-html', 680, 0, { html: '<p id="v">inativo</p><p id="n">-</p><script>document.getElementById("v").textContent="ativo"; aurora.setState({ ok: 1 }); aurora.request({ url: "https://api.github.com/repos/LeonardoSSm/aurora-board" }).then(() => { document.getElementById("n").textContent = "VAZOU"; }, (e) => { document.getElementById("n").textContent = e.code + ":" + aurora.network.available; })</script>', state: null }, 'HTML'),
      w('ai1', 'aurora.ai', 0, 280, { provider: '', model: '', instruction: 'x', messages: [], authorized: {} }, 'IA'),
      w('l1', 'aurora.link', 340, 280, { url: 'https://example.invalid/', description: '', preview: { title: 'Exemplo', description: 'd', image: 'https://example.invalid/og.png', siteName: 'ex', fetchedAt: 1 } }, 'Link'),
      { id: 'img1', type: 'image', assetId: 'a_png', x: 680, y: 280, width: 64, height: 64 },
      { id: 'r1', type: 'rectangle', x: 800, y: 280, width: 120, height: 80, text: 'Retângulo' },
    ],
  }],
  assets: [
    { id: 'a_png', name: 'foto.png', mimeType: 'image/png', size: 68, createdAt: 1, dataURL: `data:image/png;base64,${PNG_1x1}` },
    { id: 'a_txt', name: 'leia.txt', mimeType: 'text/plain', size: 5, createdAt: 1, dataURL: `data:text/plain;base64,${b64('texto')}` },
  ],
};

interface Watch { violations: { d: string; u: string; s: string }[]; external: string[]; api: string[] }

async function watch(page: Page, base: string): Promise<Watch> {
  const out: Watch = { violations: [], external: [], api: [] };
  await page.exposeFunction('__s1Violation', (v: { d: string; u: string; s: string }) => out.violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __s1Violation: (v: unknown) => void }).__s1Violation({ d: e.violatedDirective, u: e.blockedURI, s: `${e.sourceFile}:${e.lineNumber} ${e.sample}` }));
  });
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) return;
    if (!u.startsWith(base)) out.external.push(u);
    else if (new URL(u).pathname.startsWith('/api')) out.api.push(u);
  });
  return out;
}

async function importJSON(page: Page, data: unknown) {
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser).setFiles({ name: 'backup.aurora.json', mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
}

test('build público: cabeçalhos, sem depuração, sem /api, sem rede externa, CSP sem violações', async ({ page, baseURL }) => {
  const mode = process.env.AURORA_CSP_MODE === 'report-only' ? 'report-only' : 'enforce';
  const seen = await watch(page, baseURL!);
  const res = await page.goto('/');
  const h = res!.headers();
  expect(h[mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toBe(mode === 'enforce' ? h['content-security-policy'] : undefined);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['permissions-policy']).toContain('camera=()');
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  await expect(page.getByTestId('canvas')).toBeVisible();

  // Aviso do beta: armazenamento local e backup.
  const notice = page.getByTestId('beta-notice');
  await expect(notice).toContainText('ficam armazenados neste navegador');
  await expect(notice).toContainText('Exporte backups regularmente');
  await notice.getByRole('button', { name: 'Entendi' }).click();
  await expect(notice).toHaveCount(0);

  // Nada de API interna no window; arquivos sensíveis não são servidos.
  expect(await page.evaluate(() => typeof (window as unknown as { __aurora?: unknown }).__aurora)).toBe('undefined');
  for (const p of ['/.env', '/server/index.ts', '/package.json', '/src/main.tsx', '/assets/index.js.map']) {
    const r = await page.request.get(p);
    const body = r.ok() ? await r.text() : '';
    expect(body.includes('OPENAI_API_KEY') || body.includes('createServer') || body.includes('"devDependencies"') || body.includes('createRoot(')).toBe(false);
  }

  // Importação com conteúdo variado.
  await importJSON(page, BACKUP);
  await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
  await expect(page.getByTestId('ai-status')).toContainText('não estão disponíveis nesta versão pública');
  await expect(page.getByTestId('link-load-image')).toBeVisible();
  await expect(page.getByRole('button', { name: /Pré-visualizar/ })).toHaveCount(0);
  await expect(page.locator('.md img.ext-img')).toHaveCount(1);
  await expect(page.locator('.md a[target="_blank"][rel*="noopener"]')).toHaveCount(1);
  await expect(page.getByTestId('doc-preview')).toHaveAttribute('data-preview', 'image');

  // Ativação consciente do HTML: executa dentro do sandbox, sob a CSP do app.
  await page.getByTestId('sandbox-activate').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ativar este widget' }).click();
  await expect(page.frameLocator('iframe[sandbox]').locator('#v')).toHaveText('ativo');
  // H2: sem servidor local, aurora.request() é recusado com “indisponível”, sem confirmação e sem rede.
  await expect(page.frameLocator('iframe[sandbox]').locator('#n')).toHaveText('unavailable:false');
  await expect(page.getByTestId('net-consent')).toHaveCount(0);

  // Exportações.
  for (const item of [/Imagem do quadro/, /Vetor do quadro/, /Backup do workspace/]) {
    await page.getByRole('button', { name: /Exportar/ }).click();
    const dl = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: item }).click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/\.(png|svg|json)$/);
    if (item.source.includes('Backup')) {
      const text = await (await d.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]).toString('utf8'));
      expect(JSON.parse(text).boards.some((b: { name: string }) => b.name === 'Quadro público S1')).toBe(true);
      await importJSON(page, text); // reimportar o próprio backup
      await expect(page.getByText('quadro(s) importado', { exact: false }).first()).toBeVisible();
    }
  }

  // Meu Pluggy (issue #9): depende do servidor local; no build público só explica e não chama /api.
  await page.getByTestId('open-finance').click();
  await page.getByTestId('finance-tab-connectors').click();
  await expect(page.getByTestId('pluggy-static')).toContainText('Indisponível nesta versão pública');
  await expect(page.getByTestId('pluggy-check')).toHaveCount(0);

  // Persistência após recarregar.
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('beta-notice')).toHaveCount(0); // dispensa lembrada
  await page.getByRole('button', { name: 'Abrir lista de quadros' }).click();
  await expect(page.getByText('Quadro público S1').first()).toBeVisible();

  // Imagem externa só carrega quando o usuário pede.
  expect(seen.external, 'nenhuma requisição a servidores de terceiros sem ação do usuário').toEqual([]);
  expect(seen.api, 'o build público não chama /api').toEqual([]);
  if (seen.violations.length) console.log(`[CSP ${mode}] violações:`, JSON.stringify(seen.violations, null, 1));
  expect(seen.violations, `violações de CSP (${mode})`).toEqual([]);
});
