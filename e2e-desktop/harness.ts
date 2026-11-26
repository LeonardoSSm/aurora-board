/**
 * Como abrir o Aurora Board Desktop nos testes.
 *
 * - Padrão: o app montado em `desktop-app/` com o Electron do projeto (`electron.launch`, com acesso ao processo
 *   principal para conferir webPreferences e simular o navegador do sistema).
 * - AURORA_DESKTOP_EXECUTABLE=<executável empacotado>: o PACOTE REAL (release/win-unpacked/Aurora Board.exe,
 *   release/linux-unpacked/aurora-board…). O `electron.launch` do Playwright não consegue anexar a executáveis
 *   empacotados sem o carregador dele, então o teste inicia o executável e conecta pelo protocolo de depuração do
 *   Chromium (CDP). Nesse modo não há acesso ao processo principal (`main: null`).
 *
 * Cada sessão usa um perfil próprio (AURORA_USER_DATA_DIR), nunca o do usuário. O pacote de produção sai com
 * devTools desligado; os testes ligam por variável de ambiente local (o mesmo poder de qualquer depurador local).
 */
import { _electron as electron, chromium, expect, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface DesktopSession { page: Page; main: ElectronApplication | null; packaged: boolean; close(): Promise<void> }

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

/** `defaultProfile`: usa o perfil padrão do usuário (testes de instalação em máquina descartável da CI). */
export async function launch(userData: string, extraEnv: Record<string, string> = {}, opts: { defaultProfile?: boolean; args?: string[] } = {}): Promise<DesktopSession> {
  const exe = process.env.AURORA_DESKTOP_EXECUTABLE;
  const env = { ...process.env, AURORA_USER_DATA_DIR: userData, AURORA_DESKTOP_DEVTOOLS: '1', ...extraEnv } as Record<string, string>;
  if (opts.defaultProfile) delete env.AURORA_USER_DATA_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  // CI Linux em contêiner: sem namespaces de usuário para o sandbox do SO (o Chromium recusaria abrir). Só lá; o
  // sandbox do renderer (webPreferences.sandbox) continua ligado e é conferido. Windows/local testam com sandbox.
  const extraArgs = [...(process.env.AURORA_DESKTOP_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), ...(opts.args ?? [])];
  if (!exe) {
    const app = await electron.launch({ args: ['desktop-app', ...extraArgs], env });
    const page = await app.firstWindow();
    await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 30_000 });
    return { page, main: app, packaged: false, close: () => app.close() };
  }
  const port = await freePort();
  const child: ChildProcess = spawn(exe, [`--remote-debugging-port=${port}`, ...extraArgs], { env, stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  let browser: Browser | null = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!browser) { child.kill(); throw new Error('não conectou ao app empacotado'); }
  let page: Page | undefined;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('aurora://app/'));
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) { child.kill(); throw new Error('janela do app não apareceu'); }
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 30_000 });
  const b = browser;
  return {
    page,
    main: null,
    packaged: true,
    close: async () => {
      // Encerramento normal (fecha a janela → o app termina e grava o que estiver pendente).
      try { await (await b.newBrowserCDPSession()).send('Browser.close'); } catch { /* já fechando */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
