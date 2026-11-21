/**
 * Lógica HTTP do servidor local do Aurora Board (testável: dependências injetáveis).
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/ai/providers        → provedores e se estão configurados (sem expor chaves)
 *   POST /api/ai/chat             → { provider, model?, system, messages[] }
 *   POST /api/link-preview        → { url } → título/descrição/imagem (Open Graph)
 *   POST /api/pairing/code | GET /api/pairing/devices | POST /api/pairing/revoke   (só este computador)
 *   POST /api/pairing/claim | GET /api/pairing/status                          (outro computador, via proxy)
 *   GET  /api/pluggy/status | /api/pluggy/accounts?itemId | /api/pluggy/transactions?itemId&accountId&from&to
 *        → Meu Pluggy, somente leitura (server/pluggy.ts). Só no computador principal, salvo
 *          AURORA_PLUGGY_PAIRED_READ=1 (leitura também por dispositivos pareados).
 *   GET  /api/net/status | POST /api/net/fetch { url, method:'GET', responseType, timeoutMs }
 *        → H2: consulta GET autorizada de widgets HTML (server/netBridge.ts). Só no computador principal.
 *
 * Proteções do próprio servidor (uso local, sem autenticação):
 *   - Host precisa ser local (anti DNS rebinding);
 *   - Origin, se presente, precisa ser local (anti CSRF a partir de sites visitados);
 *   - POST exige Content-Type: application/json (força preflight CORS, que não é respondido);
 *   - corpo limitado; mensagens de erro sem segredos.
 *
 * Dispositivos pareados (server/pairing.ts): chamadas de outro computador da rede só chegam pelo proxy do
 * Vite com o pareamento LIGADO (AURORA_LAN_PAIRING=1), marcadas com `x-aurora-remote: 1`, e exigem
 * `Authorization: Bearer <token>` de um dispositivo pareado. Conexões diretas de fora continuam recusadas.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { PROVIDERS, type ChatRequest, type Provider, type ProviderId } from './providers';
import { isAllowedLanHost, isSameOriginForHost, PairingError, type PairingStore } from './pairing';
import { PluggyError, type PluggyClient } from './pluggy';
import { createHostLimiter, NET_SERVER_LIMITS, netFetch, parseNetBody, type NetFetchDeps } from './netBridge';
import { netOrigin } from '../src/net/protocol';
import { FetchError, isAllowedHostHeader, isAllowedOrigin, isLoopbackAddress, redactSecrets, safeFetchText, UnsafeUrlError, type Resolver, type Transport } from './netSafety';

const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type deve ser application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Corpo da requisição muito grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''; });
}

function meta(html: string, names: string[]): string {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = re.exec(html);
    if (m) return decodeEntities((m[1] ?? m[2] ?? '').trim());
  }
  return '';
}

export interface LinkPreviewDeps { transport?: Transport; resolver?: Resolver }

export async function linkPreview(rawUrl: string, deps: LinkPreviewDeps = {}) {
  const r = await safeFetchText(rawUrl, deps);
  const host = r.url.hostname;
  if (!/html/i.test(r.contentType)) return { title: host, description: r.contentType.slice(0, 100), image: '', siteName: host };
  const html = r.text;
  const title = meta(html, ['og:title', 'twitter:title']) || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? host);
  let image = meta(html, ['og:image', 'twitter:image']);
  // A imagem é carregada pelo navegador do usuário (não pelo servidor); só aceita http(s).
  if (image) { try { const u = new URL(image, r.url); image = u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { image = ''; } }
  return { title: title.slice(0, 300), description: meta(html, ['og:description', 'description', 'twitter:description']).slice(0, 600), image, siteName: (meta(html, ['og:site_name']) || host).slice(0, 120) };
}

export function validateChat(body: unknown): ChatRequest {
  const b = body as Partial<ChatRequest>;
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Requisição inválida.');
  if (!b.provider || !Object.prototype.hasOwnProperty.call(PROVIDERS, b.provider)) throw new HttpError(400, 'Provedor desconhecido.');
  if (typeof b.system !== 'string' || b.system.length > 200_000) throw new HttpError(400, 'Campo "system" inválido.');
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 60) throw new HttpError(400, 'Mensagens inválidas.');
  for (const m of b.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > 100_000) throw new HttpError(400, 'Mensagem inválida.');
  }
  if (b.model !== undefined && (typeof b.model !== 'string' || !/^[\w.:\-/]{1,100}$/.test(b.model))) throw new HttpError(400, 'Modelo inválido.');
  return { provider: b.provider, model: b.model, system: b.system, messages: b.messages.map((m) => ({ role: m.role, content: m.content })) };
}

/** Limites por rota (S1-SEC-014). Defesa em profundidade contra laços/abuso local — não é autenticação. */
export interface RouteLimit { perMinute: number; concurrent: number }
export const DEFAULT_LIMITS_BY_ROUTE: Record<'chat' | 'linkPreview' | 'pluggy' | 'net', RouteLimit> = {
  chat: { perMinute: 30, concurrent: 3 },
  linkPreview: { perMinute: 60, concurrent: 4 },
  pluggy: { perMinute: 60, concurrent: 2 },
  net: { perMinute: NET_SERVER_LIMITS.perMinute, concurrent: NET_SERVER_LIMITS.concurrent },
};

