/**
 * D1-D — experiência desktop no app Electron: menu nativo ligado às ações do app, estado da janela entre aberturas,
 * atalhos do canvas preservados (o menu não registra Ctrl+Z/C/V etc.).
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './harness';

const profiles: string[] = [];
function profile() {
  const p = mkdtempSync(join(tmpdir(), 'aurora-desktop-ux-'));
  profiles.push(p);
  return p;
}
test.afterAll(() => { for (const p of profiles) try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows pode segurar arquivos */ } });

test('P2: importar pelo menu sem ativação do renderer usa o diálogo nativo e permite cancelar e confirmar', async () => {
  test.skip(!!process.env.AURORA_DESKTOP_EXECUTABLE, 'O harness do pacote não acessa o menu no processo principal.');
  const s = await launch(profile());
  try {
    // Só o seletor do SO é substituído: IPC, leitura, validação, confirmação e gravação são reais.
    await s.main!.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, resolve('tests/fixtures/aurora-export-v3.json'));
    const clickImport = () => s.main!.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === 'Importar backup ou arquivo JSON…')!.click();
    });
    // page.evaluate usa userGesture=true no CDP; consultar por CDP evita ativar o renderer no próprio teste.
    const cdp = await s.page.context().newCDPSession(s.page);
    await expect.poll(async () => (await cdp.send('Runtime.evaluate', {
      expression: 'navigator.userActivation.isActive', userGesture: false, returnByValue: true,
    })).result.value, { timeout: 10_000 }).toBe(false);
    await clickImport();
    await expect(s.page.getByRole('dialog')).toContainText('Importar quadros');
    // Uma confirmação pendente deve sobreviver a todos os itens nativos e continuar resolvível.
    await s.main!.evaluate(({ Menu }) => {
      for (const i of Menu.getApplicationMenu()!.items[0].submenu!.items) {
        if (['Configurações do aplicativo…', 'Migrar do navegador…', 'Importar backup ou arquivo JSON…', 'Exportar backup do workspace…'].includes(i.label)) i.click();
      }
    });
    await s.page.waitForTimeout(250);
    await expect(s.page.getByRole('dialog')).toContainText('Importar quadros');
    await s.page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(s.page.getByRole('dialog')).toHaveCount(0);
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(0);
    await clickImport();
    await s.page.getByRole('button', { name: 'Importar como novos quadros' }).click();
    await expect(s.page.getByText('1 quadro(s) importado(s).', { exact: true })).toBeVisible();
  } finally { await s.close(); }
});

test('P2: menu não substitui migração ativa; volta a funcionar depois de fechar', async () => {
  test.skip(!!process.env.AURORA_DESKTOP_EXECUTABLE, 'O harness do pacote não acessa o menu no processo principal.');
  const s = await launch(profile());
  try {
    const click = (label: string) => s.main!.evaluate(({ Menu }, l) => {
      Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === l)!.click();
    }, label);
    await click('Migrar do navegador…');
    await expect(s.page.getByTestId('migration')).toBeVisible();
    await click('Configurações do aplicativo…');
    await s.page.waitForTimeout(250);
    await expect(s.page.getByTestId('migration')).toBeVisible();
    await expect(s.page.getByTestId('desktop-settings')).toHaveCount(0);
    await s.page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    await click('Configurações do aplicativo…');
    await expect(s.page.getByTestId('desktop-settings')).toBeVisible();
  } finally { await s.close(); }
});

test('P2: importação pela interface mantém a confirmação diante do menu nativo', async () => {
  const s = await launch(profile());
  try {
    const select = async () => {
      await s.page.getByRole('button', { name: /Importar/ }).click();
      const chooser = s.page.waitForEvent('filechooser');
      await s.page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
      await (await chooser).setFiles(resolve('tests/fixtures/aurora-export-v3.json'));
      await expect(s.page.getByRole('dialog')).toContainText('Importar quadros');
    };
    await select();
    if (s.main) {
      await s.main.evaluate(({ Menu }) => {
        for (const i of Menu.getApplicationMenu()!.items[0].submenu!.items) {
          if (['Configurações do aplicativo…', 'Migrar do navegador…'].includes(i.label)) i.click();
        }
      });
      await s.page.waitForTimeout(250);
      await expect(s.page.getByRole('dialog')).toContainText('Importar quadros');
    }
    await s.page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(s.page.getByRole('dialog')).toHaveCount(0);
    await select();
    await s.page.getByRole('button', { name: 'Importar como novos quadros' }).click();
    await expect(s.page.getByText('1 quadro(s) importado(s).', { exact: true })).toBeVisible();
  } finally { await s.close(); }
});

