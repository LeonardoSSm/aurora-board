/**
 * Segurança do servidor local, da pré-visualização de links (SSRF) e do sandbox de plugins.
 * Nenhum teste faz requisição real a destinos internos: transporte e DNS são simulados.
 * O servidor de teste escuta em porta efêmera de 127.0.0.1 e usa um provedor de IA falso.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedHostHeader, isAllowedOrigin, isBlockedAddress, redactSecrets, safeFetchText, validateUrl, type RawResponse, type Resolver, type Transport } from '../../server/netSafety';
import { createApp } from '../../server/app';
import type { Provider, ProviderId } from '../../server/providers';
import { createThrottle, parseSandboxMessage, SANDBOX_CSP } from '../../src/widgets/builtin/sandbox';

describe('endereços bloqueados', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'ff02::1', 'não-é-ip',
  ])('%s é bloqueado', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1'])('%s é permitido', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('validação de URL', () => {
  it.each([
    ['http://localhost/', /local/],
    ['http://LOCALHOST./', /local/],
    ['http://app.localhost/', /local/],
    ['http://127.0.0.1/', /local/],
    ['http://[::1]/', /local/],
    ['http://[::ffff:127.0.0.1]/', /local/],
    ['http://2130706433/', /local|inválid/], // 127.0.0.1 em decimal
    ['http://0x7f.1/', /local|inválid/],
    ['http://intranet/', /local/],
    ['file:///etc/passwd', /http/],
    ['gopher://exemplo.com/', /http/],
    ['https://user:senha@exemplo.com/', /credenciais/],
    ['http://exemplo.com:8080/', /portas/],
    ['nada', /inválida/],
  ])('%s é recusada', (url, msg) => expect(() => validateUrl(url)).toThrow(msg));

  it('aceita https público e resolve relativos', () => {
    expect(validateUrl('https://exemplo.com/a').href).toBe('https://exemplo.com/a');
    expect(validateUrl('/b', new URL('https://exemplo.com/a')).href).toBe('https://exemplo.com/b');
  });
});

/* ---------- transporte simulado: chama o lookup como uma conexão real faria ---------- */

function response(status: number, headers: Record<string, string>, body = ''): RawResponse {
  return { status, headers, body: Readable.from([Buffer.from(body)]), close: () => undefined };
}

