/**
 * Cliente de IA (frontend). NUNCA contém chaves: fala apenas com o servidor local (/api/ai/*),
 * que guarda as credenciais em variáveis de ambiente e encaminha ao provedor.
 */
export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  configured: boolean;
  defaultModel: string;
}

export type AIStatus =
  | { state: 'offline'; message: string }
  | { state: 'ready'; providers: ProviderInfo[] };

let statusPromise: Promise<AIStatus> | null = null;

export function fetchAIStatus(force = false): Promise<AIStatus> {
  if (statusPromise && !force) return statusPromise;
  statusPromise = (async (): Promise<AIStatus> => {
    try {
      const res = await fetch('/api/ai/providers');
      if (!res.ok) return { state: 'offline', message: `Servidor de IA respondeu ${res.status}. Rode "npm run dev" (inicia web + API).` };
      const body = (await res.json()) as { providers: ProviderInfo[] };
      return { state: 'ready', providers: body.providers };
    } catch {
      return { state: 'offline', message: 'Servidor local de IA indisponível. Rode "npm run dev" para iniciar web + API.' };
    }
  })();
  return statusPromise;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ChatResponse { text: string; provider: string; model: string; usage?: { input?: number; output?: number } }

export async function sendChat(req: { provider: ProviderId; model?: string; system: string; messages: ChatMessage[] }, signal?: AbortSignal): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('Não foi possível alcançar o servidor local de IA.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erro ${res.status} do servidor de IA.`);
  return body as ChatResponse;
}
