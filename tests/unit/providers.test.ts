/**
 * Verifica o formato das requisições e a leitura das respostas de cada provedor com fetch SIMULADO.
 * Não comprova uma chamada real (isso exige chave válida) — apenas o contrato implementado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../server/providers';

const req = { provider: 'openai' as const, system: 'SYS', messages: [{ role: 'user' as const, content: 'Olá' }] };

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('provedores de IA (contrato)', () => {
  it('não configurado sem chave', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(PROVIDERS.openai.configured()).toBe(false);
  });

  it('OpenAI: chat/completions com system + mensagens', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const f = mockFetch({ model: 'gpt-x', choices: [{ message: { content: 'resposta' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    const r = await PROVIDERS.openai.chat({ ...req, model: 'gpt-x' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(r).toMatchObject({ text: 'resposta', model: 'gpt-x', usage: { input: 3, output: 4 } });
  });

  it('Anthropic: /v1/messages com system separado e versão da API', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ak-test');
    const f = mockFetch({ model: 'claude-x', content: [{ type: 'text', text: 'oi' }, { type: 'text', text: 'tudo bem' }], usage: { input_tokens: 1, output_tokens: 2 } });
    const r = await PROVIDERS.anthropic.chat({ ...req, provider: 'anthropic' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('ak-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(r.text).toBe('oi\ntudo bem');
  });

  it('Gemini: generateContent com systemInstruction e papel "model"', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'g-test');
    const f = mockFetch({ candidates: [{ content: { parts: [{ text: 'olá' }] } }] });
    const r = await PROVIDERS.gemini.chat({ ...req, provider: 'gemini', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-test');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(r.text).toBe('olá');
  });

  it('erro do provedor vira mensagem clara (sem vazar chave)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-secret');
    mockFetch({ error: { message: 'Incorrect API key' } }, 401);
    await expect(PROVIDERS.openai.chat(req)).rejects.toThrow(/401: Incorrect API key/);
    await expect(PROVIDERS.openai.chat(req)).rejects.not.toThrow(/sk-secret/);
  });
});
