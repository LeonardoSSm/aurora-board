/**
 * Aurora Board Desktop (D1) — políticas de segurança PURAS do processo principal (testáveis sem Electron).
 *
 * O renderer é o MESMO frontend da versão web, servido pelo protocolo próprio `aurora://app` (origem estável e
 * segura, sem servidor HTTP). Estas regras decidem o que o renderer pode navegar, abrir e pedir.
 */
import { extname, normalize, posix, resolve, sep } from 'node:path';

export const APP_SCHEME = 'aurora';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

/** URL pertence ao próprio app (documento principal ou o hospedeiro do sandbox dos widgets)? */
export function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Links externos que o usuário pediu para abrir (window.open/target=_blank) vão para o navegador do sistema —
 * só http/https, sem credenciais. Nada abre DENTRO do app (sem janelas novas, sem webviews).
 */
export function externalOpenTarget(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Permissões do Chromium que o renderer pode receber. Câmera, microfone, localização, notificações, MIDI, HID,
 * USB, serial, leitura da área de transferência etc. ficam negados (o app não usa). Colar continua funcionando
 * pelo evento `paste` (não precisa de permissão); copiar usa a escrita “sanitizada”.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
export function isPermissionAllowed(permission: string, requestingUrl: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
export const mimeOf = (file: string) => MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * Caminho de arquivo servido para uma URL `aurora://app/...` — só dentro de `root` (o build do frontend).
 * Recusa outro host, `..`, barras invertidas, bytes nulos e caminhos absolutos. `/` → `/index.html`.
 * Retorna também o caminho público (para os cabeçalhos por caminho, ex.: CSP própria de /sandbox.html).
 */
export function resolveAppFile(rawUrl: string, root: string): { file: string; publicPath: string } | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let path: string;
  try { path = decodeURIComponent(u.pathname); } catch { return null; }
  // Segmentos de ponto que sobreviveram à análise da URL (ex.: `..%2f` codificado) são recusados, não normalizados.
  if (!path || path.includes('\0') || path.includes('\\') || path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (path === '/' || path === '') path = '/index.html';
  const clean = posix.normalize(path);
  if (!clean.startsWith('/') || clean.split('/').includes('..')) return null;
  const base = resolve(root);
  const file = resolve(base, '.' + clean);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return { file: normalize(file), publicPath: clean };
}
