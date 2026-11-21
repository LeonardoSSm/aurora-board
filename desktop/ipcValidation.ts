/**
 * D1-B — validação PURA do que chega pelo IPC do renderer (o processo principal não confia no renderer).
 *
 * Canais (únicos):
 *   'aurora:api'        (callId, op, body) → ApiResult     operação da allowlist DESKTOP_IPC_OPS
 *   'aurora:api-cancel' (callId)          → void           cancela a operação em andamento
 * Remetente: só o documento PRINCIPAL da janela do app em `aurora://app` (nunca o iframe dos widgets, nunca outra
 * origem) — conferido por `isTrustedSender` em desktop/ipc.ts com os dados do Electron.
 */
import { DESKTOP_IPC_OPS, OPS_WITH_BODY, type ApiOp } from '../src/integrations/apiRoutes';
import { isAppUrl } from './security';

export const IPC_LIMITS = {
  /** JSON do corpo (o mesmo teto da API HTTP). */
  maxBodyChars: 2 * 1024 * 1024,
  /** Operações em andamento por janela. */
  maxPending: 64,
  maxField: 100,
} as const;

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED = new Set<string>(DESKTOP_IPC_OPS);

export type ParsedCall = { ok: true; id: string; op: ApiOp; body: unknown } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): ParsedCall => ({ ok: false, status, error });

/** Campo de texto curto (ids e datas do Meu Pluggy). */
const field = (v: unknown) => (typeof v === 'string' && v.length <= IPC_LIMITS.maxField ? v : null);

export function parseIpcCall(callId: unknown, rawOp: unknown, rawBody: unknown): ParsedCall {
  if (typeof callId !== 'string' || !CALL_ID.test(callId)) return fail(400, 'Identificador de chamada inválido.');
  const o = rawOp && typeof rawOp === 'object' && !Array.isArray(rawOp) ? (rawOp as Record<string, unknown>) : null;
  if (!o || typeof o.op !== 'string' || !ALLOWED.has(o.op)) return fail(404, 'Operação desconhecida.');
  const name = o.op as (typeof DESKTOP_IPC_OPS)[number];
  const allowedKeys: Record<string, string[]> = { 'pluggy.accounts': ['op', 'itemId'], 'pluggy.transactions': ['op', 'itemId', 'accountId', 'from', 'to'] };
  const keys = allowedKeys[name] ?? ['op'];
  if (Object.keys(o).some((k) => !keys.includes(k))) return fail(400, 'Campos inesperados na operação.');
  let op: ApiOp;
  if (name === 'pluggy.accounts') {
    const itemId = field(o.itemId);
    if (itemId === null) return fail(400, 'itemId inválido.');
    op = { op: name, itemId };
  } else if (name === 'pluggy.transactions') {
    const v = ['itemId', 'accountId', 'from', 'to'].map((k) => field(o[k] ?? ''));
    if (v.some((x) => x === null)) return fail(400, 'Parâmetros inválidos.');
    op = { op: name, itemId: v[0]!, accountId: v[1]!, from: v[2]!, to: v[3]! };
  } else {
    op = { op: name } as ApiOp;
  }
  let body: unknown = undefined;
  if (OPS_WITH_BODY.has(name)) {
    let json: string | undefined;
    try { json = JSON.stringify(rawBody ?? {}); } catch { return fail(400, 'Corpo inválido (use JSON).'); }
    if (json === undefined) return fail(400, 'Corpo inválido (use JSON).');
    if (json.length > IPC_LIMITS.maxBodyChars) return fail(413, 'Corpo da requisição muito grande.');
    // Cópia JSON simples: nada além de dados chega ao serviço; chaves de protótipo são descartadas.
    body = JSON.parse(json, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } else if (rawBody !== undefined && rawBody !== null) {
    return fail(400, 'Esta operação não recebe corpo.');
  }
  return { ok: true, id: callId, op, body };
}

export function parseCancel(callId: unknown): string | null {
  return typeof callId === 'string' && CALL_ID.test(callId) ? callId : null;
}

/** Remetente confiável: documento principal (não subframe) da janela do app, em `aurora://app`. */
export function isTrustedSenderInfo(info: { isMainFrame: boolean; frameUrl: string | undefined; isAppWindow: boolean }): boolean {
  return info.isAppWindow && info.isMainFrame && typeof info.frameUrl === 'string' && isAppUrl(info.frameUrl);
}
