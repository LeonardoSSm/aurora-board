/**
 * H2-B — transporte HTTP autorizado dos widgets HTML (rota `POST /api/net/fetch` do servidor local).
 *
 * Este módulo impõe as regras de REDE sozinho, sem confiar no frontend (que só repete as checagens estáticas):
 * - somente GET, `https:` e porta 443; sem credenciais na URL; sem IP literal; sem nomes de rede local;
 * - DNS resolvido DENTRO da conexão (`lookup` seguro de netSafety) e TODOS os endereços conferidos contra a lista
 *   de bloqueio (loopback, privados, link-local, CGNAT, multicast, reservados, metadados de nuvem, IPv4 mapeado em
 *   IPv6, NAT64, 6to4, Teredo…) — e o endereço EFETIVAMENTE conectado é conferido de novo no socket;
 * - conexão nova por consulta (sem pool: um socket validado não é reaproveitado para outro nome);
 * - redirecionamentos NÃO são seguidos na v1 (`redirect_blocked`);
 * - tempo total (conexão + cabeçalhos + corpo), limite de bytes (inclusive `content-length` declarado), só
 *   `identity` (sem descompressão), só JSON/texto UTF-8 (binário e outros charsets recusados), JSON com
 *   profundidade limitada;
 * - cabeçalhos enviados definidos AQUI (Accept, User-Agent, Accept-Encoding): nada do navegador é repassado —
 *   nem cookies, nem Authorization, nem o token de dispositivo pareado;
 * - erros sem segredos e sem a URL; nenhum log por consulta (só falhas internas, sem URL).
 *
 * A autorização do USUÁRIO é conferida no host (origem do app) — ver docs/HTML_NETWORK_BRIDGE.md.
 */
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { NET_LIMITS, validateNetUrl, type NetError, type NetOutcome, type NetRequest, type NetResponseType } from '../src/net/protocol';
import { isBlockedAddress, makeSafeLookup, UnsafeUrlError, type Resolver } from './netSafety';

export const NET_SERVER_LIMITS = {
  maxBytes: NET_LIMITS.maxResponseBytes,
  maxJsonDepth: 64,
  /** Consultas por minuto, somando todos os blocos (o host já limita 30/min por bloco). */
  perMinute: 120,
  concurrent: 6,
  /** Por domínio de destino, por minuto. */
  perHostPerMinute: 60,
};

export const NET_USER_AGENT = 'AuroraBoard-NetBridge/1 (+https://github.com/LeonardoSSm/aurora-board)';

/** Resposta crua de UMA requisição (sem seguir redirecionamentos). */
export interface NetRawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  /** Endereço remoto efetivamente conectado (conferido de novo aqui). */
  remoteAddress?: string;
  close(): void;
}

export type NetTransportFn = (url: URL, opts: { lookup: ReturnType<typeof makeSafeLookup>; signal: AbortSignal; headers: Record<string, string> }) => Promise<NetRawResponse>;

class BlockedSocket extends UnsafeUrlError {}

/** Transporte real: https.request com lookup seguro, sem agente (conexão nova), confere o IP conectado. */
export const httpsNetTransport: NetTransportFn = (url, { lookup, signal, headers }) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, lookup: lookup as never, signal, agent: false, maxHeaderSize: 32 * 1024 }, (res: IncomingMessage) => {
      const addr = res.socket?.remoteAddress;
      if (!addr || isBlockedAddress(addr)) { res.destroy(); req.destroy(); return reject(new BlockedSocket('Endereço de rede local ou reservado.')); }
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, remoteAddress: addr, close: () => res.destroy() });
    });
    // Defesa em profundidade: o lookup já recusou endereços proibidos; o socket confirma o IP real conectado.
    req.on('socket', (s: Socket) => {
      s.once('connect', () => { if (!s.remoteAddress || isBlockedAddress(s.remoteAddress)) req.destroy(new BlockedSocket('Endereço de rede local ou reservado.')); });
    });
    req.on('error', reject);
    req.end();
  });

export interface NetFetchDeps {
  transport?: NetTransportFn;
  resolver?: Resolver;
  now?: () => number;
}

const fail = (code: NetError['code'], message: string, extra: Partial<NetError> = {}): NetOutcome => ({ ok: false, error: { code, message, ...extra } });

