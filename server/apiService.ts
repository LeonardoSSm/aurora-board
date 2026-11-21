/**
 * Serviços do Aurora Board independentes do transporte (D1-B, issue #34).
 *
 * A MESMA lógica atende:
 * - a API HTTP local da versão web (`server/app.ts`, depois das checagens de Host/Origin/par TCP/pareamento);
 * - o IPC do aplicativo desktop (`desktop/ipc.ts`, depois da checagem do remetente), sem servidor HTTP.
 *
 * Operações FECHADAS (allowlist): saúde, provedores/conversa de IA, pré-visualização de link, Meu Pluggy (somente
 * leitura) e HTML Network Bridge. Cada uma valida os próprios argumentos e passa pelos mesmos limitadores. Nunca
 * lança: devolve `{ status, body, retryAfter? }` com mensagens sem segredos.
 */
import { PROVIDERS, type ChatRequest, type Provider, type ProviderId } from './providers';
import { PairingError } from './pairing';
import { PluggyError, type PluggyClient } from './pluggy';
import { createHostLimiter, NET_SERVER_LIMITS, netFetch, parseNetBody, type NetFetchDeps } from './netBridge';
import { netOrigin } from '../src/net/protocol';
import type { ApiOp, ApiResult } from '../src/integrations/apiRoutes';
import { FetchError, redactSecrets, safeFetchText, UnsafeUrlError, type Resolver, type Transport } from './netSafety';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export type { ApiOp, ApiResult } from '../src/integrations/apiRoutes';


export interface CallContext {
  /** Cancelamento pelo cliente (fechou a conexão / cancelou no app). */
  signal: AbortSignal;
  /** Chamada de um dispositivo PAREADO (só existe na versão web com pareamento). */
  remote: boolean;
  /** Corpo JSON, lido sob demanda (a ordem das checagens é a mesma da rota HTTP). */
  readBody: () => Promise<unknown>;
}

/** Limites por rota (S1-SEC-014). Defesa em profundidade contra laços/abuso local — não é autenticação. */
export interface RouteLimit { perMinute: number; concurrent: number }
export const DEFAULT_LIMITS_BY_ROUTE: Record<'chat' | 'linkPreview' | 'pluggy' | 'net', RouteLimit> = {
  chat: { perMinute: 30, concurrent: 3 },
  linkPreview: { perMinute: 60, concurrent: 4 },
  pluggy: { perMinute: 60, concurrent: 2 },
  net: { perMinute: NET_SERVER_LIMITS.perMinute, concurrent: NET_SERVER_LIMITS.concurrent },
};

/** Meu Pluggy no processo local. `client` nulo = não configurado (`problems` diz o que falta, sem valores). */
export interface PluggyDeps {
  client: PluggyClient | null;
  problems: string[];
  /** Permite que dispositivos PAREADOS leiam status/contas/movimentações (padrão: só o computador principal). */
  allowPaired?: boolean;
}

export function resolvePluggy(p: ServiceDeps['pluggy']): PluggyDeps {
  const v = typeof p === 'function' ? p() : p;
  return v ?? { client: null, problems: ['Meu Pluggy não configurado neste servidor.'] };
}

export interface LinkPreviewDeps { transport?: Transport; resolver?: Resolver }

export interface ServiceDeps {
  providers?: Record<ProviderId, Provider>;
  linkPreview?: LinkPreviewDeps;
  log?: (msg: string) => void;
  limits?: Partial<typeof DEFAULT_LIMITS_BY_ROUTE>;
  now?: () => number;
  /** Meu Pluggy. Função = relida a cada chamada (o desktop troca credenciais sem reiniciar). */
  pluggy?: PluggyDeps | null | (() => PluggyDeps | null);
  net?: NetFetchDeps & { perHostPerMinute?: number };
  /** Como orientar quando um provedor de IA não tem chave (web: `.env`; desktop: Configurações). */
  missingKeyHint?: (provider: Provider) => string;
}

