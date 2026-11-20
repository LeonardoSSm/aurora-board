/**
 * Chamadas à API local. Num computador PAREADO (outro PC da rede), envia o token do dispositivo.
 *
 * O token fica no localStorage da origem do Aurora neste computador remoto: só páginas dessa origem o leem,
 * e ele vai num cabeçalho explícito (não em cookie), então sites visitados não conseguem usá-lo. É revogável
 * a qualquer momento no computador principal. No computador principal não existe token (acesso local).
 */
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

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = deviceToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

export const postJSON = (path: string, body: unknown, signal?: AbortSignal) =>
  apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
