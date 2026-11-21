/**
 * H2-B — transporte HTTP seguro do servidor local (`/api/net/fetch`). Nenhuma conexão externa: DNS e transporte
 * são simulados (o transporte chama o `lookup` seguro como uma conexão real faria). O único teste com o transporte
 * real (https.request) usa um DNS injetado que aponta para loopback e confere que NADA conecta.
 */
import { createServer, request, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../server/app';
import { httpsNetTransport, netFetch, NET_SERVER_LIMITS, NET_USER_AGENT, parseNetBody, type NetRawResponse, type NetTransportFn } from '../../server/netBridge';
import { isBlockedAddress, type Resolver } from '../../server/netSafety';
import { PairingStore } from '../../server/pairing';
import type { NetRequest } from '../../src/net/protocol';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

const PUBLIC = '93.184.216.34';
const req = (url = 'https://api.exemplo.com.br/x', extra: Partial<NetRequest> = {}): NetRequest => ({ url, method: 'GET', responseType: 'json', timeoutMs: 5000, ...extra });

function raw(status: number, headers: Record<string, string>, body: string | Buffer | Buffer[] = '', remoteAddress = PUBLIC): NetRawResponse {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
  return { status, headers, body: Readable.from(chunks), remoteAddress, close: () => undefined };
}

/** DNS + transporte simulados. `routes` por URL; a “conexão” usa o lookup seguro (DNS dentro da conexão). */
function fakeNet(routes: Record<string, (h: Record<string, string>) => NetRawResponse | Promise<NetRawResponse>>, dns: Record<string, string[] | (() => string[])> = {}) {
  const connected: string[] = [];
  const sent: Record<string, string>[] = [];
  let lookups = 0;
  const resolver: Resolver = async (host) => {
    lookups++;
    const r = dns[host] ?? [PUBLIC];
    const list = typeof r === 'function' ? r() : r;
    if (!list.length) throw new Error('ENOTFOUND');
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const transport: NetTransportFn = (url, { lookup, headers, signal }) =>
    new Promise((resolve, reject) => {
      lookup(url.hostname, { all: true }, (err) => {
        if (err) return reject(err);
        connected.push(url.href);
        sent.push(headers);
        const route = routes[url.href];
        if (!route) return reject(new Error('ECONNREFUSED'));
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        Promise.resolve(route(headers)).then(resolve, reject);
      });
    });
  return { deps: { transport, resolver }, connected, sent, lookups: () => lookups };
}

const json = (v: unknown, status = 200, extra: Record<string, string> = {}) => () => raw(status, { 'content-type': 'application/json; charset=utf-8', ...extra }, JSON.stringify(v));
const U = 'https://api.exemplo.com.br/x';

describe('corpo da rota', () => {
  it('recusa cabeçalhos, credenciais, métodos de escrita, esquemas e campos extras', () => {
    const code = (b: unknown) => { const r = parseNetBody(b); return r.ok ? 'ok' : (r.outcome as { error: { code: string } }).error.code; };
    expect(code({ url: U })).toBe('ok');
    expect(code({ url: U, headers: { cookie: 'a=b' } })).toBe('headers_not_allowed');
    expect(code({ url: U, authorization: 'Bearer x' })).toBe('headers_not_allowed');
    expect(code({ url: U, method: 'POST' })).toBe('method_not_allowed');
    expect(code({ url: U, body: 'x' })).toBe('invalid_request');
    expect(code({ url: 'http://api.exemplo.com.br/' })).toBe('blocked_url');
    expect(code({ url: 'https://127.0.0.1/' })).toBe('blocked_url');
    expect(code({ url: 'https://localhost/' })).toBe('blocked_url');
    expect(code({ url: 'https://[::1]/' })).toBe('blocked_url');
    expect(code({ url: 'file:///etc/passwd' })).toBe('blocked_url');
    expect(code([])).toBe('invalid_request');
  });
});

describe('netFetch — SSRF e DNS', () => {
  const BLOCKED = ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::', '2001::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '2001:db8::1'];
  it.each(BLOCKED)('domínio que resolve para %s é recusado ANTES de conectar', async (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
    const n = fakeNet({ [U]: json({ ok: 1 }) }, { 'api.exemplo.com.br': [ip] });
    const r = await netFetch(req(), n.deps);
    expect(r).toMatchObject({ ok: false, error: { code: 'blocked_address' } });
    expect(n.connected).toEqual([]);
  });

  it('qualquer endereço proibido na lista de resolução recusa (sem “escolher o bom”)', async () => {
    const n = fakeNet({ [U]: json({ ok: 1 }) }, { 'api.exemplo.com.br': [PUBLIC, '10.0.0.1'] });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'blocked_address' } });
    expect(n.connected).toEqual([]);
  });

  it('DNS rebinding: cada conexão resolve e valida de novo (1ª pública passa, 2ª privada é recusada)', async () => {
    let calls = 0;
    const n = fakeNet({ [U]: json({ ok: 1 }) }, { 'api.exemplo.com.br': () => (++calls === 1 ? [PUBLIC] : ['127.0.0.1']) });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: true });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'blocked_address' } });
    expect(n.connected).toHaveLength(1);
  });

  it('endereço efetivamente conectado proibido (transporte relata) é recusado', async () => {
    const n = fakeNet({ [U]: () => raw(200, { 'content-type': 'application/json' }, '{"x":1}', '::ffff:10.0.0.1') });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'blocked_address' } });
  });

  it('domínio inexistente → dns_error', async () => {
    const n = fakeNet({}, { 'api.exemplo.com.br': [] });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'dns_error' } });
  });

  it('redirecionamento NÃO é seguido (nem para host autorizado, nem para interno)', async () => {
    const n = fakeNet({ [U]: () => raw(302, { location: 'https://169.254.169.254/latest/meta-data' }) });
    const r = await netFetch(req(), n.deps);
    expect(r).toMatchObject({ ok: false, error: { code: 'redirect_blocked', status: 302 } });
    expect(JSON.stringify(r)).not.toContain('169.254');
    expect(n.connected).toEqual([U]);
  });

  it('transporte real (https.request): DNS injetado → loopback não conecta em nada', async () => {
    let connections = 0;
    const tcp = createTcpServer(() => { connections++; });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    try {
      const resolver: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
      const r = await netFetch(req('https://api.exemplo.com.br/'), { transport: httpsNetTransport, resolver });
      expect(r).toMatchObject({ ok: false, error: { code: 'blocked_address' } });
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });
});

