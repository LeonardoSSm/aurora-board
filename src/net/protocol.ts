/**
 * HTML Network Bridge (H2) — contrato PURO de `aurora.request()` (sem React, sem store, sem rede).
 *
 * O iframe do widget HTML continua sem rede (CSP `default-src 'none'`). Ele PEDE ao host uma consulta GET; o host
 * valida a mensagem, confere a autorização local e a política de dados sensíveis e só então chama o transporte
 * (servidor local, `POST /api/net/fetch`). Ver docs/HTML_NETWORK_BRIDGE.md.
 *
 *   iframe → host: { type: 'aurora:request', token, id, url, method, responseType, timeoutMs? }
 *                  { type: 'aurora:abort',   token, id }
 *   host → iframe: { type: 'aurora:response', token, id, ok: true,  result: NetResult }
 *                  { type: 'aurora:response', token, id, ok: false, error: NetError }
 *
 * Este módulo é usado nos DOIS lados da fronteira de confiança do app (host e servidor) para as mesmas regras de
 * URL — o servidor repete a validação e resolve o DNS por conta própria (server/netBridge.ts).
 */

export const NET_PROTOCOL = 1;

export const NET_LIMITS = {
  /** URL completa (com caminho e consulta). */
  maxUrlChars: 2048,
  /** Identificador da requisição escolhido pelo iframe. */
  maxIdChars: 64,
  defaultTimeoutMs: 10_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 20_000,
  /** Requisições em andamento (aguardando autorização ou resposta) por iframe. */
  maxPendingPerFrame: 8,
  /** Requisições aceitas por iframe numa janela de 60 s. */
  maxPerMinutePerFrame: 30,
  /** Requisições simultâneas ao transporte, somando todos os iframes (as demais esperam na fila). */
  maxConcurrent: 4,
  /** Corpo da resposta (bytes). Acima disso a resposta é recusada inteira (JSON cortado não serve). */
  maxResponseBytes: 1024 * 1024,
  /** Mensagens `aurora:request`/`aurora:abort` aceitas de um iframe por segundo. */
  maxMessagesPerSecond: 50,
} as const;

export const NET_METHODS = ['GET'] as const;
export type NetMethod = (typeof NET_METHODS)[number];
export const NET_RESPONSE_TYPES = ['json', 'text'] as const;
export type NetResponseType = (typeof NET_RESPONSE_TYPES)[number];

/** Códigos de erro estáveis (o HTML pode tratar por código; a mensagem é para pessoas). */
export const NET_ERROR_CODES = [
  'unavailable', 'invalid_request', 'headers_not_allowed', 'method_not_allowed', 'invalid_url', 'blocked_url',
  'blocked_address', 'permission_denied', 'sensitive_blocked', 'too_many_pending', 'rate_limited', 'timeout', 'aborted',
  'revoked', 'unmounted', 'network_error', 'dns_error', 'redirect_blocked', 'http_error', 'invalid_json',
  'unsupported_content_type', 'invalid_encoding', 'response_too_large', 'local_only',
] as const;
export type NetErrorCode = (typeof NET_ERROR_CODES)[number];

export interface NetError { code: NetErrorCode; message: string; status?: number; data?: unknown; text?: string }

export interface NetResult {
  /** Código HTTP (sempre 2xx aqui; outros viram `http_error`). */
  status: number;
  /** URL consultada (sem redirecionamentos na v1). */
  url: string;
  contentType: string;
  /** Tamanho do corpo em bytes. */
  bytes: number;
  responseType: NetResponseType;
  /** `responseType: 'json'` → valor JSON (corpo vazio = null). */
  data?: unknown;
  /** `responseType: 'text'` → texto UTF-8. */
  text?: string;
}

export type NetOutcome = { ok: true; result: NetResult } | { ok: false; error: NetError };

export interface NetRequest { url: string; method: NetMethod; responseType: NetResponseType; timeoutMs: number }

export const netError = (code: NetErrorCode, message: string, extra: Partial<NetError> = {}): { ok: false; error: NetError } => ({ ok: false, error: { code, message, ...extra } });

/* ------------------------------------------------------------------ mensagens do iframe */

