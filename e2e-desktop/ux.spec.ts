/**
 * D1-D — experiência desktop no app Electron: menu nativo ligado às ações do app, estado da janela entre aberturas,
 * atalhos do canvas preservados (o menu não registra Ctrl+Z/C/V etc.).
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const profiles: string[] = [];
function profile() {
  const p = mkdtempSync(join(tmpdir(), 'aurora-desktop-ux-'));
  profiles.push(p);
  return p;
}
test.afterAll(() => { for (const p of profiles) try { rmSync(p, { recursive: true, force: true }); } catch { /* Windows pode segurar arquivos */ } });

test('menu nativo: Configurações e Migrar abrem as telas do app; nenhum item rouba atalhos do canvas', async () => {
  const s = await launch(profile());
  test.skip(!s.main, 'Precisa do processo principal para acionar o menu nativo.');
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
    await s.page.getByTestId('canvas').click({ position: { x: 20, y: 20 } });
    await s.page.keyboard.press('Control+z');
    await expect(s.page.locator('[data-type="widget"]')).toHaveCount(0);
  } finally { await s.close(); }
});

test('estado da janela: tamanho e posição voltam na próxima abertura', async () => {
  const dir = profile();
  let s = await launch(dir);
  test.skip(!s.main, 'Precisa do processo principal para mover a janela.');
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
