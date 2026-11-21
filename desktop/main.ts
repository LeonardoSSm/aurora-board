/**
 * Aurora Board Desktop (ciclo D1, issue #34) — processo principal do Electron.
 *
 * - O renderer é o frontend existente (build `npm run build:desktop` → `desktop-app/renderer/`), servido pelo protocolo
 *   próprio `aurora://app` a partir dos arquivos empacotados: sem servidor HTTP, origem estável (o IndexedDB
 *   fica no perfil do app) e os MESMOS cabeçalhos de segurança da hospedagem (hosting/headers.ts), inclusive a CSP
 *   própria de /sandbox.html.
 * - Renderer isolado: sem Node, `contextIsolation`, sandbox, `webSecurity`; preload mínimo (desktop/preload.ts).
 * - Navegação, janelas novas, webviews e permissões passam por desktop/security.ts.
 * Ver docs/desktop/ARCHITECTURE.md.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, session, shell, type WebContents } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headersForPath } from '../hosting/headers';
import { APP_ENTRY, APP_HOST, APP_SCHEME, externalOpenTarget, isAppUrl, isPermissionAllowed, mimeOf, resolveAppFile } from './security';
import { createApiService } from '../server/apiService';
import { PROVIDERS } from '../server/providers';
import { PluggyClient, readPluggyConfig } from '../server/pluggy';
import { isTrustedSender, registerIpc, registerSecretsIpc } from './ipc';
import { SecretStore } from './secrets';
import { resolveWindowState, sanitizeWindowState, type WindowState } from './windowState';
import { MENU_ACTIONS, type MenuAction } from './menuActions';

// Testes e uso portátil: perfil em outra pasta (antes de qualquer acesso ao perfil).
if (process.env.AURORA_USER_DATA_DIR) app.setPath('userData', process.env.AURORA_USER_DATA_DIR);

// Todos os renderers em sandbox (o preload também roda isolado, só com `require('electron')` restrito).
app.enableSandbox();

// `aurora://app` como esquema padrão e seguro: origem própria para o IndexedDB/localStorage, CSP e fetch.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Pasta do frontend empacotado. */
const RENDERER_ROOT = join(app.getAppPath(), 'renderer');
const PRELOAD = join(__dirname, 'preload.cjs');
const DEV_TOOLS = !app.isPackaged || process.env.AURORA_DESKTOP_DEVTOOLS === '1';

