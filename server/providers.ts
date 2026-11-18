/**
 * Interface de provedores de modelos de linguagem.
 * Para adicionar um provedor: implemente `Provider` e registre em PROVIDERS.
 */
export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export interface ChatRequest {
  provider: ProviderId;
  model?: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  usage?: { input?: number; output?: number };
}

export interface Provider {
  id: ProviderId;
  name: string;
  envKey: string;
  configured(): boolean;
  defaultModel(): string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

const TIMEOUT_MS = 90_000;

async function postJSON(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* resposta não JSON */ }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.message ?? text.slice(0, 300);
      throw Object.assign(new Error(`Provedor respondeu ${res.status}: ${msg}`), { status: res.status === 401 || res.status === 403 ? 401 : 502 });
    }
    return json;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw Object.assign(new Error('Tempo esgotado aguardando o provedor de IA.'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const env = (k: string) => (process.env[k] ?? '').trim();

const openai: Provider = {
  id: 'openai',
  name: 'OpenAI (ChatGPT)',
  envKey: 'OPENAI_API_KEY',
  configured: () => !!env('OPENAI_API_KEY'),
  defaultModel: () => env('OPENAI_MODEL') || 'gpt-4.1-mini',
  async chat(req) {
    const model = req.model || this.defaultModel();
    const json = await postJSON(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${env('OPENAI_API_KEY')}` },
      { model, messages: [{ role: 'system', content: req.system }, ...req.messages] },
    );
    return { text: json?.choices?.[0]?.message?.content ?? '', provider: this.name, model: json?.model ?? model, usage: { input: json?.usage?.prompt_tokens, output: json?.usage?.completion_tokens } };
  },
};

const anthropic: Provider = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  envKey: 'ANTHROPIC_API_KEY',
  configured: () => !!env('ANTHROPIC_API_KEY'),
  defaultModel: () => env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5',
  async chat(req) {
    const model = req.model || this.defaultModel();
    const json = await postJSON(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 4096, system: req.system, messages: req.messages },
    );
    const text = Array.isArray(json?.content) ? json.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : '';
    return { text, provider: this.name, model: json?.model ?? model, usage: { input: json?.usage?.input_tokens, output: json?.usage?.output_tokens } };
  },
};

const gemini: Provider = {
  id: 'gemini',
  name: 'Google (Gemini)',
  envKey: 'GEMINI_API_KEY',
  configured: () => !!env('GEMINI_API_KEY'),
  defaultModel: () => env('GEMINI_MODEL') || 'gemini-2.5-flash',
  async chat(req) {
    const model = req.model || this.defaultModel();
    const json = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': env('GEMINI_API_KEY') },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      },
    );
    const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    return { text, provider: this.name, model, usage: { input: json?.usageMetadata?.promptTokenCount, output: json?.usageMetadata?.candidatesTokenCount } };
  },
};

export const PROVIDERS: Record<ProviderId, Provider> = { openai, anthropic, gemini };