describe('netFetch — respostas', () => {
  it('JSON e texto UTF-8; só cabeçalhos fixos e seguros são enviados', async () => {
    const T = 'https://api.exemplo.com.br/t';
    const n = fakeNet({ [U]: json({ stargazers_count: 7, nome: 'ação' }), [T]: () => raw(200, { 'content-type': 'text/plain; charset=utf-8' }, '﻿olá mundo') });
    expect(await netFetch(req(), n.deps)).toEqual({ ok: true, result: { status: 200, url: U, contentType: 'application/json', bytes: Buffer.byteLength(JSON.stringify({ stargazers_count: 7, nome: 'ação' })), responseType: 'json', data: { stargazers_count: 7, nome: 'ação' } } });
    expect(await netFetch(req(T, { responseType: 'text' }), n.deps)).toMatchObject({ ok: true, result: { text: 'olá mundo' } });
    for (const h of n.sent) {
      expect(Object.keys(h).sort()).toEqual(['accept', 'accept-encoding', 'user-agent']);
      expect(h['accept-encoding']).toBe('identity');
      expect(h['user-agent']).toBe(NET_USER_AGENT);
    }
  });

  it('erros da API: 404/500 estruturados com status e corpo; JSON inválido; resposta vazia', async () => {
    const E = 'https://api.exemplo.com.br/e', B = 'https://api.exemplo.com.br/b', V = 'https://api.exemplo.com.br/v', H = 'https://api.exemplo.com.br/h';
    const n = fakeNet({ [U]: json({ message: 'Not Found' }, 404), [E]: () => raw(500, { 'content-type': 'text/html' }, '<h1>erro</h1>'), [B]: () => raw(200, { 'content-type': 'application/json' }, '{quebrado'), [V]: () => raw(204, {}, ''), [H]: () => raw(200, { 'content-type': 'application/json' }, '') });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'http_error', status: 404, data: { message: 'Not Found' } } });
    expect(await netFetch(req(E), n.deps)).toMatchObject({ ok: false, error: { code: 'http_error', status: 500, text: '<h1>erro</h1>' } });
    expect(await netFetch(req(B), n.deps)).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    expect(await netFetch(req(V), n.deps)).toMatchObject({ ok: true, result: { status: 204, data: null, bytes: 0 } });
    expect(await netFetch(req(H), n.deps)).toMatchObject({ ok: true, result: { data: null } });
  });

  it('respostas gigantes: content-length declarado e corpo em fluxo acima do limite', async () => {
    const S = 'https://api.exemplo.com.br/s';
    const big = Buffer.alloc(64 * 1024, 0x61);
    const n = fakeNet({
      [U]: () => raw(200, { 'content-type': 'application/json', 'content-length': String(NET_SERVER_LIMITS.maxBytes + 1) }, '{}'),
      [S]: () => raw(200, { 'content-type': 'text/plain' }, Array.from({ length: 20 }, () => big)),
    });
    expect(await netFetch(req(), n.deps)).toMatchObject({ ok: false, error: { code: 'response_too_large' } });
    expect(await netFetch(req(S, { responseType: 'text' }), n.deps)).toMatchObject({ ok: false, error: { code: 'response_too_large' } });
  });

  it('binário, outros charsets, UTF-8 inválido, compressão e JSON profundo são recusados', async () => {
    const r = (p: string) => `https://api.exemplo.com.br/${p}`;
    const n = fakeNet({
      [r('png')]: () => raw(200, { 'content-type': 'image/png' }, Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      [r('oct')]: () => raw(200, { 'content-type': 'application/octet-stream' }, 'x'),
      [r('nul')]: () => raw(200, { 'content-type': 'text/plain' }, Buffer.from([0x61, 0x00, 0x62])),
      [r('lat')]: () => raw(200, { 'content-type': 'text/plain; charset=iso-8859-1' }, 'x'),
      [r('bad')]: () => raw(200, { 'content-type': 'text/plain' }, Buffer.from([0xc3, 0x28])),
      [r('gz')]: () => raw(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'x'),
      [r('deep')]: () => raw(200, { 'content-type': 'application/json' }, '['.repeat(200) + ']'.repeat(200)),
      [r('js')]: () => raw(200, { 'content-type': 'application/javascript' }, 'alert(1)'),
    });
    const code = async (p: string, t: 'json' | 'text' = 'text') => ((await netFetch(req(r(p), { responseType: t }), n.deps)) as { error?: { code: string } }).error?.code;
    expect(await code('png')).toBe('unsupported_content_type');
    expect(await code('oct')).toBe('unsupported_content_type');
    expect(await code('nul')).toBe('unsupported_content_type');
    expect(await code('lat')).toBe('invalid_encoding');
    expect(await code('bad')).toBe('invalid_encoding');
    expect(await code('gz', 'json')).toBe('invalid_encoding');
    expect(await code('deep', 'json')).toBe('invalid_json');
    expect(await code('js')).toBe('unsupported_content_type');
  });

  it('tempo total (conexão e corpo lento) e cancelamento pelo cliente', async () => {
    const slowBody = 'https://api.exemplo.com.br/slow';
    const n = fakeNet({
      [U]: () => new Promise<NetRawResponse>(() => undefined),
      [slowBody]: () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: (async function* () { yield Buffer.from('a'); await new Promise((r) => setTimeout(r, 500)); yield Buffer.from('b'); })(), close: () => undefined }),
    });
    expect(await netFetch(req(U, { timeoutMs: 60 }), n.deps)).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(await netFetch(req(slowBody, { timeoutMs: 100, responseType: 'text' }), n.deps)).toMatchObject({ ok: false, error: { code: 'timeout' } });
    const ctrl = new AbortController();
    const p = netFetch(req(U, { timeoutMs: 5000 }), n.deps, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    expect(await p).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });
});

