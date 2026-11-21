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
import { app, BrowserWindow, Menu, protocol, session, shell, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headersForPath } from '../hosting/headers';
import { APP_ENTRY, APP_HOST, APP_SCHEME, externalOpenTarget, isAppUrl, isPermissionAllowed, mimeOf, resolveAppFile } from './security';

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
  win.once('ready-to-show', () => win.show());
  void win.loadURL(APP_ENTRY);
  return win;
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Arquivo', submenu: [{ role: 'quit', label: 'Sair' }] },
      { label: 'Exibir', submenu: [{ role: 'togglefullscreen', label: 'Tela cheia' }, ...(DEV_TOOLS ? [{ role: 'toggleDevTools' as const, label: 'Ferramentas de desenvolvimento' }] : [])] },
      { label: 'Ajuda', submenu: [{ label: 'Documentação', click: () => void shell.openExternal('https://github.com/LeonardoSSm/aurora-board/tree/main/docs/desktop') }, { label: `Aurora Board ${app.getVersion()}`, enabled: false }] },
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

export { APP_HOST };
