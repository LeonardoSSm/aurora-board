/**
 * D1-C — dados, migração, credenciais e recuperação no APLICATIVO ELECTRON (app montado e executável empacotado).
 * Chaves fictícias apenas; cada teste usa um perfil temporário próprio.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const NO_KEYS = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '', PLUGGY_ITEM_IDS: '' };
const FAKE_KEY = 'sk-proj-CHAVE-FICTICIA-DESKTOP-0123456789';
const profiles: string[] = [];
function profile() {
  const p = mkdtempSync(join(tmpdir(), 'aurora-desktop-data-'));
  profiles.push(p);
  return p;
}
test.afterAll(() => { for (const p of profiles) try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows pode segurar arquivos */ } });

const widgets = (page: Page) => page.locator('[data-type="widget"]');
const providers = (page: Page) => page.evaluate(async () => ((await (window as any).auroraDesktop.api.call('p' + Date.now(), { op: 'ai.providers' })).body.providers as { id: string; configured: boolean }[]).map((p) => `${p.id}:${p.configured}`));

/** Backup pessoal (quadros + finanças) como o navegador gera em Minhas contas → Privacidade e backups. */
function personalBackup(opts: { brokenAsset?: boolean } = {}) {
  const now = Date.now();
  const el = { id: 'n_migr_1', type: 'widget', x: 0, y: 0, width: 240, height: 140, angle: 0, style: { strokeColor: '#e6e9f4', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, roundness: 'round', fontFamily: 'sans', fontSize: 14, textAlign: 'left', verticalAlign: 'top', textColor: '' }, groupIds: [], frameId: null, locked: false, seed: 1, version: 1, updatedAt: now, text: '', widgetType: 'aurora.notes', widgetVersion: '1.0.0', title: 'Nota migrada', data: { text: 'veio do navegador' } };
  const boards = { format: 'aurora-board', schemaVersion: 3, exportedAt: now, app: 'Aurora Board 1.0.0', boards: [{ id: 'b_migrado', workspaceId: 'w_web', name: 'Quadro do navegador', description: '', elements: [el], camera: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now, schemaVersion: 3 }],
    assets: opts.brokenAsset ? [{ id: 'a_quebrado', mimeType: 'image/png', dataURL: 'isto-nao-e-um-data-url', name: 'foto.png', size: 10, createdAt: now }] : [] };
  const finance = {
    format: 'aurora-finance', schemaVersion: 1, exportedAt: now, sensitive: true,
    institutions: [{ id: 'inst_s', name: 'Banco Sintético' }],
    accounts: [{ id: 'acc_s', institutionId: 'inst_s', name: 'Conta Sintética', type: 'checking', currency: 'BRL' }],
    transactions: [{ id: 'tx_s1', accountId: 'acc_s', amountCents: -4250, postedDate: '2026-11-07', currency: 'BRL', dedupeKey: 'k-s1', description: 'UBER SINTETICO' }],
    imports: [], categories: [], rules: [],
  };
  return JSON.stringify({ format: 'aurora-personal-backup', version: 1, exportedAt: now, sensitive: true, boards, finance });
}

test('primeira abertura: boas-vindas não bloqueiam o quadro e não voltam depois de dispensadas', async () => {
  const dir = profile();
  let s = await launch(dir, NO_KEYS);
  try {
    await expect(s.page.getByTestId('desktop-welcome')).toBeVisible();
    await s.page.locator('[data-library-item="aurora.notes"]').click(); // o quadro continua utilizável
    await expect(widgets(s.page)).toHaveCount(1);
    await s.page.getByTestId('desktop-welcome').getByRole('button', { name: 'Começar' }).click();
    await expect(s.page.getByTestId('desktop-welcome')).toHaveCount(0);
  } finally { await s.close(); }
  s = await launch(dir, NO_KEYS);
  try {
    await expect(widgets(s.page)).toHaveCount(1);
    await s.page.waitForTimeout(800);
    await expect(s.page.getByTestId('desktop-welcome')).toHaveCount(0);
  } finally { await s.close(); }
});

