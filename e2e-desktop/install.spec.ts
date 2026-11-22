/**
 * D1-D — instalação REAL (só com AURORA_INSTALL_TEST=1; roda na CI, em máquinas descartáveis — nunca instala no
 * computador de quem desenvolve sem pedir):
 * - Windows: instalador NSIS em modo silencioso, por usuário (sem administrador), numa pasta temporária;
 *   atalhos, execução do app INSTALADO, dados fora da pasta de instalação, desinstalação que preserva os dados.
 * - Linux: o .deb já instalado pela CI (`sudo dpkg -i`) — binário, atalho .desktop, execução e perfil em ~/.config.
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const ON = process.env.AURORA_INSTALL_TEST === '1';

/** Executa e exige sucesso. Argumentos literais: o NSIS exige `/D=` sem aspas e como último argumento. */
function run(file: string, args: string[]) {
  const r = spawnSync(file, args, { stdio: 'inherit', timeout: 180_000, windowsVerbatimArguments: true });
  if (r.error) throw r.error;
  expect(r.status, `${file} ${args.join(' ')}`).toBe(0);
}

test('Windows: instalar, abrir o app instalado, desinstalar e manter os dados do usuário', async () => {
  test.skip(!ON || process.platform !== 'win32', 'Instalação real: só na CI Windows (AURORA_INSTALL_TEST=1).');
  const installer = process.env.AURORA_DESKTOP_INSTALLER!;
  expect(existsSync(installer), installer).toBe(true);
  const dir = join(mkdtempSync(join(tmpdir(), 'aurora-install-')), 'Aurora Board');
  // /S silencioso · /currentuser por usuário · /D deve ser o último argumento, sem aspas.
  run(installer, ['/S', '/currentuser', `/D=${dir}`]);
  const exe = join(dir, 'Aurora Board.exe');
  expect(existsSync(exe)).toBe(true);
  const startMenu = join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  expect(readdirSync(startMenu).some((f) => f.startsWith('Aurora Board'))).toBe(true);
  const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
  expect(uninstaller).toBeTruthy();

  // O app instalado abre com o PERFIL PADRÃO do usuário (%APPDATA%\Aurora Board), fora da pasta de instalação.
  process.env.AURORA_DESKTOP_EXECUTABLE = exe;
  const s = await launch('', {}, { defaultProfile: true });
  try {
    await expect(s.page.getByTestId('canvas')).toBeVisible();
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await s.page.waitForTimeout(1500);
  } finally { await s.close(); }
  const profileDir = join(process.env.APPDATA!, 'Aurora Board');
  expect(existsSync(profileDir)).toBe(true);
  expect(profileDir.toLowerCase().startsWith(dir.toLowerCase())).toBe(false);

  run(join(dir, uninstaller!), ['/S', '/currentuser']);
  // O desinstalador NSIS se copia para a pasta temporária e termina em segundo plano: espera a remoção.
  await expect.poll(() => existsSync(exe), { timeout: 60_000 }).toBe(false);
  await expect.poll(() => readdirSync(startMenu).some((f) => f.startsWith('Aurora Board')), { timeout: 30_000 }).toBe(false);
  expect(existsSync(profileDir)).toBe(true); // dados do usuário preservados

  // Reinstalar e reabrir: os quadros continuam lá.
  run(installer, ['/S', '/currentuser', `/D=${dir}`]);
  const again = await launch('', {}, { defaultProfile: true });
  try {
    await expect(again.page.locator('[data-type="widget"]')).toHaveCount(1, { timeout: 15_000 });
  } finally { await again.close(); }
});

test('Linux: pacote .deb instalado abre sem root, com o sandbox do sistema e perfil em ~/.config', async () => {
  test.skip(!ON || process.platform !== 'linux', 'Instalação real: só na CI Linux (AURORA_INSTALL_TEST=1).');
  const exe = process.env.AURORA_DESKTOP_EXECUTABLE!;
  expect(existsSync(exe), exe).toBe(true);
  expect(existsSync('/usr/share/applications/aurora-board.desktop')).toBe(true);
  expect(process.getuid?.()).not.toBe(0);
  const s = await launch('', {}, { defaultProfile: true });
  try {
    await expect(s.page.getByTestId('canvas')).toBeVisible();
    expect(await s.page.evaluate(() => (window as any).auroraDesktop.platform)).toBe('linux');
    await s.page.locator('[data-library-item="aurora.notes"]').click();
    await s.page.waitForTimeout(1500);
  } finally { await s.close(); }
  expect(existsSync(join(homedir(), '.config', 'Aurora Board'))).toBe(true);
});
