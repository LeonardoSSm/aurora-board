/**
 * Segurança de rede para buscas iniciadas pelo servidor (pré-visualização de links).
 *
 * Proteções contra SSRF:
 * - só http/https, portas 80/443, sem credenciais na URL;
 * - bloqueio de endereços privados, locais, reservados, multicast, link-local, CGNAT,
 *   IPv4 mapeado em IPv6, NAT64 e afins (net.BlockList);
 * - o DNS é validado DENTRO da conexão (opção `lookup` do http/https), então o IP checado é
 *   exatamente o IP conectado — não há janela para DNS rebinding entre checar e conectar;
 * - redirecionamentos são seguidos manualmente, cada destino é validado de novo, com limite;
 * - timeout total e limite de bytes lidos.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv6
for (const [net, prefix] of [
  // ::/96 cobre os “IPv4 compatíveis” obsoletos (::7f00:1 = 127.0.0.1); 3fff::/20 documentação; 5f00::/16 SRv6.
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['3fff::', 20], ['5f00::', 16], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** IPv4 embutido num IPv6 mapeado (::ffff:a.b.c.d ou ::ffff:7f00:1). */
function mappedIPv4(ip: string): string | null {
  const m = /^::ffff:(?:0:)?(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1];
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isBlockedAddress(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const v = isIP(clean);
  if (!v) return true; // não é IP válido: trata como bloqueado
  if (v === 6) {
    const m = mappedIPv4(clean);
    if (m) return true; // qualquer IPv4 mapeado é recusado (evita contornos)
    return blocked.check(clean, 'ipv6');
  }
  return blocked.check(clean, 'ipv4');
}

export class UnsafeUrlError extends Error {
  status = 400;
}

/** Valida a URL antes de qualquer conexão. */
export function validateUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new UnsafeUrlError('URL inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('Apenas http/https.');
  if (url.username || url.password) throw new UnsafeUrlError('URLs com credenciais não são permitidas.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) throw new UnsafeUrlError('Apenas as portas 80 e 443 são permitidas.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new UnsafeUrlError('Domínio inválido.');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('Endereços de rede local ou reservados não são permitidos.');
  } else {
    const lower = host.toLowerCase().replace(/\.$/, ''); // "localhost." (FQDN com ponto final)
    if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal') || !lower.includes('.'))
      throw new UnsafeUrlError('Nomes de rede local não são permitidos.');
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/**
 * `lookup` compatível com http.request: resolve e REJEITA se qualquer endereço for proibido.
 * Como é usado pela própria conexão, o IP validado é o IP conectado.
 */
export function makeSafeLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: unknown, callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    resolver(hostname)
      .then((addrs) => {
        if (!addrs.length) throw new UnsafeUrlError('Domínio não encontrado.');
        if (addrs.some((a) => isBlockedAddress(a.address))) throw new UnsafeUrlError('O domínio aponta para um endereço de rede local ou reservado.');
        if (wantAll) callback(null, addrs);
        else callback(null, addrs[0].address, addrs[0].family);
      })
      .catch((e: Error) => callback(e instanceof UnsafeUrlError ? e : new UnsafeUrlError('Falha ao resolver o domínio.')));
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  close(): void;
}

/** Transporte (injetável nos testes): faz UMA requisição GET, sem seguir redirecionamentos. */
export type Transport = (url: URL, opts: { lookup: ReturnType<typeof makeSafeLookup>; signal: AbortSignal; headers: Record<string, string> }) => Promise<RawResponse>;

export const nodeTransport: Transport = (url, { lookup, signal, headers }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers, lookup: lookup as never, signal, timeout: 8000 }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, close: () => res.destroy() });
    });
    req.on('timeout', () => req.destroy(new UnsafeUrlError('Tempo esgotado.')));
    req.on('error', reject);
    req.end();
  });

export interface FetchLimits {
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: FetchLimits = { maxRedirects: 3, timeoutMs: 8000, maxBytes: 512 * 1024 };

export class FetchError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** GET seguro com redirecionamentos validados e limites. Retorna o texto (até `maxBytes`). */
export async function safeFetchText(
  rawUrl: string,
  deps: { transport?: Transport; resolver?: Resolver } = {},
  limits: FetchLimits = DEFAULT_LIMITS,
): Promise<{ url: URL; status: number; contentType: string; text: string; truncated: boolean }> {
  const transport = deps.transport ?? nodeTransport;
  const lookup = makeSafeLookup(deps.resolver);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs);
  try {
    let url = validateUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      let res: RawResponse;
      try {
        res = await raceAbort(transport(url, { lookup, signal: ctrl.signal, headers: { 'user-agent': 'AuroraBoard-LinkPreview/1.1', accept: 'text/html,application/xhtml+xml' } }), ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError('Tempo esgotado ao buscar o link.', 504);
        if (e instanceof UnsafeUrlError) throw e;
        throw new FetchError('Não foi possível conectar ao site.');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.close();
        const loc = res.headers.location;
        if (!loc || Array.isArray(loc)) throw new FetchError('Redirecionamento inválido.');
        if (hop >= limits.maxRedirects) throw new FetchError('Redirecionamentos demais.');
        url = validateUrl(loc, url); // cada destino é validado de novo
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.close();
        throw new FetchError(`O site respondeu ${res.status}.`);
      }
      const contentType = String(res.headers['content-type'] ?? '');
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > limits.maxBytes) { chunks.push(chunk.subarray(0, chunk.length - (size - limits.maxBytes))); truncated = true; break; }
          chunks.push(chunk);
          if (ctrl.signal.aborted) throw new FetchError('Tempo esgotado ao buscar o link.', 504);
        }
      } finally {
        res.close();
      }
      if (ctrl.signal.aborted) throw new FetchError('Tempo esgotado ao buscar o link.', 504);
      return { url, status: res.status, contentType, text: Buffer.concat(chunks).toString('utf8'), truncated };
    }
  } finally {
    clearTimeout(timer);
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

/* ------------------------------------------------------------------ */
/* Proteção do próprio servidor local                                  */
/* ------------------------------------------------------------------ */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Host local (anti DNS rebinding): o navegador envia o nome digitado, não o IP. */
export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(name);
}

/** Origem permitida: ausente (curl, mesma origem via proxy em alguns navegadores) ou local. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Endereço do par TCP é loopback? Defesa em profundidade (S1-SEC-013): o bind já é 127.0.0.1, mas se alguém
 * alterar o bind, publicar a porta (Docker, túnel) ou expuser o proxy do Vite (`--host`), clientes de fora
 * continuam recusados — o cabeçalho Host pode ser forjado, o endereço do socket não.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Remove trechos parecidos com chaves de API de mensagens que vão para logs ou para o cliente. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_*\-]{6,}/g, '[chave-removida]')
    .replace(/\bsk-ant-[A-Za-z0-9_*\-]{6,}/g, '[chave-removida]')
    .replace(/\bAIza[0-9A-Za-z_*\-]{10,}/g, '[chave-removida]')
    .replace(/(api[_-]?key["'=:\s]+)[^\s"',]+/gi, '$1[chave-removida]');
}