const REQUEST_KEYS = new Set(['type', 'token', 'id', 'url', 'method', 'responseType', 'timeoutMs']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type ParsedRequestMessage =
  | { kind: 'request'; token: string; id: string; request: NetRequest }
  | { kind: 'invalid'; token: string; id: string; error: NetError };

/**
 * `aurora:request` vindo do iframe (não confiável). Retorna null quando não é desse tipo ou não tem token/id
 * utilizáveis (não há a quem responder). Campos extras — inclusive `headers`, `body`, `credentials` — recusam a
 * requisição com erro estruturado (nada é encaminhado “por engano”).
 */
export function parseRequestMessage(data: unknown): ParsedRequestMessage | null {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'aurora:request') return null;
  const o = data as Record<string, unknown>;
  if (typeof o.token !== 'string' || !o.token || o.token.length > 64 || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const bad = (e: { ok: false; error: NetError }): ParsedRequestMessage => ({ kind: 'invalid', token: o.token as string, id: o.id as string, error: e.error });
  const extra = Object.keys(o).filter((k) => !REQUEST_KEYS.has(k));
  if (extra.some((k) => /^headers$|^credentials$|^mode$/i.test(k))) return bad(netError('headers_not_allowed', 'Cabeçalhos, cookies e credenciais não podem ser definidos pelo HTML: o Aurora Board define cabeçalhos seguros.'));
  if (extra.length) return bad(netError('invalid_request', `Opção não suportada: ${extra.slice(0, 3).map((k) => k.slice(0, 20)).join(', ')}.`));
  const method = o.method === undefined ? 'GET' : typeof o.method === 'string' ? o.method.toUpperCase() : '';
  if (method !== 'GET') return bad(netError('method_not_allowed', 'Somente GET é permitido nesta versão (sem envio de corpo nem alterações em APIs externas).'));
  const responseType = o.responseType === undefined ? 'json' : o.responseType;
  if (responseType !== 'json' && responseType !== 'text') return bad(netError('invalid_request', 'responseType deve ser "json" ou "text".'));
  if (typeof o.url !== 'string' || !o.url) return bad(netError('invalid_url', 'Informe a URL (texto).'));
  let timeoutMs: number = NET_LIMITS.defaultTimeoutMs;
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs)) return bad(netError('invalid_request', 'timeoutMs deve ser um número de milissegundos.'));
    timeoutMs = Math.round(Math.min(NET_LIMITS.maxTimeoutMs, Math.max(NET_LIMITS.minTimeoutMs, o.timeoutMs)));
  }
  const v = validateNetUrl(o.url);
  if (!v.ok) return bad(v);
  return { kind: 'request', token: o.token, id: o.id, request: { url: v.url.href, method: 'GET', responseType, timeoutMs } };
}

/** `aurora:abort` vindo do iframe. */
export function parseAbortMessage(data: unknown): { token: string; id: string } | null {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'aurora:abort') return null;
  const o = data as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'type' && k !== 'token' && k !== 'id')) return null;
  if (typeof o.token !== 'string' || !o.token || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  return { token: o.token, id: o.id };
}

/* ------------------------------------------------------------------ URL (regras compartilhadas host/servidor) */

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Regras estáticas da URL de destino (v1): só `https:`, porta 443, sem credenciais, sem fragmento significativo,
 * sem nomes de rede local e sem IP literal (um destino por IP não tem nome para o usuário reconhecer — e IPs
 * privados/reservados são a principal porta de SSRF). O servidor repete esta checagem e valida o IP EFETIVAMENTE
 * conectado (resolução de DNS dentro da conexão), o que o navegador não consegue fazer.
 */