test('P2: seletor nativo cancelado e JSON inválido não gravam; menu continua utilizável', async () => {
  test.skip(!!process.env.AURORA_DESKTOP_EXECUTABLE, 'O harness do pacote não acessa o seletor no processo principal.');
  const dir = profile();
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, 'isto não é JSON');
  const s = await launch(dir);
  try {
    await s.main!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    const click = (label: string) => s.main!.evaluate(({ Menu }, l) => {
      Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === l)!.click();
    }, label);
    await click('Importar backup ou arquivo JSON…');
    await s.page.waitForTimeout(250);
    await expect(s.page.getByRole('dialog')).toHaveCount(0);
    await s.main!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, invalid);
    await click('Importar backup ou arquivo JSON…');
    await expect(s.page.getByRole('dialog')).toContainText('Importação recusada');
    await expect(s.page.getByRole('dialog')).toContainText('Nenhum dado foi alterado');
    await s.page.getByRole('button', { name: 'Ok', exact: true }).click();
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(0);
    await click('Configurações do aplicativo…');
    await expect(s.page.getByTestId('desktop-settings')).toBeVisible();
  } finally { await s.close(); }
});

test('menu nativo: Configurações e Migrar abrem as telas do app; nenhum item rouba atalhos do canvas', async () => {
  test.skip(!!process.env.AURORA_DESKTOP_EXECUTABLE, 'Precisa do processo principal para acionar o menu nativo.');
  const s = await launch(profile());
  try {
    const menu = await s.main!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((m) => ({ label: m.label, items: (m.submenu?.items ?? []).map((i) => ({ label: i.label, accel: i.accelerator ?? '' })) })));
    expect(menu.map((m) => m.label)).toEqual(['Arquivo', 'Exibir', 'Ajuda']);
    const accels = menu.flatMap((m) => m.items.map((i) => i.accel)).filter(Boolean);
    for (const a of accels) expect(a).not.toMatch(/^(CmdOrCtrl|Ctrl|Control)\+(Z|Y|C|V|X|A|D|G|K|Plus|=|-|0)$/i);
    const click = (label: string) => s.main!.evaluate(({ Menu }, l) => { for (const m of Menu.getApplicationMenu()!.items) for (const i of m.submenu?.items ?? []) if (i.label === l) i.click(); }, label);
    await click('Configurações do aplicativo…');
    await expect(s.page.getByTestId('desktop-settings')).toBeVisible();
    await s.page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    await click('Migrar do navegador…');
    await expect(s.page.getByTestId('migration')).toBeVisible();
    await s.page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    // Atalhos do canvas continuam do app: Ctrl+Z desfaz a inserção.
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(1);
    // Foco no canvas pelo teclado (em telas pequenas a biblioteca cobre a borda do canvas).
    await s.page.getByTestId('canvas').focus();
    await s.page.keyboard.press('Control+z');
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(0);
  } finally { await s.close(); }
});

test('estado da janela: tamanho e posição voltam na próxima abertura', async () => {
  test.skip(!!process.env.AURORA_DESKTOP_EXECUTABLE, 'Precisa do processo principal para mover a janela.');
  const dir = profile();
  let s = await launch(dir);
  try {
    await s.main!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setBounds({ x: 40, y: 50, width: 1000, height: 700 }); });
    await s.page.waitForTimeout(900);
  } finally { await s.close(); }
  s = await launch(dir);
  try {
    const b = await s.main!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { ...w.getBounds(), max: w.isMaximized() }; });
    expect(b).toMatchObject({ width: 1000, height: 700, max: false });
    expect(Math.abs(b.x - 40)).toBeLessThanOrEqual(16);
    expect(Math.abs(b.y - 50)).toBeLessThanOrEqual(40);
  } finally { await s.close(); }
});