/** Entidades de texto do Open Graph, num único passo (sem decodificação dupla: `&amp;lt;` → `&lt;`, não `<`). */
export function decodeEntities(s: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|#39|#(\d{1,7}));/g, (m, name: string, num: string | undefined) => {
    if (num !== undefined) { const c = Number(num); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''; }
    return named[name] ?? m;
  });
}

function meta(html: string, names: string[]): string {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = re.exec(html);
    if (m) return decodeEntities((m[1] ?? m[2] ?? '').trim());
  }
  return '';
}

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

/** Janela deslizante de 60 s + contador de chamadas em andamento. */
export function createLimiter(limit: RouteLimit, now: () => number) {
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

class Limited extends HttpError {
  constructor(message: string, public retryAfter: number) { super(429, message); }
}

/** Erro → resposta (mesmas regras da API HTTP: 5xx genérico, sem segredos, `code` quando houver). */
export function errorResult(e: unknown, log: (m: string) => void, label: string): ApiResult {
  const err = (e instanceof Error ? e : new Error(String(e))) as Error & { status?: number };
  const status = err instanceof HttpError || err instanceof UnsafeUrlError || err instanceof FetchError || err instanceof PairingError ? err.status : typeof err.status === 'number' ? err.status : 500;
  const message = redactSecrets(err.message || 'Erro interno.');
  if (status >= 500) log(`[api] ${label}: ${message}${err instanceof PluggyError && err.upstream ? ` (${err.upstream})` : ''}`);
  const code = err instanceof HttpError ? err.code : err instanceof PluggyError ? err.code : undefined;
  const retryAfter = err instanceof Limited ? err.retryAfter : err instanceof PluggyError && err.retryAfter ? err.retryAfter : undefined;
  return { status, body: { error: status >= 500 && !(err instanceof FetchError) && !err.status ? 'Erro interno.' : message, ...(code ? { code } : {}) }, ...(retryAfter ? { retryAfter } : {}) };
}

export function createApiService(deps: ServiceDeps = {}) {
  const providers = deps.providers ?? PROVIDERS;
  const log = deps.log ?? ((m: string) => console.error(m));
  const now = deps.now ?? (() => Date.now());
  const missingKeyHint = deps.missingKeyHint ?? ((p: Provider) => `defina ${p.envKey} no .env do servidor`);
  const limiters = {
    chat: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.chat, ...deps.limits?.chat }, now),
    linkPreview: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.linkPreview, ...deps.limits?.linkPreview }, now),
    pluggy: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.pluggy, ...deps.limits?.pluggy }, now),
    net: createLimiter({ ...DEFAULT_LIMITS_BY_ROUTE.net, ...deps.limits?.net }, now),
  };
  const netHostOk = createHostLimiter(deps.net?.perHostPerMinute ?? NET_SERVER_LIMITS.perHostPerMinute, now);
  const guarded = async <T,>(name: keyof typeof limiters, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const slot = limiters[name].acquire();
    if (!slot.ok) throw new Limited(slot.message, slot.retryAfter);
    if (signal?.aborted) { slot.release(); throw new HttpError(499, 'Operação cancelada.'); }
    try { return await fn(); } finally { slot.release(); }
  };
  const pluggyDeps = (): PluggyDeps => resolvePluggy(deps.pluggy);
  const ok = (body: unknown, status = 200): ApiResult => ({ status, body });

  async function run(op: ApiOp, ctx: CallContext): Promise<ApiResult> {
    switch (op.op) {
      case 'health':
        return ok({ ok: true });
      case 'ai.providers':
        return ok({ providers: Object.values(providers).map((p) => ({ id: p.id, name: p.name, configured: p.configured(), defaultModel: p.defaultModel() })) });
      case 'ai.chat': {
        const body = validateChat(await ctx.readBody());
        const provider = providers[body.provider];
        if (!provider.configured()) throw new HttpError(400, `${provider.name} não configurado: ${missingKeyHint(provider)}.`);
        return ok(await guarded('chat', () => provider.chat(body, ctx.signal), ctx.signal));
      }
      case 'linkPreview': {
        const body = (await ctx.readBody()) as { url?: unknown } | null;
        if (!body || typeof body.url !== 'string' || body.url.length > 2048) throw new HttpError(400, 'URL inválida.');
        return ok(await guarded('linkPreview', () => linkPreview(body.url as string, deps.linkPreview)));
      }
      case 'pluggy.status':
      case 'pluggy.accounts':
      case 'pluggy.transactions':
      case 'pluggy.other': {
        const pl = pluggyDeps();
        // Dados bancários: por padrão só o computador principal consulta (o pareado guardaria cópia própria).
        if (ctx.remote && !pl.allowPaired) throw new HttpError(403, 'O Meu Pluggy só pode ser consultado no computador principal.', 'local_only');
        if (op.op === 'pluggy.status' && !pl.client) return ok({ configured: false, problems: pl.problems.slice(0, 10) });
        const client = pl.client;
        if (!client) throw new HttpError(503, pl.problems[0] ?? 'Meu Pluggy não configurado.', 'not_configured');
        if (op.op === 'pluggy.other') throw new HttpError(404, 'Rota não encontrada.');
        if (op.op === 'pluggy.status') {
          const items = await guarded('pluggy', () => client.status(ctx.signal));
          return ok({ configured: true, environment: 'production', readOnly: true, items });
        }
        const clean = (v: unknown) => (typeof v === 'string' && v.length <= 100 ? v : '');
        const itemId = clean(op.itemId);
        if (!client.isConfiguredItem(itemId)) throw new HttpError(404, 'Item não configurado em PLUGGY_ITEM_IDS.', 'not_found');
        if (op.op === 'pluggy.accounts') return ok({ accounts: await guarded('pluggy', () => client.accounts(itemId, ctx.signal)) });
        return ok(await guarded('pluggy', () => client.transactions(itemId, clean(op.accountId), { from: clean(op.from), to: clean(op.to) }, ctx.signal)));
      }
      case 'net.status':
      case 'net.fetch':
      case 'net.other': {
        // H2: só o computador principal (um pareado usaria a rede e o IP desta máquina). Nada do pedido é repassado.
        if (ctx.remote) throw new HttpError(403, 'O acesso à rede dos blocos HTML só funciona no computador principal.', 'local_only');
        if (op.op === 'net.other') throw new HttpError(404, 'Rota não encontrada.');
        if (op.op === 'net.status') return ok({ available: true, version: 1, limits: { perMinute: NET_SERVER_LIMITS.perMinute, perHostPerMinute: deps.net?.perHostPerMinute ?? NET_SERVER_LIMITS.perHostPerMinute, maxBytes: NET_SERVER_LIMITS.maxBytes } });
        const parsed = parseNetBody(await ctx.readBody());
        if (!parsed.ok) return ok(parsed.outcome, 400);
        const slot = limiters.net.acquire();
        if (!slot.ok) return { status: 429, body: { ok: false, error: { code: 'rate_limited', message: slot.message } }, retryAfter: slot.retryAfter };
        try {
          if (!netHostOk(netOrigin(parsed.req.url))) return ok({ ok: false, error: { code: 'rate_limited', message: 'Limite de consultas por minuto para este domínio atingido.' } }, 429);
          return ok(await netFetch(parsed.req, deps.net ?? {}, ctx.signal));
        } finally {
          slot.release();
        }
      }
    }
  }

  return {
    async call(op: ApiOp, ctx: CallContext): Promise<ApiResult> {
      try {
        return await run(op, ctx);
      } catch (e) {
        return errorResult(e, log, op.op);
      }
    },
  };
}
export type ApiService = ReturnType<typeof createApiService>;