test('credenciais: valor nunca volta ao renderer; cofre do sistema quando existe; “só nesta sessão” some ao fechar', async () => {
  const dir = profile();
  let s = await launch(dir, NO_KEYS);
  let strong = false;
  try {
    expect(await providers(s.page)).toEqual(['openai:false', 'anthropic:false', 'gemini:false']);
    await s.page.getByRole('button', { name: /Configurações do aplicativo/ }).click();
    const dlg = s.page.getByTestId('desktop-settings');
    await expect(dlg).toBeVisible();
    strong = (await s.page.getByTestId('vault-status').innerText()).includes('Cofre do sistema disponível');
    if (process.platform === 'win32') expect(strong).toBe(true); // DPAPI do usuário
    const row = dlg.getByTestId('secret-ANTHROPIC_API_KEY');
    await row.locator('input').fill(FAKE_KEY);
    await row.getByRole('button', { name: 'Só nesta sessão' }).click();
    await expect(dlg.getByTestId('secret-status-ANTHROPIC_API_KEY')).toContainText('só nesta sessão');
    if (strong) {
      const r2 = dlg.getByTestId('secret-OPENAI_API_KEY');
      await r2.locator('input').fill(FAKE_KEY);
      await r2.getByRole('button', { name: 'Salvar no cofre' }).click();
      await expect(dlg.getByTestId('secret-status-OPENAI_API_KEY')).toContainText('no cofre do sistema');
    } else {
      await expect(dlg.getByTestId('secret-OPENAI_API_KEY').getByRole('button', { name: 'Salvar no cofre' })).toBeDisabled();
    }
    // Nada do valor no renderer: nem no status, nem no DOM, nem no armazenamento do app.
    const leaked = await s.page.evaluate(async (k) => {
      const st = JSON.stringify(await (window as any).auroraDesktop.secrets.status());
      const dom = document.documentElement.outerHTML;
      const ls = JSON.stringify({ ...localStorage });
      return [st.includes(k), dom.includes(k), ls.includes(k)];
    }, FAKE_KEY);
    expect(leaked).toEqual([false, false, false]);
    expect(await providers(s.page)).toEqual(strong ? ['openai:true', 'anthropic:true', 'gemini:false'] : ['openai:false', 'anthropic:true', 'gemini:false']);
    await s.page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  } finally { await s.close(); }
  const cred = join(dir, 'credentials.json');
  if (strong) {
    expect(existsSync(cred)).toBe(true);
    expect(readFileSync(cred, 'utf8')).not.toContain(FAKE_KEY);
    expect(readFileSync(cred, 'utf8')).not.toContain('ANTHROPIC_API_KEY'); // sessão não vai a disco
  } else {
    expect(existsSync(cred)).toBe(false);
  }
  s = await launch(dir, NO_KEYS);
  try {
    expect(await providers(s.page)).toEqual(strong ? ['openai:true', 'anthropic:false', 'gemini:false'] : ['openai:false', 'anthropic:false', 'gemini:false']);
  } finally { await s.close(); }
});

test('fechar a janela logo depois de uma alteração grava o pendente antes de sair', async () => {
  const dir = profile();
  let s = await launch(dir, NO_KEYS);
  try {
    await s.page.getByTestId('desktop-welcome').getByRole('button', { name: 'Começar' }).click();
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await s.page.locator('[data-library-item="aurora.tasks"]').click();
    await expect(widgets(s.page)).toHaveCount(2);
    // Sem esperar o salvamento automático (400 ms): fecha já.
    if (s.main) await s.main.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  } finally { await s.close(); }
  s = await launch(dir, NO_KEYS);
  try {
    await expect(widgets(s.page)).toHaveCount(2);
  } finally { await s.close(); }
});

test('fechar a janela com um texto AINDA em edição grava o texto digitado (Codex, PR #40)', async () => {
  const dir = profile();
  let s = await launch(dir, NO_KEYS);
  test.skip(!s.main, 'Precisa do processo principal para fechar a janela como o usuário (Alt+F4).');
  try {
    await s.page.getByTestId('desktop-welcome').getByRole('button', { name: 'Começar' }).click();
    await s.page.getByTestId('canvas').focus();
    await s.page.keyboard.press('t');
    const box = (await s.page.getByTestId('canvas').boundingBox())!;
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await s.page.keyboard.type('Texto ainda no editor');
    await expect(s.page.getByTestId('text-editor')).toBeFocused();
    await s.main!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  } finally { await s.close(); }
  s = await launch(dir, NO_KEYS);
  try {
    await expect(s.page.getByText('Texto ainda no editor')).toBeVisible({ timeout: 15_000 });
  } finally { await s.close(); }
});

