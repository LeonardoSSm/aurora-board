/**
 * Operações da API local do Aurora Board (D1-B) — contrato PURO compartilhado por:
 * - server/app.ts (rota HTTP → operação), versão web com servidor local;
 * - src/integrations/apiFetch.ts (versão desktop: a mesma chamada vira IPC tipado, sem servidor HTTP);
 * - desktop/ipcValidation.ts (o processo principal revalida tudo o que chega do renderer).
 */

/** Operações aceitas pelo serviço. `pluggy.other`/`net.other` só existem no HTTP (subrotas desconhecidas). */
export type ApiOp =
  | { op: 'health' }
  | { op: 'ai.providers' }
  | { op: 'ai.chat' }
  | { op: 'linkPreview' }
  | { op: 'pluggy.status' }
  | { op: 'pluggy.accounts'; itemId: string }
  | { op: 'pluggy.transactions'; itemId: string; accountId: string; from: string; to: string }
  | { op: 'net.status' }
  | { op: 'net.fetch' }
  | { op: 'pluggy.other' }
  | { op: 'net.other' };

/** Operações que o aplicativo desktop aceita por IPC (allowlist fechada; sem pareamento, sem subrotas genéricas). */
export const DESKTOP_IPC_OPS = ['health', 'ai.providers', 'ai.chat', 'linkPreview', 'pluggy.status', 'pluggy.accounts', 'pluggy.transactions', 'net.status', 'net.fetch'] as const;
export type DesktopIpcOp = (typeof DESKTOP_IPC_OPS)[number];

/** Operações que recebem corpo JSON. */
export const OPS_WITH_BODY = new Set<string>(['ai.chat', 'linkPreview', 'net.fetch']);

/** Rota HTTP → operação. `method-not-allowed` só para o Meu Pluggy (somente leitura); null = não é rota de serviço. */
export function routeOp(method: string, url: URL): ApiOp | 'method-not-allowed' | null {
  const path = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? '';
  if (path.startsWith('/api/pluggy/')) {
    if (method !== 'GET') return 'method-not-allowed';
    if (path === '/api/pluggy/status') return { op: 'pluggy.status' };
    if (path === '/api/pluggy/accounts') return { op: 'pluggy.accounts', itemId: q('itemId') };
    if (path === '/api/pluggy/transactions') return { op: 'pluggy.transactions', itemId: q('itemId'), accountId: q('accountId'), from: q('from'), to: q('to') };
    return { op: 'pluggy.other' };
  }
  if (path.startsWith('/api/net/')) {
    if (method === 'GET' && path === '/api/net/status') return { op: 'net.status' };
    if (method === 'POST' && path === '/api/net/fetch') return { op: 'net.fetch' };
    return { op: 'net.other' };
  }
  if (method === 'GET' && path === '/api/health') return { op: 'health' };
  if (method === 'GET' && path === '/api/ai/providers') return { op: 'ai.providers' };
  if (method === 'POST' && path === '/api/ai/chat') return { op: 'ai.chat' };
  if (method === 'POST' && path === '/api/link-preview') return { op: 'linkPreview' };
  return null;
}

/** Resultado de uma chamada (mesmo formato no HTTP e no IPC). */
export interface ApiResult { status: number; body: unknown; retryAfter?: number }