export function validateNetUrl(raw: string): { ok: true; url: URL } | { ok: false; error: NetError } {
  if (raw.length > NET_LIMITS.maxUrlChars) return netError('invalid_url', `URL com mais de ${NET_LIMITS.maxUrlChars} caracteres.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return netError('invalid_url', 'URL com espaços ou caracteres de controle.');
  let url: URL;
  try { url = new URL(raw); } catch { return netError('invalid_url', 'URL inválida (use o endereço completo, com https://).'); }
  if (url.protocol !== 'https:') return netError('blocked_url', `Somente https:// é permitido (recebido ${url.protocol.slice(0, 12)}).`);
  if (url.username || url.password) return netError('blocked_url', 'URLs com usuário ou senha não são permitidas.');
  if (url.port && url.port !== '443') return netError('blocked_url', 'Somente a porta 443 é permitida.');
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253) return netError('invalid_url', 'Domínio inválido.');
  if (host.startsWith('[') || host.includes(':') || IPV4.test(host) || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return netError('blocked_url', 'Endereços IP não são permitidos: use o nome do domínio.');
  const name = host.replace(/\.$/, '');
  if (!name.includes('.') || name === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion|arpa)$/.test(name)) {
    return netError('blocked_url', 'Nomes de rede local ou reservados não são permitidos.');
  }
  if (!/^[a-z0-9.-]+$/.test(name) || name.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return netError('invalid_url', 'Domínio inválido.');
  url.hash = '';
  return { ok: true, url };
}

/** Origem (esquema+domínio+porta) usada nas autorizações: `https://api.exemplo.com`. */
export function netOrigin(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  return `${u.protocol}//${u.hostname.toLowerCase().replace(/\.$/, '')}`;
}

export const isNetOrigin = (s: unknown): s is string => typeof s === 'string' && s.length <= 270 && /^https:\/\/[a-z0-9.-]+$/.test(s) && validateNetUrl(`${s}/`).ok;

/* ------------------------------------------------------------------ respostas para o iframe */

/** Mensagem `aurora:response` (clonável, só JSON simples). */
export function responseMessage(token: string, id: string, outcome: NetOutcome) {
  return outcome.ok ? { type: 'aurora:response', token, id, ok: true, result: outcome.result } : { type: 'aurora:response', token, id, ok: false, error: outcome.error };
}

/** Confere uma resposta do transporte antes de encaminhar ao iframe (o transporte também é uma fronteira). */
export function checkResult(r: unknown, req: NetRequest): NetOutcome {
  const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
  if (!o) return netError('network_error', 'Resposta inválida do servidor local.');
  if (o.ok === false) {
    const e = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : {};
    const code = NET_ERROR_CODES.includes(e.code as NetErrorCode) ? (e.code as NetErrorCode) : 'network_error';
    const out: NetError = { code, message: typeof e.message === 'string' ? e.message.slice(0, 300) : 'Falha na consulta.' };
    if (typeof e.status === 'number' && Number.isInteger(e.status)) out.status = e.status;
    if (code === 'http_error') {
      if (typeof e.text === 'string' && e.text.length <= NET_LIMITS.maxResponseBytes) out.text = e.text;
      if (e.data !== undefined && jsonSize(e.data) <= NET_LIMITS.maxResponseBytes) out.data = e.data;
    }
    return { ok: false, error: out };
  }
  const res = o.result && typeof o.result === 'object' ? (o.result as Record<string, unknown>) : null;
  if (o.ok !== true || !res) return netError('network_error', 'Resposta inválida do servidor local.');
  const status = Number(res.status);
  if (!Number.isInteger(status) || status < 200 || status > 299) return netError('network_error', 'Resposta inválida do servidor local.');
  const bytes = Number(res.bytes);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > NET_LIMITS.maxResponseBytes) return netError('response_too_large', `Resposta com mais de ${Math.round(NET_LIMITS.maxResponseBytes / 1024)} KB.`);
  const base: NetResult = { status, url: typeof res.url === 'string' ? res.url.slice(0, NET_LIMITS.maxUrlChars) : req.url, contentType: typeof res.contentType === 'string' ? res.contentType.slice(0, 120) : '', bytes, responseType: req.responseType };
  if (req.responseType === 'text') {
    if (typeof res.text !== 'string' || res.text.length > NET_LIMITS.maxResponseBytes) return netError('network_error', 'Resposta inválida do servidor local.');
    return { ok: true, result: { ...base, text: res.text } };
  }
  if (jsonSize(res.data) > NET_LIMITS.maxResponseBytes * 2) return netError('response_too_large', 'Resposta JSON grande demais.');
  return { ok: true, result: { ...base, data: res.data === undefined ? null : res.data } };
}

function jsonSize(v: unknown): number {
  try { return (JSON.stringify(v) ?? '').length; } catch { return Infinity; }
}

/** Mensagens claras por código (o HTML recebe a mensagem; a interface também usa). */
export const NET_ERROR_HINTS: Partial<Record<NetErrorCode, string>> = {
  unavailable: 'Acesso à rede indisponível nesta versão do Aurora Board.',
  permission_denied: 'Acesso negado pelo usuário.',
  sensitive_blocked: 'Bloqueado: este bloco recebe dados protegidos.',
  revoked: 'A autorização foi revogada ou deixou de valer durante a consulta.',
  unmounted: 'O bloco foi fechado, editado ou excluído.',
};
