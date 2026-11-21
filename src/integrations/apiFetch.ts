/**
 * Chamadas à API local.
 *
 * - Versão web com servidor local: `fetch('/api/...')`. Num computador PAREADO (outro PC da rede), envia o token do
 *   dispositivo. O token fica no localStorage da origem do Aurora neste computador remoto: só páginas dessa origem
 *   o leem, e ele vai num cabeçalho explícito (não em cookie), então sites visitados não conseguem usá-lo. É
 *   revogável a qualquer momento no computador principal. No computador principal não existe token.
 * - Aplicativo desktop (D1-B): a MESMA chamada vira IPC tipado com o processo principal (`window.auroraDesktop.api`),
 *   sem servidor HTTP. Quem chama continua recebendo um `Response` — os clientes (IA, Meu Pluggy, rede dos
 *   widgets, pré-visualização de links) não mudam.
 */
import { DESKTOP } from '../config/runtime';
import { routeOp, type ApiResult } from './apiRoutes';

const KEY = 'aurora.deviceToken';

export function deviceToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function setDeviceToken(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch { /* armazenamento indisponível: o pareamento não persiste nesta aba */ }
}

interface DesktopBridge { api: { call(id: string, op: unknown, body?: unknown): Promise<ApiResult>; cancel(id: string): void } }
const bridge = (): DesktopBridge | null => (typeof window !== 'undefined' ? ((window as unknown as { auroraDesktop?: DesktopBridge }).auroraDesktop ?? null) : null);

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

let seq = 0;
async function desktopFetch(path: string, init: RequestInit): Promise<Response> {
  const b = bridge();
  if (!b) return json(503, { error: 'Integração do aplicativo desktop indisponível.' });
  const url = new URL(path, 'aurora://app');
  const op = routeOp((init.method ?? 'GET').toUpperCase(), url);
  if (!op || op === 'method-not-allowed') return json(op ? 405 : 404, { error: op ? 'Somente leitura.' : 'Rota não encontrada.' });
  let body: unknown = undefined;
  if (typeof init.body === 'string') {
    try { body = JSON.parse(init.body); } catch { return json(400, { error: 'JSON inválido.' }); }
  }
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException('A operação foi cancelada.', 'AbortError');
  const id = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
  const onAbort = () => b.api.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const call = b.api.call(id, op, body);
    // fetch rejeita com AbortError assim que o sinal dispara; o processo principal cancela a operação em paralelo.
    const r = signal
      ? await Promise.race([call, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('A operação foi cancelada.', 'AbortError')), { once: true }))])
      : await call;
    const status = Number.isInteger(r?.status) && r.status >= 200 && r.status <= 599 ? r.status : 500;
    return json(status, r?.body ?? null, r?.retryAfter ? { 'retry-after': String(r.retryAfter) } : {});
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (DESKTOP) return desktopFetch(path, init);
  const token = deviceToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

export const postJSON = (path: string, body: unknown, signal?: AbortSignal) =>
  apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