/** Meu Pluggy no servidor local. `client` nulo = não configurado (`problems` diz o que falta, sem valores). */
export interface PluggyDeps {
  client: PluggyClient | null;
  problems: string[];
  /** Permite que dispositivos PAREADOS leiam status/contas/movimentações (padrão: só o computador principal). */
  allowPaired?: boolean;
}

export interface AppDeps {
  providers?: Record<ProviderId, Provider>;
  linkPreview?: LinkPreviewDeps;
  log?: (msg: string) => void;
  limits?: Partial<typeof DEFAULT_LIMITS_BY_ROUTE>;
  now?: () => number;
  /** Decide se o par TCP é local (injetável nos testes). */
  isLocalPeer?: (addr: string | undefined) => boolean;
  /** Dispositivos pareados. Sem isso, chamadas remotas são sempre recusadas. */
  pairing?: PairingStore | null;
  /** Meu Pluggy (uso pessoal). Ausente = as rotas respondem "não configurado". */
  pluggy?: PluggyDeps | null;
  /** H2: transporte/DNS injetáveis (testes) e limite por domínio. */
  net?: NetFetchDeps & { perHostPerMinute?: number };
}

/** Janela deslizante de 60 s + contador de chamadas em andamento. */
function createLimiter(limit: RouteLimit, now: () => number) {
  const hits: number[] = [];
  let active = 0;
  return {
    acquire(): { ok: true; release: () => void } | { ok: false; status: number; message: string; retryAfter: number } {
      const t = now();
      while (hits.length && t - hits[0] >= 60_000) hits.shift();
      if (active >= limit.concurrent) return { ok: false, status: 429, message: 'Muitas requisições simultâneas; aguarde as anteriores terminarem.', retryAfter: 2 };
      if (hits.length >= limit.perMinute) return { ok: false, status: 429, message: `Limite de ${limit.perMinute} requisições por minuto atingido.`, retryAfter: Math.max(1, Math.ceil((60_000 - (t - hits[0])) / 1000)) };
      hits.push(t);
      active++;
      let done = false;
      return { ok: true, release: () => { if (!done) { done = true; active--; } } };
    },
  };
}

