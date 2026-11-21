/**
 * D1-B — validação do IPC do Aurora Board Desktop (desktop/ipcValidation.ts) e o adaptador do renderer
 * (src/integrations/apiFetch.ts → window.auroraDesktop.api) com o serviço REAL (server/apiService.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrustedSenderInfo, parseCancel, parseIpcCall } from '../../desktop/ipcValidation';
import { DESKTOP_IPC_OPS, routeOp } from '../../src/integrations/apiRoutes';
import { createApiService } from '../../server/apiService';
import type { Provider, ProviderId } from '../../server/providers';

describe('remetente do IPC', () => {
  it('só o documento principal da janela do app em aurora://app', () => {
    expect(isTrustedSenderInfo({ isAppWindow: true, isMainFrame: true, frameUrl: 'aurora://app/index.html' })).toBe(true);
    // O iframe dos widgets (subframe), outra janela, outra origem ou frame sem URL: recusados.
    expect(isTrustedSenderInfo({ isAppWindow: true, isMainFrame: false, frameUrl: 'aurora://app/sandbox.html' })).toBe(false);
    expect(isTrustedSenderInfo({ isAppWindow: false, isMainFrame: true, frameUrl: 'aurora://app/index.html' })).toBe(false);
    expect(isTrustedSenderInfo({ isAppWindow: true, isMainFrame: true, frameUrl: 'https://evil.example.com/' })).toBe(false);
    expect(isTrustedSenderInfo({ isAppWindow: true, isMainFrame: true, frameUrl: 'file:///C:/x.html' })).toBe(false);
    expect(isTrustedSenderInfo({ isAppWindow: true, isMainFrame: true, frameUrl: undefined })).toBe(false);
  });
});

describe('validação das chamadas', () => {
  it('aceita só as operações da allowlist, com os campos exatos', () => {
    for (const op of DESKTOP_IPC_OPS) {
      const args = op === 'pluggy.accounts' ? { op, itemId: 'i' } : op === 'pluggy.transactions' ? { op, itemId: 'i', accountId: 'a', from: '2026-01-01', to: '2026-01-31' } : { op };
      const body = ['ai.chat', 'linkPreview', 'net.fetch'].includes(op) ? { x: 1 } : undefined;
      expect(parseIpcCall('c1', args, body), op).toMatchObject({ ok: true, id: 'c1', op: args });
    }
    for (const op of [{ op: 'pairing.code' }, { op: 'pairing.revoke' }, { op: 'net.other' }, { op: 'pluggy.other' }, { op: '__proto__' }, { op: 'constructor' }, 'health', null, [], { op: 1 }]) {
      expect(parseIpcCall('c1', op, undefined), JSON.stringify(op)).toMatchObject({ ok: false, status: 404 });
    }
  });

  it('recusa ids inválidos, campos extras, corpos onde não cabe, corpos gigantes e não-JSON', () => {
    expect(parseIpcCall('', { op: 'health' }, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('a b', { op: 'health' }, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('x'.repeat(65), { op: 'health' }, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('c', { op: 'health', path: '/etc' }, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('c', { op: 'health' }, { a: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('c', { op: 'pluggy.accounts', itemId: 5 }, undefined)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('c', { op: 'net.fetch' }, { url: 'x'.repeat(2 * 1024 * 1024) })).toMatchObject({ ok: false, status: 413 });
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(parseIpcCall('c', { op: 'ai.chat' }, cyc)).toMatchObject({ ok: false, status: 400 });
    expect(parseIpcCall('c', { op: 'ai.chat' }, 10n)).toMatchObject({ ok: false, status: 400 });
    // Cópia JSON: funções/símbolos somem, protótipos não passam.
    const r = parseIpcCall('c', { op: 'ai.chat' }, { a: 1, f: () => 1, ['__proto__']: { polluted: true } });
    expect(r.ok && r.body).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseCancel('c1')).toBe('c1');
    expect(parseCancel({})).toBeNull();
  });
});

describe('rotas HTTP ↔ operações (mesma tabela no servidor web e no desktop)', () => {
  it('mapeia as rotas conhecidas e recusa o resto', () => {
    const u = (p: string) => new URL(p, 'http://localhost');
    expect(routeOp('GET', u('/api/ai/providers'))).toEqual({ op: 'ai.providers' });
    expect(routeOp('POST', u('/api/net/fetch'))).toEqual({ op: 'net.fetch' });
    expect(routeOp('GET', u('/api/pluggy/transactions?itemId=a&accountId=b&from=c&to=d'))).toEqual({ op: 'pluggy.transactions', itemId: 'a', accountId: 'b', from: 'c', to: 'd' });
    expect(routeOp('POST', u('/api/pluggy/status'))).toBe('method-not-allowed');
    expect(routeOp('GET', u('/api/pairing/devices'))).toBeNull();
    expect(routeOp('GET', u('/api/ai/chat'))).toBeNull();
  });
});

describe('serviço compartilhado (mesmas respostas do HTTP)', () => {
  const fake = (chat: Provider['chat'], configured = true): Record<ProviderId, Provider> => {
    const p: Provider = { id: 'openai', name: 'Falso', envKey: 'FAKE_KEY', configured: () => configured, defaultModel: () => 'f', chat };
    return { openai: p, anthropic: { ...p, id: 'anthropic' }, gemini: { ...p, id: 'gemini' } };
  };
  const ctx = (body?: unknown, signal = new AbortController().signal) => ({ signal, remote: false, readBody: async () => body });
  const chatBody = { provider: 'openai', system: 's', messages: [{ role: 'user', content: 'oi' }] };

  it('chave ausente orienta conforme o transporte (web: .env; desktop: Configurações)', async () => {
    const web = createApiService({ providers: fake(async () => ({ text: '', provider: 'f', model: 'f' }), false), log: () => undefined });
    expect((await web.call({ op: 'ai.chat' }, ctx(chatBody))).body).toEqual({ error: 'Falso não configurado: defina FAKE_KEY no .env do servidor.' });
    const desk = createApiService({ providers: fake(async () => ({ text: '', provider: 'f', model: 'f' }), false), missingKeyHint: () => 'configure em Configurações', log: () => undefined });
    expect((await desk.call({ op: 'ai.chat' }, ctx(chatBody))).body).toEqual({ error: 'Falso não configurado: configure em Configurações.' });
  });

  it('cancelar (desmontagem, recarga, troca de janela) cancela a chamada ao provedor', async () => {
    let aborted = false, started = false;
    const svc = createApiService({ providers: fake((_r, signal) => new Promise((_res, reject) => { started = true; signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('cancelado'), { status: 499 })); }); })), log: () => undefined });
    const ctrl = new AbortController();
    const p = svc.call({ op: 'ai.chat' }, ctx(chatBody, ctrl.signal));
    await vi.waitFor(() => expect(started).toBe(true));
    ctrl.abort();
    expect((await p).status).toBe(499);
    expect(aborted).toBe(true);
    // Já cancelada antes de começar: o provedor nem é chamado.
    started = false;
    const pre = new AbortController(); pre.abort();
    expect((await svc.call({ op: 'ai.chat' }, ctx(chatBody, pre.signal))).status).toBe(499);
    expect(started).toBe(false);
  });

  it('limites por minuto valem também para o IPC (429 + retryAfter); erro interno sem segredo', async () => {
    let t = 0;
    const svc = createApiService({ providers: fake(async () => ({ text: 'ok', provider: 'f', model: 'f' })), limits: { chat: { perMinute: 1, concurrent: 5 } }, now: () => t, log: () => undefined });
    expect((await svc.call({ op: 'ai.chat' }, ctx(chatBody))).status).toBe(200);
    const r = await svc.call({ op: 'ai.chat' }, ctx(chatBody));
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBeGreaterThan(0);
    t += 60_001;
    const log = vi.fn();
    const boom = createApiService({ providers: fake(async () => { throw new Error('falhou com sk-proj-SEGREDOFICTICIO1234567890'); }), log });
    const e = await boom.call({ op: 'ai.chat' }, ctx(chatBody));
    expect(e).toEqual({ status: 500, body: { error: 'Erro interno.' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SEGREDOFICTICIO');
  });
});

afterEach(() => vi.restoreAllMocks());