/** Corpo da rota (não confiável): só as chaves do contrato. */
export function parseNetBody(body: unknown): { ok: true; req: NetRequest } | { ok: false; outcome: NetOutcome } {
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o) return { ok: false, outcome: fail('invalid_request', 'Requisição inválida.') };
  const extra = Object.keys(o).filter((k) => !['url', 'method', 'responseType', 'timeoutMs'].includes(k));
  if (extra.some((k) => /headers|cookie|credential|auth/i.test(k))) return { ok: false, outcome: fail('headers_not_allowed', 'Cabeçalhos e credenciais não podem ser definidos: o servidor usa cabeçalhos fixos e seguros.') };
  if (extra.length) return { ok: false, outcome: fail('invalid_request', 'Campos não suportados na requisição.') };
  if (o.method !== undefined && o.method !== 'GET') return { ok: false, outcome: fail('method_not_allowed', 'Somente GET é permitido.') };
  const responseType: NetResponseType = o.responseType === 'text' ? 'text' : o.responseType === undefined || o.responseType === 'json' ? 'json' : ('' as NetResponseType);
  if (!responseType) return { ok: false, outcome: fail('invalid_request', 'responseType deve ser "json" ou "text".') };
  if (typeof o.url !== 'string') return { ok: false, outcome: fail('invalid_url', 'URL inválida.') };
  const v = validateNetUrl(o.url);
  if (!v.ok) return { ok: false, outcome: { ok: false, error: v.error } };
  const t = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) ? o.timeoutMs : NET_LIMITS.defaultTimeoutMs;
  return { ok: true, req: { url: v.url.href, method: 'GET', responseType, timeoutMs: Math.round(Math.min(NET_LIMITS.maxTimeoutMs, Math.max(NET_LIMITS.minTimeoutMs, t))) } };
}

const JSON_TYPES = /^(application\/(json|[a-z0-9.+-]+\+json)|text\/json)$/;
const TEXT_TYPES = /^(text\/(plain|csv|tab-separated-values|markdown|xml|html|calendar|json)|application\/(xml|[a-z0-9.+-]+\+xml|json|[a-z0-9.+-]+\+json|x-ndjson|ndjson))$/;

function headerOf(h: NetRawResponse['headers'], k: string): string {
  const v = h[k];
  return (Array.isArray(v) ? v[0] : v ?? '').toString();
}

/** Profundidade de um valor JSON sem recursão (estruturas aninhadas demais não chegam ao iframe). */
function jsonDepth(v: unknown, max: number): number {
  const stack: [unknown, number][] = [[v, 1]];
  let deepest = 0;
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > deepest) deepest = d;
    if (deepest > max) return deepest;
    if (x && typeof x === 'object') for (const c of Object.values(x as object)) if (c && typeof c === 'object') stack.push([c, d + 1]);
  }
  return deepest;
}

/**
 * Executa UMA consulta autorizada. Nunca lança: devolve sucesso ou erro estruturado. `signal` cancela (o cliente
 * fechou a conexão: desmontagem, revogação ou aurora:abort no app).
 */