test('recuperação após queda do renderer: recarrega sozinho e os dados gravados continuam', async () => {
  const s = await launch(profile(), NO_KEYS);
  test.skip(!s.main, 'Precisa do processo principal para derrubar o renderer (modo app montado).');
  // No contêiner Linux da CI (sem sandbox do SO), derrubar o renderer à força deixa o processo do Electron travado
  // (nem o encerramento conclui). Verificado no Windows (local e CI); no Linux fica registrado como NÃO verificado
  // (docs/desktop/HOMOLOGATION.md). Só esta configuração de teste é pulada.
  if (process.env.AURORA_DESKTOP_NO_SANDBOX === '1') { await s.close().catch(() => undefined); test.skip(true, 'Contêiner sem sandbox: queda forçada trava o Electron (ver HOMOLOGATION.md).'); }
  try {
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await expect(widgets(s.page)).toHaveCount(1);
    await s.page.waitForTimeout(1200); // gravado
    await s.main!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
    // O objeto Page do Playwright fica marcado como “caído”; a janela recarregada é conferida pelo processo principal.
    await expect.poll(() => s.main!.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      if (wc.isCrashed()) return 'caído';
      // Cada tentativa tem limite próprio: durante a recarga o executeJavaScript pode não responder.
      const probe = wc.executeJavaScript('document.querySelectorAll("[data-testid=canvas]").length + ":" + document.querySelectorAll("[data-type=widget]").length').catch(() => 'carregando');
      return `${wc.getURL()}|${await Promise.race([probe, new Promise((r) => setTimeout(() => r('sem resposta'), 2000))])}`;
    }), { timeout: 30_000 }).toBe('aurora://app/index.html|1:1');
  } finally { await s.close(); }
});

test('migração do navegador: backup pessoal completo traz quadros e finanças; repetir não duplica as finanças', async () => {
  const s = await launch(profile(), NO_KEYS);
  const { page } = s;
  try {
    await page.getByTestId('desktop-welcome').getByRole('button', { name: /Migrar do navegador/ }).click();
    const m = page.getByTestId('migration');
    await expect(m).toBeVisible();
    await m.getByTestId('migration-file').setInputFiles({ name: 'aurora-pessoal.json', mimeType: 'application/json', buffer: Buffer.from(personalBackup()) });
    await m.getByTestId('migration-analyze').click();
    await expect(m.getByTestId('migration-plan')).toContainText('Backup pessoal completo');
    await expect(m.getByTestId('migration-plan')).toContainText('1 quadro(s)');
    await expect(m.getByTestId('migration-plan')).toContainText('1 conta(s)');
    await m.getByTestId('migration-run').click();
    await expect(m.getByTestId('migration-result')).toContainText('1 quadro(s) importado(s).');
    await expect(m.getByTestId('migration-warnings')).toHaveCount(0);
    // Outro backup no MESMO diálogo: o resultado anterior some e o novo plano pode ser migrado (Codex, PR #40);
    // um arquivo inválido no backup aparece como aviso ANTES de confirmar e o resultado diz que foi parcial.
    await m.getByTestId('migration-file').setInputFiles({ name: 'aurora-parcial.json', mimeType: 'application/json', buffer: Buffer.from(personalBackup({ brokenAsset: true })) });
    await expect(m.getByTestId('migration-result')).toHaveCount(0);
    await m.getByTestId('migration-analyze').click();
    await expect(m.getByTestId('migration-warnings')).toContainText('1 aviso(s)');
    await expect(m.getByTestId('migration-warnings')).toContainText('foto.png');
    await m.getByTestId('migration-run').click();
    await expect(m.getByTestId('migration-result')).toContainText('1 quadro(s) importado(s) com 1 aviso(s)');
    await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('[data-type="widget"]')).toHaveCount(1); // abriu o quadro migrado (a cópia parcial)
    await page.getByTestId('open-finance').click();
    await expect(page.getByText('Conta Sintética').first()).toBeVisible();
    await page.keyboard.press('Escape');
    // Repetir: finanças repetidas são ignoradas; os quadros entram de novo como cópia (nunca sobrescrevem).
    await page.getByRole('button', { name: 'Importar' }).click();
    await page.getByRole('menuitem', { name: /Migrar do navegador/ }).click();
    await m.getByTestId('migration-file').setInputFiles({ name: 'aurora-pessoal.json', mimeType: 'application/json', buffer: Buffer.from(personalBackup()) });
    await m.getByTestId('migration-analyze').click();
    await m.getByTestId('migration-run').click();
    await expect(m.getByTestId('migration-result')).toContainText(/0 registro\(s\) novo\(s\)/);
    // Arquivo inválido: recusado antes de gravar.
    await m.getByTestId('migration-file').setInputFiles({ name: 'ruim.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"aurora-personal-backup","boards":1}') });
    await m.getByTestId('migration-analyze').click();
    await expect(m.getByTestId('migration-error')).toBeVisible();
  } finally { await s.close(); }
});