/* ------------------------------------------------------------------ rota HTTP */

async function start(deps: AppDeps) {
  const s = createServer(createApp({ log: () => undefined, ...deps }));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
function call(base: string, body: unknown, headers: Record<string, string> = {}, path = '/api/net/fetch'): Promise<{ status: number; json: any }> {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const r = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('rota /api/net/fetch', () => {
  it('consulta autorizada pelo computador principal; status da rota', async () => {
    const n = fakeNet({ [U]: json({ stargazers_count: 7 }) });
    const base = await start({ net: n.deps });
    const r = await call(base, { url: U, method: 'GET', responseType: 'json', timeoutMs: 5000 }, { origin: 'http://localhost:5173' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, result: { data: { stargazers_count: 7 } } });
    expect((await call(base, undefined, {}, '/api/net/status')).json).toMatchObject({ available: true });
  });

  it('cookies/Authorization do navegador nunca são repassados', async () => {
    const n = fakeNet({ [U]: json({ ok: 1 }) });
    const base = await start({ net: n.deps });
    await call(base, { url: U }, { cookie: 'sessao=SEGREDO', authorization: 'Bearer SEGREDO' });
    expect(JSON.stringify(n.sent)).not.toContain('SEGREDO');
  });

  it('iframe (Origin: null), sites externos, Host forjado e pares de fora são recusados', async () => {
    const n = fakeNet({ [U]: json({ ok: 1 }) });
    const base = await start({ net: n.deps });
    expect((await call(base, { url: U }, { origin: 'null' })).status).toBe(403);
    expect((await call(base, { url: U }, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await call(base, { url: U }, { host: 'evil.example.com' })).status).toBe(403);
    const off = await start({ net: n.deps, isLocalPeer: () => false });
    expect((await call(off, { url: U })).status).toBe(403);
    expect(n.connected).toEqual([]);
  });

  it('dispositivo LAN pareado não usa a rota (local_only), mesmo com token válido', async () => {
    const n = fakeNet({ [U]: json({ ok: 1 }) });
    const base = await start({ net: n.deps, pairing: new PairingStore() });
    const { code } = (await call(base, {}, {}, '/api/pairing/code')).json;
    const LAN = '10.0.0.109:5174';
    const remote = { 'x-aurora-remote': '1', 'x-aurora-remote-addr': '10.0.0.50', host: LAN, origin: `http://${LAN}` };
    const claim = await call(base, { code, name: 'Notebook' }, remote, '/api/pairing/claim');
    expect(claim.status).toBe(200);
    const r = await call(base, { url: U }, { ...remote, authorization: `Bearer ${claim.json.token}` });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('local_only');
    expect(n.connected).toEqual([]);
  });

  it('pedido inválido → 400 estruturado; Content-Type errado → 415', async () => {
    const base = await start({ net: fakeNet({}).deps });
    const r = await call(base, { url: 'http://api.exemplo.com.br/' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, error: { code: 'blocked_url' } });
    expect((await call(base, { url: U, headers: { a: 'b' } })).json.error.code).toBe('headers_not_allowed');
    const t = await fetch(`${base}/api/net/fetch`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ url: U }) });
    expect(t.status).toBe(415);
  });

  it('limites: por minuto (total) e por domínio → 429 estruturado', async () => {
    const n = fakeNet({ [U]: json({ ok: 1 }), 'https://outro.exemplo.com.br/x': json({ ok: 2 }) });
    let t = 0;
    const base = await start({ net: { ...n.deps, perHostPerMinute: 2 }, limits: { net: { perMinute: 3, concurrent: 5 } }, now: () => t });
    expect((await call(base, { url: U })).status).toBe(200);
    expect((await call(base, { url: U })).status).toBe(200);
    const host = await call(base, { url: U });
    expect(host.status).toBe(429);
    expect(host.json).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect((await call(base, { url: 'https://outro.exemplo.com.br/x' })).status).toBe(429); // total: 3/min já usados
    t += 60_001;
    expect((await call(base, { url: 'https://outro.exemplo.com.br/x' })).status).toBe(200);
  });

  it('cliente fecha a conexão (cancelar/revogar no app) → a consulta externa é cancelada', async () => {
    let aborted = false;
    const transport: NetTransportFn = (_u, { lookup, signal }) => new Promise((_res, reject) => {
      lookup('api.exemplo.com.br', { all: true }, () => undefined);
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const base = await start({ net: { transport, resolver: async () => [{ address: PUBLIC, family: 4 }] } });
    const ctrl = new AbortController();
    const p = fetch(`${base}/api/net/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: U }), signal: ctrl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    await p;
    await expect.poll(() => aborted).toBe(true);
  });
});
