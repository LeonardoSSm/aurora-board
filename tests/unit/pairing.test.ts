/**
 * Pareamento de computadores da rede (server/pairing.ts + server/app.ts). Servidor em porta efêmera de
 * 127.0.0.1, provedor falso; as chamadas “remotas” simulam o que o proxy do Vite repassa.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { isAllowedLanHost, isSameOriginForHost, PairingStore, PAIRING_RULES } from '../../server/pairing';
import type { Provider, ProviderId } from '../../server/providers';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

let chats = 0;
const fake: Provider = { id: 'openai', name: 'Falso', envKey: 'FAKE', configured: () => true, defaultModel: () => 'f', chat: async () => { chats++; return { text: 'ok', provider: 'f', model: 'f' }; } };
const providers = { openai: fake, anthropic: { ...fake, id: 'anthropic' }, gemini: { ...fake, id: 'gemini' } } as Record<ProviderId, Provider>;

async function start(pairing: PairingStore | null) {
  const s = createServer(createApp({ providers, pairing, log: () => {} }));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const LAN = '10.0.0.109:5174';
/** Como o proxy do Vite repassa uma chamada de outro computador (Host/Origin do endereço da rede). */
function remote(base: string, path: string, init: { method?: string; body?: unknown; token?: string; host?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'x-aurora-remote': '1', 'x-aurora-remote-addr': '10.0.0.50', host: init.host ?? LAN };
  if (init.origin !== null) headers.origin = init.origin ?? `http://${init.host ?? LAN}`;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return rawRequest(base, path, init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, init.body);
}
function local(base: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
/** fetch() do Node não deixa trocar o Host; usa http.request. */
async function rawRequest(base: string, path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  const { request } = await import('node:http');
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const chatBody = { provider: 'openai', system: 's', messages: [{ role: 'user', content: 'oi' }] };

async function pair(base: string) {
  const { code } = await (await local(base, '/api/pairing/code', {})).json();
  const r = await remote(base, '/api/pairing/claim', { body: { code, name: 'Notebook' } });
  expect(r.status).toBe(200);
  return r.json as { token: string; device: { id: string; name: string } };
}

describe('pareamento de computadores da rede', () => {
  it('sem pareamento, chamada remota é recusada com código pairing_required (e nada chega ao provedor)', async () => {
    chats = 0;
    const base = await start(new PairingStore());
    const r = await remote(base, '/api/ai/chat', { body: chatBody });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('pairing_required');
    expect(chats).toBe(0);
    expect((await remote(base, '/api/ai/providers')).status).toBe(401);
  });

  it('servidor sem pareamento habilitado recusa qualquer chamada remota', async () => {
    const base = await start(null);
    expect((await remote(base, '/api/ai/providers')).status).toBe(403);
  });

  it('código → token → IA funciona; token guardado só como hash; revogar corta na hora', async () => {
    chats = 0;
    const file = join(mkdtempSync(join(tmpdir(), 'aurora-pair-')), 'paired.json');
    const store = new PairingStore({ file });
    const base = await start(store);
    const { token, device } = await pair(base);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(token);
    expect(saved).toMatch(/"tokenHash": "[0-9a-f]{64}"/);
    expect((await remote(base, '/api/ai/chat', { body: chatBody, token })).status).toBe(200);
    expect(chats).toBe(1);
    expect((await remote(base, '/api/pairing/status', { token })).json).toMatchObject({ paired: true, device: { name: 'Notebook' } });
    const list = await (await local(base, '/api/pairing/devices')).json();
    expect(list.devices[0]).toMatchObject({ id: device.id, name: 'Notebook', lastAddress: '10.0.0.50' });
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|[0-9a-f]{64}/);
    // Persistência: um servidor reiniciado lê o mesmo arquivo.
    const base2 = await start(new PairingStore({ file }));
    expect((await remote(base2, '/api/ai/providers', { token })).status).toBe(200);
    expect((await local(base, '/api/pairing/revoke', { id: device.id })).status).toBe(200);
    expect((await remote(base, '/api/ai/chat', { body: chatBody, token })).status).toBe(401);
  });

  it('código é de uso único e expira', async () => {
    let t = 1_000_000;
    const store = new PairingStore({ now: () => t });
    const base = await start(store);
    const { code } = await (await local(base, '/api/pairing/code', {})).json();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await remote(base, '/api/pairing/claim', { body: { code, name: 'A' } })).status).toBe(200);
    expect((await remote(base, '/api/pairing/claim', { body: { code, name: 'B' } })).status).toBe(401);
    const second = (await (await local(base, '/api/pairing/code', {})).json()).code;
    t += PAIRING_RULES.codeTtlMs + 1;
    const r = await remote(base, '/api/pairing/claim', { body: { code: second, name: 'C' } });
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/expirado/);
  });

  it('adivinhação: código invalidado após 5 erros; bloqueio após 20 falhas', async () => {
    const store = new PairingStore();
    const base = await start(store);
    const { code } = await (await local(base, '/api/pairing/code', {})).json();
    for (let i = 0; i < PAIRING_RULES.maxCodeAttempts; i++) expect((await remote(base, '/api/pairing/claim', { body: { code: 'AAAA-AAAA', name: 'x' } })).status).toBe(401);
    expect((await remote(base, '/api/pairing/claim', { body: { code, name: 'x' } })).status).toBe(401); // o certo já não vale
    for (let i = 0; i < PAIRING_RULES.lockoutFailures; i++) await remote(base, '/api/pairing/claim', { body: { code: 'BBBB-BBBB', name: 'x' } });
    await local(base, '/api/pairing/code', {});
    expect((await remote(base, '/api/pairing/claim', { body: { code: 'CCCC-CCCC', name: 'x' } })).status).toBe(429);
  });

  it('dispositivo pareado não gerencia pareamentos nem gera códigos', async () => {
    const base = await start(new PairingStore());
    const { token, device } = await pair(base);
    expect((await remote(base, '/api/pairing/code', { body: {}, token })).status).toBe(403);
    expect((await remote(base, '/api/pairing/devices', { token })).status).toBe(403);
    expect((await remote(base, '/api/pairing/revoke', { body: { id: device.id }, token })).status).toBe(403);
  });

  it('DNS rebinding e CSRF: host público ou origem de outro site são recusados mesmo com token', async () => {
    const base = await start(new PairingStore());
    const { token } = await pair(base);
    expect((await remote(base, '/api/ai/providers', { token, host: 'atacante.example:5174' })).status).toBe(403);
    expect((await remote(base, '/api/ai/providers', { token, origin: 'http://atacante.example' })).status).toBe(403);
    expect((await remote(base, '/api/ai/providers', { token, origin: null })).status).toBe(200);
    expect((await remote(base, '/api/ai/providers', { token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('acesso local continua igual (sem token) e gerencia pareamentos', async () => {
    const base = await start(new PairingStore());
    expect((await local(base, '/api/ai/providers')).status).toBe(200);
    expect((await local(base, '/api/pairing/devices')).status).toBe(200);
  });

  it('hosts aceitos para a rede local', () => {
    for (const h of ['10.0.0.109:5174', '192.168.1.20', '172.20.1.1:5174', '100.100.1.2', 'meu-pc.local:5174', '[fe80::1]:5174']) expect(isAllowedLanHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', 'example.com', 'localhost.attacker.com', '172.32.0.1', '', undefined]) expect(isAllowedLanHost(h as string | undefined), String(h)).toBe(false);
    expect(isSameOriginForHost('http://10.0.0.109:5174', '10.0.0.109:5174')).toBe(true);
    expect(isSameOriginForHost('http://10.0.0.109:5173', '10.0.0.109:5174')).toBe(false);
  });
});