async function serveApp(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Método não permitido', { status: 405 });
  const target = resolveAppFile(request.url, RENDERER_ROOT);
  if (!target) return new Response('Não encontrado', { status: 404 });
  try {
    const body = await readFile(target.file);
    const headers = new Headers(headersForPath(target.publicPath));
    headers.set('content-type', mimeOf(target.file));
    headers.set('cache-control', 'no-cache');
    // HSTS não se aplica a um esquema próprio; o resto (CSP, nosniff, COOP, CORP, referrer…) vale como na web.
    headers.delete('strict-transport-security');
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch {
    return new Response('Não encontrado', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

/** Regras aplicadas a TODO conteúdo web criado (janela principal e qualquer outro). */
function harden(contents: WebContents) {
  contents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  // Subframes (o iframe isolado dos widgets) também não saem do app — além do `frame-src 'self'` da CSP.
  contents.on('will-frame-navigate', (e) => { if (!isAppUrl(e.url)) e.preventDefault(); });
  contents.on('will-redirect', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const ext = externalOpenTarget(url);
    if (ext) void shell.openExternal(ext);
    return { action: 'deny' };
  });
}

let mainWindow: BrowserWindow | null = null;

/**
 * Integrações no processo principal (D1-B): o mesmo serviço da API local da web, sem servidor HTTP.
 * Chaves de IA e credenciais do Meu Pluggy vêm do ambiente do processo (D1-C: cofre do sistema operacional).
 */
let pluggyCache: { key: string; deps: { client: PluggyClient | null; problems: string[] } } | null = null;
function pluggyDeps() {
  const cfg = readPluggyConfig(process.env);
  const key = JSON.stringify([process.env.PLUGGY_CLIENT_ID ?? '', process.env.PLUGGY_CLIENT_SECRET ? 'x' : '', process.env.PLUGGY_ITEM_IDS ?? '']);
  if (!pluggyCache || pluggyCache.key !== key) pluggyCache = { key, deps: { client: cfg.config ? new PluggyClient(cfg.config) : null, problems: cfg.problems } };
  return pluggyCache.deps;
}
const service = createApiService({
  providers: PROVIDERS,
  pluggy: pluggyDeps,
  missingKeyHint: (p) => `configure a chave em Configurações do aplicativo (ou a variável de ambiente ${p.envKey})`,
  // Sem conteúdo de usuário nos logs: só a operação e mensagens já sem segredos.
  log: (m) => console.error(m),
});

/* ------------------------------------------------------------------ estado da janela (D1-D) */

const windowStateFile = () => join(app.getPath('userData'), 'window-state.json');
function loadWindowState(): WindowState {
  let saved: WindowState | null = null;
  try { saved = sanitizeWindowState(JSON.parse(readFileSync(windowStateFile(), 'utf8'))); } catch { saved = null; }
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  return resolveWindowState(saved, displays, screen.getPrimaryDisplay().workArea);
}
function saveWindowState(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const state: WindowState = { bounds: win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized(), ...(win.isFullScreen() ? { fullScreen: true } : {}) };
  try {
    const tmp = `${windowStateFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, windowStateFile());
  } catch { /* sem permissão de escrita: abre na posição padrão da próxima vez */ }
}

/** Ação do menu nativo → renderer (allowlist; o renderer executa as MESMAS ações da interface). */
function sendMenuAction(action: MenuAction) {
  if (mainWindow && !mainWindow.isDestroyed() && MENU_ACTIONS.includes(action)) mainWindow.webContents.send('aurora:menu', action);
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Aurora Board',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: DEV_TOOLS,
    },
  });
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    if (state.fullScreen) win.setFullScreen(true);
    win.show();
  });
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => saveWindowState(win), 500); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'resize', scheduleSave);
  win.on('close', () => saveWindowState(win));
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  guardClose(win);
  recoverFromCrashes(win);
  mainWindow = win;
  void win.loadURL(APP_ENTRY);
  return win;
}

/* ------------------------------------------------------------------ encerramento seguro (D1-C) */

/** Respostas do renderer ao pedido “grave o pendente antes de fechar”. */
const closeWaiters = new Map<number, (ok: boolean) => void>();
ipcMain.handle('aurora:close-ready', (e, ok: unknown) => {
  if (!isTrustedSender(e, () => mainWindow)) return;
  closeWaiters.get(e.sender.id)?.(ok === true);
});

/**
 * Fechar a janela pede ao renderer que grave as alterações pendentes (IndexedDB) e espera a confirmação. Se não
 * vier (gravação falhou, renderer travado), pergunta: tentar de novo ou fechar mesmo assim — o diário de
 * recuperação (localStorage) traz de volta o que não foi gravado na próxima abertura.
 */
function guardClose(win: BrowserWindow) {
  let allowed = false, asking = false;
  win.on('close', (e) => {
    if (allowed || win.webContents.isCrashed()) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    const id = win.webContents.id;
    void new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { closeWaiters.delete(id); resolve(false); }, 8000);
      closeWaiters.set(id, (ok) => { clearTimeout(timer); closeWaiters.delete(id); resolve(ok); });
      win.webContents.send('aurora:before-close');
    }).then(async (ok) => {
      if (!ok && !win.isDestroyed()) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Aurora Board',
          message: 'Algumas alterações ainda não foram gravadas.',
          detail: 'Elas ficam no diário de recuperação e voltam ao abrir o Aurora Board, mas o mais seguro é tentar gravar de novo.',
          buttons: ['Tentar de novo', 'Fechar mesmo assim', 'Cancelar'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        asking = false;
        if (r.response === 0) { win.close(); return; }
        if (r.response !== 1) return;
      }
      asking = false;
      allowed = true;
      if (!win.isDestroyed()) win.close();
    });
  });
}

/**
 * Recuperação após falha: se o processo do renderer cair, recarrega (o diário de recuperação devolve o que não foi
 * gravado). Duas quedas seguidas em menos de 30 s → pergunta antes de insistir.
 */
function recoverFromCrashes(win: BrowserWindow) {
  let lastCrash = 0;
  win.webContents.on('render-process-gone', async (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    console.error(`[desktop] renderer encerrou: ${details.reason}`);
    const now = Date.now();
    const repeated = now - lastCrash < 30_000;
    lastCrash = now;
    if (repeated) {
      const r = await dialog.showMessageBox(win, { type: 'error', title: 'Aurora Board', message: 'O Aurora Board parou de responder novamente.', detail: 'Seus dados gravados estão no perfil do aplicativo. Recarregar tenta recuperar as alterações do diário.', buttons: ['Recarregar', 'Fechar'], defaultId: 0, cancelId: 1, noLink: true });
      if (r.response !== 0) { win.destroy(); return; }
    }
    if (!win.isDestroyed()) void win.loadURL(APP_ENTRY);
  });
  win.on('unresponsive', async () => {
    const r = await dialog.showMessageBox(win, { type: 'warning', title: 'Aurora Board', message: 'O Aurora Board não está respondendo.', buttons: ['Esperar', 'Recarregar'], defaultId: 0, cancelId: 0, noLink: true });
    if (r.response === 1 && !win.isDestroyed()) win.webContents.reload();
  });
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.on('web-contents-created', (_e, contents) => harden(contents));
  app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, (req) => serveApp(req));
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(isPermissionAllowed(permission, wc.getURL())));
    ses.setPermissionCheckHandler((wc, permission) => !!wc && isPermissionAllowed(permission, wc.getURL()));
    // Menu mínimo, sem atalhos que colidam com os do canvas (Ctrl+Z/Y/C/V/A, +/-, setas… ficam com o app).
    // Sem atalhos de teclado nos itens: Ctrl+Z/Y/C/V/A, +/-, setas, Delete etc. continuam com o canvas.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Arquivo', submenu: [
        { label: 'Importar backup ou arquivo JSON…', click: () => sendMenuAction('import') },
        { label: 'Migrar do navegador…', click: () => sendMenuAction('migrate') },
        { label: 'Exportar backup do workspace…', click: () => sendMenuAction('export-workspace') },
        { type: 'separator' },
        { label: 'Configurações do aplicativo…', click: () => sendMenuAction('settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ] },
      { label: 'Exibir', submenu: [{ role: 'togglefullscreen', label: 'Tela cheia' }, ...(DEV_TOOLS ? [{ role: 'toggleDevTools' as const, label: 'Ferramentas de desenvolvimento' }] : [])] },
      { label: 'Ajuda', submenu: [{ label: 'Documentação', click: () => void shell.openExternal('https://github.com/LeonardoSSm/aurora-board/tree/main/docs/desktop') }, { label: `Aurora Board ${app.getVersion()}`, enabled: false }] },
    ]));
    // Credenciais no cofre do sistema (DPAPI no Windows; Secret Service/KWallet no Linux) — ver desktop/secrets.ts.
    const secrets = new SecretStore(join(app.getPath('userData'), 'credentials.json'), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : ''),
      encrypt: (t) => safeStorage.encryptString(t),
      decrypt: (b) => safeStorage.decryptString(b),
    }, process.platform);
    secrets.onChange = () => { pluggyCache = null; };
    secrets.load();
    registerIpc(service, () => mainWindow);
    registerSecretsIpc(secrets, () => mainWindow);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

export { APP_HOST };
