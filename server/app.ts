/**
 * Lógica HTTP do servidor local do Aurora Board (testável: dependências injetáveis).
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/ai/providers        → provedores e se estão configurados (sem expor chaves)
 *   POST /api/ai/chat             → { provider, model?, system, messages[] }
 *   POST /api/link-preview        → { url } → título/descrição/imagem (Open Graph)
 *
 * Proteções do próprio servidor (uso local, sem autenticação):
 *   - Host precisa ser local (anti DNS rebinding);
 *   - Origin, se presente, precisa ser local (anti CSRF a partir de sites visitados);
 *   - POST exige Content-Type: application/json (força preflight CORS, que não é respondido);
 *   - corpo limitado; mensagens de erro sem segredos.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { PROVIDERS, type ChatRequest, type Provider, type ProviderId } from './providers';
import { FetchError, isAllowedHostHeader, isAllowedOrigin, isLoopbackAddress, redactSecrets, safeFetchText, UnsafeUrlError, type Resolver, type Transport } from './netSafety';

const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
export const DEFAULT_LIMITS_BY_ROUTE: Record<'chat' | 'linkPreview', RouteLimit> = {
  chat: { perMinute: 30, concurrent: 3 },
  linkPreview: { perMinute: 60, concurrent: 4 },
};

export interface AppDeps {
  providers?: Record<ProviderId, Provider>;
  linkPreview?: LinkPreviewDeps;
  log?: (msg: string) => void;
  limits?: Partial<typeof DEFAULT_LIMITS_BY_ROUTE>;
  now?: () => number;
  /** Decide se o par TCP é local (injetável nos testes). */
  isLocalPeer?: (addr: string | undefined) => boolean;
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
  };
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
      if (!isAllowedHostHeader(req.headers.host)) throw new HttpError(403, 'Host não permitido.');
      if (!isAllowedOrigin(req.headers.origin as string | undefined)) throw new HttpError(403, 'Origem não permitida.');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; } // sem cabeçalhos CORS: nega origens externas

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
      const status = err instanceof HttpError || err instanceof UnsafeUrlError || err instanceof FetchError ? err.status : typeof err.status === 'number' ? err.status : 500;
      const message = redactSecrets(err.message || 'Erro interno.');
      if (status >= 500) log(`[api] ${req.method} ${url.pathname}: ${message}`);
      send(res, status, { error: status >= 500 && !(err instanceof FetchError) && !err.status ? 'Erro interno.' : message });
    }
  };
}
