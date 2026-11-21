/**
 * H2-B — transporte do app para o servidor local: `POST /api/net/fetch`. Cancelar o `signal` fecha a conexão,
 * e o servidor cancela a consulta externa. No build público este código não existe (constante de build).
 */
import { LOCAL_API_ENABLED } from '../config/runtime';
import { postJSON } from '../integrations/apiFetch';
import { netError, type NetOutcome, type NetRequest } from './protocol';

export const STATIC_NET_MESSAGE = 'O acesso à rede dos blocos HTML não está disponível nesta versão pública do Aurora Board (não há servidor local).';

export async function localNetTransport(req: NetRequest, signal: AbortSignal): Promise<NetOutcome> {
  if (!LOCAL_API_ENABLED) return netError('unavailable', STATIC_NET_MESSAGE);
  let res: Response;
  try {
    res = await postJSON('/api/net/fetch', { url: req.url, method: req.method, responseType: req.responseType, timeoutMs: req.timeoutMs }, signal);
  } catch {
    return signal.aborted ? netError('aborted', 'Consulta cancelada.') : netError('network_error', 'O servidor local do Aurora Board não respondeu (ele está rodando?).');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* corpo não-JSON: tratado abaixo */ }
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (o && typeof o.ok === 'boolean') return o as unknown as NetOutcome; // conferido de novo no corretor (checkResult)
  const msg = o && typeof o.error === 'string' ? o.error.slice(0, 300) : `Servidor local respondeu ${res.status}.`;
  if (res.status === 403 && o?.code === 'local_only') return netError('local_only', msg);
  if (res.status === 404) return netError('unavailable', 'O servidor local desta instalação não oferece acesso à rede para blocos HTML (atualize o Aurora Board).');
  if (res.status === 429) return netError('rate_limited', msg);
  return netError('network_error', msg);
}