export async function netFetch(req: NetRequest, deps: NetFetchDeps = {}, signal?: AbortSignal): Promise<NetOutcome> {
  const transport = deps.transport ?? httpsNetTransport;
  const lookup = makeSafeLookup(deps.resolver);
  const v = validateNetUrl(req.url); // de novo: o servidor não confia em quem chamou
  if (!v.ok) return { ok: false, error: v.error };
  const url = v.url;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, req.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const accept = req.responseType === 'json' ? 'application/json, application/*+json;q=0.9, text/json;q=0.8' : 'text/plain, text/*;q=0.9, application/json;q=0.8, application/xml;q=0.7';
  let res: NetRawResponse | null = null;
  try {
    try {
      res = await raceAbort(transport(url, { lookup, signal: ctrl.signal, headers: { accept, 'accept-encoding': 'identity', 'user-agent': NET_USER_AGENT } }), ctrl.signal);
    } catch (e) {
      if (timedOut) return fail('timeout', `Tempo esgotado (${Math.round(req.timeoutMs / 1000)} s).`);
      if (ctrl.signal.aborted) return fail('aborted', 'Consulta cancelada.');
      if (e instanceof BlockedSocket) return fail('blocked_address', 'O domínio aponta para um endereço de rede local ou reservado.');
      if (e instanceof UnsafeUrlError) {
        return /não encontrado|resolver/i.test(e.message) ? fail('dns_error', 'Não foi possível resolver o domínio.') : fail('blocked_address', 'O domínio aponta para um endereço de rede local ou reservado.');
      }
      return fail('network_error', 'Não foi possível conectar à API.');
    }
    if (res.remoteAddress && isBlockedAddress(res.remoteAddress)) return fail('blocked_address', 'O domínio aponta para um endereço de rede local ou reservado.');
    const status = res.status;
    if (status >= 300 && status < 400) return fail('redirect_blocked', `A API redirecionou (${status}); redirecionamentos não são seguidos nesta versão. Use o endereço final.`, { status });
    const encoding = headerOf(res.headers, 'content-encoding').trim().toLowerCase();
    if (encoding && encoding !== 'identity') return fail('invalid_encoding', `Resposta comprimida (${encoding.slice(0, 20)}) não suportada.`);
    const declared = Number(headerOf(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > NET_SERVER_LIMITS.maxBytes) return fail('response_too_large', `Resposta com mais de ${Math.round(NET_SERVER_LIMITS.maxBytes / 1024)} KB.`);
    const ctRaw = headerOf(res.headers, 'content-type').toLowerCase();
    const [mimeRaw, ...params] = ctRaw.split(';');
    const mime = mimeRaw.trim();
    const charset = params.map((p) => p.trim()).find((p) => p.startsWith('charset='))?.slice(8).replace(/"/g, '').trim();
    if (charset && charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii') return fail('invalid_encoding', `Codificação ${charset.slice(0, 20)} não suportada (só UTF-8).`);
    if (mime && !(req.responseType === 'json' ? JSON_TYPES.test(mime) || (status >= 400 && TEXT_TYPES.test(mime)) : TEXT_TYPES.test(mime))) {
      return fail('unsupported_content_type', `Tipo de conteúdo não permitido: ${mime.slice(0, 60)}.`, status >= 400 ? { status } : {});
    }
    // Corpo com limite (o tempo total continua valendo).
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > NET_SERVER_LIMITS.maxBytes) return fail('response_too_large', `Resposta com mais de ${Math.round(NET_SERVER_LIMITS.maxBytes / 1024)} KB.`);
        chunks.push(chunk);
        if (ctrl.signal.aborted) break;
      }
    } catch {
      if (!ctrl.signal.aborted) return fail('network_error', 'A conexão caiu durante a resposta.');
    }
    if (timedOut) return fail('timeout', `Tempo esgotado (${Math.round(req.timeoutMs / 1000)} s).`);
    if (ctrl.signal.aborted) return fail('aborted', 'Consulta cancelada.');
    const buf = Buffer.concat(chunks);
    if (buf.includes(0)) return fail('unsupported_content_type', 'Conteúdo binário não é permitido.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf); } catch { return fail('invalid_encoding', 'A resposta não é texto UTF-8 válido.'); }
    const isError = status < 200 || status >= 300;
    let data: unknown = null;
    const wantsJson = req.responseType === 'json' && (!mime || JSON_TYPES.test(mime));
    if (wantsJson && text.trim()) {
      try { data = JSON.parse(text); } catch {
        if (!isError) return fail('invalid_json', 'A resposta não é JSON válido.');
      }
      if (jsonDepth(data, NET_SERVER_LIMITS.maxJsonDepth) > NET_SERVER_LIMITS.maxJsonDepth) return fail('invalid_json', `JSON com mais de ${NET_SERVER_LIMITS.maxJsonDepth} níveis.`);
    }
    if (isError) {
      return fail('http_error', `A API respondeu ${status}.`, { status, ...(wantsJson && data !== null ? { data } : { text: text.slice(0, 64 * 1024) }) });
    }
    return { ok: true, result: { status, url: url.href, contentType: mime, bytes: buf.length, responseType: req.responseType, ...(req.responseType === 'json' ? { data } : { text }) } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    res?.close();
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** Limite por domínio de destino (janela de 60 s). */
export function createHostLimiter(perMinute: number, now: () => number) {
  const hits = new Map<string, number[]>();
  return (host: string): boolean => {
    const t = now();
    const list = (hits.get(host) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= perMinute) { hits.set(host, list); return false; }
    list.push(t);
    hits.set(host, list);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
    return true;
  };
}
