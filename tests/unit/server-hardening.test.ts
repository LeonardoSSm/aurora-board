/**
 * Ciclo S1 — servidor local (S1-SEC-013/014). Servidor em porta efêmera de 127.0.0.1, provedor falso,
 * nenhuma chamada externa. Segredos usados são fictícios.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../server/app';
import { isLoopbackAddress, redactSecrets } from '../../server/netSafety';
import type { Provider, ProviderId } from '../../server/providers';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

function provider(chat: Provider['chat']): Record<ProviderId, Provider> {
  const p: Provider = { id: 'openai', name: 'Falso', envKey: 'FAKE', configured: () => true, defaultModel: () => 'f', chat };
  return { openai: p, anthropic: { ...p, id: 'anthropic' }, gemini: { ...p, id: 'gemini' } };
}

async function start(deps: AppDeps) {
  const s = createServer(createApp(deps));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const chat = (base: string, content = 'oi') => fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', system: 's', messages: [{ role: 'user', content }] }) });

describe('endereço do par', () => {
  it.each([['127.0.0.1', true], ['127.5.6.7', true], ['::1', true], ['::ffff:127.0.0.1', true], ['192.168.0.10', false], ['10.0.0.2', false], ['::ffff:192.168.0.10', false], ['fe80::1', false], [undefined, false]])('%s → %s', (a, ok) => expect(isLoopbackAddress(a as string | undefined)).toBe(ok));

  it('conexão de fora do computador é recusada mesmo com Host: localhost (proxy/bind exposto)', async () => {
    let called = 0;
    const base = await start({ providers: provider(async () => { called++; return { text: 'x', provider: 'f', model: 'f' }; }), isLocalPeer: () => false });
    const r = await chat(base);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/locais/);
    expect(called).toBe(0);
  });
});

describe('limites de uso (defesa em profundidade)', () => {
  it('por minuto: 429 com Retry-After; janela libera depois de 60 s', async () => {
    let t = 0;
    const base = await start({ providers: provider(async () => ({ text: 'ok', provider: 'f', model: 'f' })), limits: { chat: { perMinute: 2, concurrent: 5 } }, now: () => t });
    expect((await chat(base)).status).toBe(200);
    expect((await chat(base)).status).toBe(200);
    const r = await chat(base);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    t += 60_001;
    expect((await chat(base)).status).toBe(200);
  });

  it('concorrência: chamadas simultâneas além do limite → 429; ao terminar, vaga volta', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = await start({ providers: provider(async () => { await gate; return { text: 'ok', provider: 'f', model: 'f' }; }), limits: { chat: { perMinute: 100, concurrent: 1 } } });
    const first = chat(base);
    await new Promise((r) => setTimeout(r, 100));
    expect((await chat(base)).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await chat(base)).status).toBe(200);
  });

  it('falha do provedor libera a vaga e não vaza segredo fictício', async () => {
    const base = await start({
      providers: provider(async () => { throw Object.assign(new Error('Provedor respondeu 500: chave sk-proj-FICTICIA1234567890 e AIzaFICTICIA1234567890abc api_key=segredo123'), { status: 502 }); }),
      limits: { chat: { perMinute: 100, concurrent: 1 } },
      log: () => undefined,
    });
    for (let i = 0; i < 3; i++) {
      const r = await chat(base);
      expect(r.status).toBe(502);
      const body = JSON.stringify(await r.json());
      expect(body).not.toMatch(/FICTICIA|segredo123/);
    }
  });

  it('redactSecrets cobre formatos usuais de chave', () => {
    const out = redactSecrets('sk-abc123456789 sk-ant-api03-XYZ123456 AIzaSyA1234567890abcdef "apiKey": "zzz" api-key=qqq');
    expect(out).not.toMatch(/abc123456789|XYZ123456|AIzaSyA|zzz|qqq/);
  });
});