export function createApp(deps: AppDeps = {}): RequestListener {
  const providers = deps.providers ?? PROVIDERS;
  const log = deps.log ?? ((m: string) => console.error(m));
  const now = deps.now ?? (() => Date.now());
  const isLocalPeer = deps.isLocalPeer ?? isLoopbackAddress;
  const limiters = {
    chat: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.chat, ...deps.limits?.chat }, now),
    linkPreview: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.linkPreview, ...deps.limits?.linkPreview }, now),
    pluggy: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.pluggy, ...deps.limits?.pluggy }, now),
    net: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.net, ...deps.limits?.net }, now),
  };
  const netHostOk = createHostLimiter(deps.net?.perHostPerMinute ?? NET_SERVER_LIMITS.perHostPerMinute, now);
  const guarded = async <T,>(name: keyof typeof limiters, res: ServerResponse, fn: () => Promise<T>): Promise<T | undefined> => {
    const slot = limiters[name].acquire();
    if (!slot.ok) {
      if (!res.headersSent) res.setHeader('retry-after', String(slot.retryAfter));
      throw new HttpError(slot.status, slot.message);
    }
    try {
      return await fn();
    } finally {
      slot.release();
    }
  };
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!isLocalPeer(req.socket?.remoteAddress)) throw new HttpError(403, 'Somente conexões locais.');
      const pairing = deps.pairing ?? null;
      // Marcado pelo proxy do Vite (que descarta o cabeçalho vindo do cliente). Processos desta máquina estão
      // fora do modelo de ameaça; de todo modo, sem token válido nada é atendido.
      const remote = req.headers['x-aurora-remote'] === '1';
      const remoteAddr = String(req.headers['x-aurora-remote-addr'] ?? '').slice(0, 64) || undefined;
      if (remote) {
        if (!pairing) throw new HttpError(403, 'Pareamento de dispositivos desativado neste servidor.');
        if (!isAllowedLanHost(req.headers.host)) throw new HttpError(403, 'Host não permitido para dispositivo pareado.');
        if (!isSameOriginForHost(req.headers.origin as string | undefined, req.headers.host)) throw new HttpError(403, 'Origem não permitida.');
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
        if (req.method === 'POST' && url.pathname === '/api/pairing/claim') {
          const body = (await readJSON(req)) as { code?: unknown; name?: unknown };
          const r = pairing.claim(body.code, body.name, remoteAddr);
          log(`[api] dispositivo pareado: ${r.device.name} (${remoteAddr ?? '?'})`);
          return send(res, 200, r);
        }
        const device = pairing.verify(req.headers.authorization as string | undefined, remoteAddr);
        if (!device) throw new HttpError(401, 'Este computador não está pareado com o Aurora Board principal.', 'pairing_required');
        if (req.method === 'GET' && url.pathname === '/api/pairing/status') return send(res, 200, { paired: true, device: { id: device.id, name: device.name } });
        if (url.pathname.startsWith('/api/pairing/')) throw new HttpError(403, 'Pareamentos só podem ser gerenciados no computador principal.');
      } else {
        if (!isAllowedHostHeader(req.headers.host)) throw new HttpError(403, 'Host não permitido.');
        if (!isAllowedOrigin(req.headers.origin as string | undefined)) throw new HttpError(403, 'Origem não permitida.');
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; } // sem cabeçalhos CORS: nega origens externas
        if (url.pathname.startsWith('/api/pairing/')) {
          if (!pairing) throw new HttpError(404, 'Pareamento indisponível.');
          if (req.method === 'GET' && url.pathname === '/api/pairing/status') return send(res, 200, { paired: true, local: true });
          if (req.method === 'GET' && url.pathname === '/api/pairing/devices') return send(res, 200, { devices: pairing.list(), pending: pairing.pendingCode() });
          if (req.method === 'POST' && url.pathname === '/api/pairing/code') { await readJSON(req); return send(res, 200, pairing.createCode()); }
          if (req.method === 'POST' && url.pathname === '/api/pairing/cancel') { await readJSON(req); pairing.cancelCode(); return send(res, 200, { ok: true }); }
          if (req.method === 'POST' && url.pathname === '/api/pairing/revoke') {
            const body = (await readJSON(req)) as { id?: unknown };
            if (!pairing.revoke(body.id)) throw new HttpError(404, 'Dispositivo não encontrado.');
            return send(res, 200, { ok: true });
          }
          throw new HttpError(404, 'Rota não encontrada.');
        }
      }

      if (url.pathname.startsWith('/api/pluggy/')) {
        const pl = deps.pluggy ?? { client: null, problems: ['Meu Pluggy não configurado neste servidor.'] };
        // Dados bancários: por padrão só o computador principal consulta (o pareado guardaria cópia própria).
        if (remote && !pl.allowPaired) throw new HttpError(403, 'O Meu Pluggy só pode ser consultado no computador principal.', 'local_only');
        if (req.method !== 'GET') throw new HttpError(405, 'Somente leitura.');
        if (url.pathname === '/api/pluggy/status' && !pl.client) return send(res, 200, { configured: false, problems: pl.problems.slice(0, 10) });
        const client = pl.client;
        if (!client) throw new HttpError(503, pl.problems[0] ?? 'Meu Pluggy não configurado.', 'not_configured');
        const ctrl = new AbortController();
        const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
        res.on('close', onClose);
        try {
          const q = (k: string) => { const v = url.searchParams.get(k); return v && v.length <= 100 ? v : ''; };
          if (url.pathname === '/api/pluggy/status') {
            const items = await guarded('pluggy', res, () => client.status(ctrl.signal));
            return send(res, 200, { configured: true, environment: 'production', readOnly: true, items });
          }
          const itemId = q('itemId');
          if (url.pathname === '/api/pluggy/accounts' || url.pathname === '/api/pluggy/transactions') {
            if (!client.isConfiguredItem(itemId)) throw new HttpError(404, 'Item não configurado em PLUGGY_ITEM_IDS.', 'not_found');
          }
          if (url.pathname === '/api/pluggy/accounts') return send(res, 200, { accounts: await guarded('pluggy', res, () => client.accounts(itemId, ctrl.signal)) });
          if (url.pathname === '/api/pluggy/transactions') {
            return send(res, 200, await guarded('pluggy', res, () => client.transactions(itemId, q('accountId'), { from: q('from'), to: q('to') }, ctrl.signal)));
          }
          throw new HttpError(404, 'Rota não encontrada.');
        } finally {
          res.off('close', onClose);
        }
      }

      if (url.pathname.startsWith('/api/net/')) {
        // H2: só o computador principal (um pareado usaria a rede e o IP desta máquina). Nada do pedido é repassado.
        if (remote) throw new HttpError(403, 'O acesso à rede dos blocos HTML só funciona no computador principal.', 'local_only');
        if (req.method === 'GET' && url.pathname === '/api/net/status') return send(res, 200, { available: true, version: 1, limits: { perMinute: NET_SERVER_LIMITS.perMinute, perHostPerMinute: deps.net?.perHostPerMinute ?? NET_SERVER_LIMITS.perHostPerMinute, maxBytes: NET_SERVER_LIMITS.maxBytes } });
        if (req.method !== 'POST' || url.pathname !== '/api/net/fetch') throw new HttpError(404, 'Rota não encontrada.');
        const parsed = parseNetBody(await readJSON(req));
        if (!parsed.ok) return send(res, 400, parsed.outcome);
        const slot = limiters.net.acquire();
        if (!slot.ok) { res.setHeader('retry-after', String(slot.retryAfter)); return send(res, 429, { ok: false, error: { code: 'rate_limited', message: slot.message } }); }
        try {
          if (!netHostOk(netOrigin(parsed.req.url))) return send(res, 429, { ok: false, error: { code: 'rate_limited', message: 'Limite de consultas por minuto para este domínio atingido.' } });
          // Cliente desistiu (desmontagem, revogação, aurora:abort) → a consulta externa é cancelada.
          const ctrl = new AbortController();
          const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
          res.on('close', onClose);
          try {
            return send(res, 200, await netFetch(parsed.req, deps.net ?? {}, ctrl.signal));
          } finally {
            res.off('close', onClose);
          }
        } finally {
          slot.release();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/ai/providers') {
        return send(res, 200, { providers: Object.values(providers).map((p) => ({ id: p.id, name: p.name, configured: p.configured(), defaultModel: p.defaultModel() })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
        const body = validateChat(await readJSON(req));
        const provider = providers[body.provider];
        if (!provider.configured()) throw new HttpError(400, `${provider.name} não configurado: defina ${provider.envKey} no .env do servidor.`);
        // Cancelar no cliente (fechar a conexão) cancela a chamada ao provedor.
        const ctrl = new AbortController();
        const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
        res.on('close', onClose);
        try {
          const out = await guarded('chat', res, () => provider.chat(body, ctrl.signal));
          return send(res, 200, out);
        } finally {
          res.off('close', onClose);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/link-preview') {
        const body = (await readJSON(req)) as { url?: unknown };
        if (typeof body.url !== 'string' || body.url.length > 2048) throw new HttpError(400, 'URL inválida.');
        return send(res, 200, await guarded('linkPreview', res, () => linkPreview(body.url as string, deps.linkPreview)));
      }
      throw new HttpError(404, 'Rota não encontrada.');
    } catch (e) {
      const err = e as Error & { status?: number };
      const status = err instanceof HttpError || err instanceof UnsafeUrlError || err instanceof FetchError || err instanceof PairingError ? err.status : typeof err.status === 'number' ? err.status : 500;
      const message = redactSecrets(err.message || 'Erro interno.');
      if (status >= 500) log(`[api] ${req.method} ${url.pathname}: ${message}${err instanceof PluggyError && err.upstream ? ` (${err.upstream})` : ''}`);
      const code = err instanceof HttpError ? err.code : err instanceof PluggyError ? err.code : undefined;
      if (err instanceof PluggyError && err.retryAfter && !res.headersSent) res.setHeader('retry-after', String(err.retryAfter));
      send(res, status, { error: status >= 500 && !(err instanceof FetchError) && !err.status ? 'Erro interno.' : message, ...(code ? { code } : {}) });
    }
  };
}