function fakeNet(routes: Record<string, () => RawResponse>, dns: Record<string, string[] | (() => string[])>) {
  const requested: string[] = [];
  const resolver: Resolver = async (host) => {
    const r = dns[host];
    const list = typeof r === 'function' ? r() : r;
    if (!list) throw new Error('ENOTFOUND');
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const transport: Transport = (url, { lookup }) =>
    new Promise((resolve, reject) => {
      // A "conexão" usa o lookup seguro — como http.request faz.
      lookup(url.hostname, {}, (err) => {
        if (err) return reject(err);
        requested.push(url.href);
        const route = routes[url.href];
        if (!route) return reject(new Error('ECONNREFUSED'));
        resolve(route());
      });
    });
  return { transport, resolver, requested };
}

describe('busca segura (SSRF)', () => {
  it('domínio que resolve para IP privado é recusado na conexão', async () => {
    const n = fakeNet({}, { 'interno.exemplo.com': ['10.0.0.5'] });
    await expect(safeFetchText('https://interno.exemplo.com/', n)).rejects.toThrow(/rede local|reservado/);
    expect(n.requested).toEqual([]);
  });

  it('redirect público → IP privado é bloqueado sem requisitar o destino', async () => {
    const n = fakeNet({ 'https://publico.exemplo.com/': () => response(302, { location: 'http://169.254.169.254/latest/meta-data' }) }, { 'publico.exemplo.com': ['93.184.216.34'] });
    await expect(safeFetchText('https://publico.exemplo.com/', n)).rejects.toThrow(/local|reservado/);
    expect(n.requested).toEqual(['https://publico.exemplo.com/']);
  });

  it('redirect para domínio que resolve privado é bloqueado', async () => {
    const n = fakeNet({ 'https://a.exemplo.com/': () => response(301, { location: 'https://b.exemplo.com/' }) }, { 'a.exemplo.com': ['93.184.216.34'], 'b.exemplo.com': ['192.168.0.10'] });
    await expect(safeFetchText('https://a.exemplo.com/', n)).rejects.toThrow(/rede local|reservado/);
  });

  it('DNS inconsistente (rebinding): IP público na 1ª resolução, privado na 2ª', async () => {
    let calls = 0;
    const n = fakeNet(
      { 'https://r.exemplo.com/': () => response(302, { location: 'https://r.exemplo.com/2' }) },
      { 'r.exemplo.com': () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']) },
    );
    await expect(safeFetchText('https://r.exemplo.com/', n)).rejects.toThrow(/rede local|reservado/);
    expect(calls).toBe(2);
  });

  it('DNS com mistura de IPs públicos e privados é recusado', async () => {
    const n = fakeNet({}, { 'misto.exemplo.com': ['93.184.216.34', '10.0.0.1'] });
    await expect(safeFetchText('https://misto.exemplo.com/', n)).rejects.toThrow(/rede local|reservado/);
  });

  it('encadeamento de redirects acima do limite é interrompido', async () => {
    const routes: Record<string, () => RawResponse> = {};
    for (let i = 0; i < 6; i++) routes[`https://c.exemplo.com/${i}`] = () => response(302, { location: `/${i + 1}` });
    const n = fakeNet(routes, { 'c.exemplo.com': ['93.184.216.34'] });
    await expect(safeFetchText('https://c.exemplo.com/0', n)).rejects.toThrow(/Redirecionamentos demais/);
    expect(n.requested.length).toBe(4); // original + 3 redirecionamentos
  });

  it('domínio inexistente', async () => {
    const n = fakeNet({}, {});
    await expect(safeFetchText('https://nao-existe.exemplo.com/', n)).rejects.toThrow(/resolver/);
  });

  it('resposta grande é truncada no limite de bytes', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const n = fakeNet({ 'https://grande.exemplo.com/': () => response(200, { 'content-type': 'text/html' }, big) }, { 'grande.exemplo.com': ['93.184.216.34'] });
    const r = await safeFetchText('https://grande.exemplo.com/', n, { maxRedirects: 3, timeoutMs: 5000, maxBytes: 1000 });
    expect(r.text.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('timeout de rede', async () => {
    const transport: Transport = () => new Promise(() => undefined); // nunca responde
    const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(safeFetchText('https://lento.exemplo.com/', { transport, resolver }, { maxRedirects: 3, timeoutMs: 50, maxBytes: 1000 })).rejects.toThrow(/Tempo esgotado/);
  });

  it('redirect sem Location e status de erro são tratados', async () => {
    const n = fakeNet({ 'https://x.exemplo.com/': () => response(302, {}), 'https://y.exemplo.com/': () => response(500, {}) }, { 'x.exemplo.com': ['93.184.216.34'], 'y.exemplo.com': ['93.184.216.34'] });
    await expect(safeFetchText('https://x.exemplo.com/', n)).rejects.toThrow(/Redirecionamento inválido/);
    await expect(safeFetchText('https://y.exemplo.com/', n)).rejects.toThrow(/500/);
  });
});

/* ---------- servidor local ---------- */

let server: Server;
let base: string;
const calls: { aborted: boolean; signal?: AbortSignal }[] = [];
const fakeProvider = (echoKey = false): Provider => ({
  id: 'openai',
  name: 'Falso',
  envKey: 'FAKE_KEY',
  configured: () => true,
  defaultModel: () => 'falso-1',
  chat: async (req, signal) => {
    const rec = { aborted: false, signal };
    calls.push(rec);
    signal?.addEventListener('abort', () => { rec.aborted = true; });
    if (req.messages[0].content === 'erro') throw Object.assign(new Error('Provedor respondeu 401: Incorrect API key provided: sk-proj-abc123SECRETxyz'), { status: 401 });
    if (req.messages[0].content === 'lento') await new Promise((r) => setTimeout(r, 400));
    return { text: echoKey ? 'ok' : 'resposta', provider: 'Falso', model: 'falso-1' };
  },
});
const logs: string[] = [];

beforeAll(async () => {
  const providers = { openai: fakeProvider(), anthropic: { ...fakeProvider(), id: 'anthropic', configured: () => false }, gemini: { ...fakeProvider(), id: 'gemini', configured: () => false } } as Record<ProviderId, Provider>;
  server = createServer(createApp({ providers, log: (m) => logs.push(m) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const chatBody = (content: string) => JSON.stringify({ provider: 'openai', system: 's', messages: [{ role: 'user', content }] });

describe('servidor local: proteções de requisição', () => {
  it('Host forjado (DNS rebinding) → 403', async () => {
    // fetch não permite trocar Host; usa http cru
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/api/ai/providers`, { headers: { host: 'atacante.exemplo.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(403);
  });

  it('Origin estrangeira → 403; POST text/plain (sem preflight) → 415', async () => {
    const r1 = await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { origin: 'https://site-malicioso.exemplo', 'content-type': 'application/json' }, body: chatBody('oi') });
    expect(r1.status).toBe(403);
    const r2 = await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: chatBody('oi') });
    expect(r2.status).toBe(415);
    expect(calls.filter((c) => c).length).toBe(0);
  });

  it('origem local com JSON → 200; nenhum cabeçalho CORS é emitido', async () => {
    const r = await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: chatBody('oi') });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect((await r.json()).text).toBe('resposta');
  });

  it('chave ecoada pelo provedor não chega ao cliente', async () => {
    const r = await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('erro') });
    const body = await r.json();
    expect(r.status).toBe(401);
    expect(body.error).not.toMatch(/SECRET|sk-proj/);
    expect(body.error).toMatch(/chave-removida/);
    expect(logs.join('\n')).not.toMatch(/SECRET/);
  });

  it('cancelar no cliente cancela a chamada ao provedor', async () => {
    const ctrl = new AbortController();
    const p = fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('lento'), signal: ctrl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.at(-1)!.aborted).toBe(true);
  });

  it('provedor não configurado, provedor inexistente e corpo inválido', async () => {
    const post = (b: string) => fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    expect((await post(JSON.stringify({ provider: 'anthropic', system: 's', messages: [{ role: 'user', content: 'x' }] }))).status).toBe(400);
    expect((await post(JSON.stringify({ provider: '__proto__', system: 's', messages: [{ role: 'user', content: 'x' }] }))).status).toBe(400);
    expect((await post('{quebrado')).status).toBe(400);
    expect((await post(JSON.stringify({ provider: 'openai', system: 's', messages: [{ role: 'system', content: 'x' }] }))).status).toBe(400);
  });

  it('pré-visualização recusa destinos locais', async () => {
    const r = await fetch(`${base}/api/link-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8787/api/health' }) });
    expect(r.status).toBe(400);
  });

  it('ajudantes: Host/Origin locais e remoção de segredos', () => {
    expect(isAllowedHostHeader('localhost:5173')).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1:8787')).toBe(true);
    expect(isAllowedHostHeader('evil.com')).toBe(false);
    expect(isAllowedHostHeader(undefined)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(redactSecrets('key AIzaSyA-123456789012345 e sk-ant-api03-XYZ e api_key=abc')).not.toMatch(/AIzaSy|api03|abc/);
  });
});

describe('sandbox de plugins', () => {
  it('aceita só o protocolo, com tamanho e estrutura limitados', () => {
    expect(parseSandboxMessage({ type: 'outro' })).toBeNull();
    expect(parseSandboxMessage('texto')).toBeNull();
    expect(parseSandboxMessage({ type: 'aurora:setState', state: { n: 1 } })).toEqual({ ok: true, state: { n: 1 } });
    expect(parseSandboxMessage({ type: 'aurora:setState', state: 'x'.repeat(200_000) })).toMatchObject({ ok: false });
    expect(parseSandboxMessage({ type: 'aurora:setState', state: {}, extra: 1 })).toMatchObject({ ok: false });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parseSandboxMessage({ type: 'aurora:setState', state: circular })).toMatchObject({ ok: false });
  });

  it('limita a frequência de atualizações sem perder o último estado', () => {
    let t = 0;
    const delivered: number[] = [];
    let scheduled: (() => void) | null = null;
    const push = createThrottle<number>((v) => delivered.push(v), 10, () => t, (fn) => { scheduled = fn; });
    for (let i = 0; i < 1000; i++) push(i);
    expect(delivered).toHaveLength(10);
    t = 1000;
    scheduled!();
    expect(delivered.at(-1)).toBe(999);
    expect(delivered).toHaveLength(11);
  });

  it('CSP bloqueia rede, frames, formulários e base', () => {
    for (const d of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"]) expect(SANDBOX_CSP).toContain(d);
    expect(SANDBOX_CSP).not.toMatch(/connect-src|https?:/);
  });
});
