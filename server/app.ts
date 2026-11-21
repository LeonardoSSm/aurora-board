/**
 * Lógica HTTP do servidor local do Aurora Board (testável: dependências injetáveis). As operações em si ficam em
 * server/apiService.ts (D1-B), compartilhadas com o IPC do aplicativo desktop; aqui ficam só as proteções HTTP
 * (Host, Origin, par TCP, pareamento, Content-Type, tamanho do corpo) e o mapeamento rota → operação.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/ai/providers        → provedores e se estão configurados (sem expor chaves)
 *   POST /api/ai/chat             → { provider, model?, system, messages[] }
 *   POST /api/link-preview        → { url } → título/descrição/imagem (Open Graph)
 *   POST /api/pairing/code | GET /api/pairing/devices | POST /api/pairing/revoke   (só este computador)
 *   POST /api/pairing/claim | GET /api/pairing/status                          (outro computador, via proxy)
 *   GET  /api/pluggy/status | /api/pluggy/accounts?itemId | /api/pluggy/transactions?itemId&accountId&from&to
 *        → Meu Pluggy, somente leitura (server/pluggy.ts). Só no computador principal, salvo
 *          AURORA_PLUGGY_PAIRED_READ=1 (leitura também por dispositivos pareados).
 *   GET  /api/net/status | POST /api/net/fetch { url, method:'GET', responseType, timeoutMs }
 *        → H2: consulta GET autorizada de widgets HTML (server/netBridge.ts). Só no computador principal.
 *
 * Proteções do próprio servidor (uso local, sem autenticação):
 *   - Host precisa ser local (anti DNS rebinding);
 *   - Origin, se presente, precisa ser local (anti CSRF a partir de sites visitados);
 *   - POST exige Content-Type: application/json (força preflight CORS, que não é respondido);
 *   - corpo limitado; mensagens de erro sem segredos.
 *
 * Dispositivos pareados (server/pairing.ts): chamadas de outro computador da rede só chegam pelo proxy do
 * Vite com o pareamento LIGADO (AURORA_LAN_PAIRING=1), marcadas com `x-aurora-remote: 1`, e exigem
 * `Authorization: Bearer <token>` de um dispositivo pareado. Conexões diretas de fora continuam recusadas.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isAllowedLanHost, isSameOriginForHost, type PairingStore } from './pairing';
import { isAllowedHostHeader, isAllowedOrigin, isLoopbackAddress } from './netSafety';
import { createApiService, errorResult, HttpError, resolvePluggy, type ApiResult, type ServiceDeps } from './apiService';
import { routeOp } from '../src/integrations/apiRoutes';

export { DEFAULT_LIMITS_BY_ROUTE, linkPreview, validateChat, type LinkPreviewDeps, type PluggyDeps, type RouteLimit } from './apiService';

const MAX_BODY = 2 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendResult(res: ServerResponse, r: ApiResult) {
  if (r.retryAfter && !res.headersSent) res.setHeader('retry-after', String(r.retryAfter));
  send(res, r.status, r.body);
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type deve ser application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Corpo da requisição muito grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export interface AppDeps extends ServiceDeps {
  /** Decide se o par TCP é local (injetável nos testes). */
  isLocalPeer?: (addr: string | undefined) => boolean;
  /** Dispositivos pareados. Sem isso, chamadas remotas são sempre recusadas. */
  pairing?: PairingStore | null;
}

export function createApp(deps: AppDeps = {}): RequestListener {
  const log = deps.log ?? ((m: string) => console.error(m));
  const isLocalPeer = deps.isLocalPeer ?? isLoopbackAddress;
  const service = createApiService(deps);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!isLocalPeer(req.socket?.remoteAddress)) throw new HttpError(403, 'Somente conexões locais.');
      const pairing = deps.pairing ?? null;
      // Marcado pelo proxy do Vite (que descarta o cabeçalho vindo do cliente). Processos desta máquina estão
      // fora do modelo de ameaça; de todo modo, sem token válido nada é atendido.
      const remote = req.headers['x-aurora-remote'] === '1';
      const remoteAddr = String(req.headers['x-aurora-remote-addr'] ?? '').slice(0, 64) || undefined;
      if (remote) {
        if (!pairing) throw new HttpError(403, 'Pareamento de dispositivos desativado neste servidor.');
        if (!isAllowedLanHost(req.headers.host)) throw new HttpError(403, 'Host não permitido para dispositivo pareado.');
        if (!isSameOriginForHost(req.headers.origin as string | undefined, req.headers.host)) throw new HttpError(403, 'Origem não permitida.');
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
        if (req.method === 'POST' && url.pathname === '/api/pairing/claim') {
          const body = (await readJSON(req)) as { code?: unknown; name?: unknown };
          const r = pairing.claim(body.code, body.name, remoteAddr);
          log(`[api] dispositivo pareado: ${r.device.name} (${remoteAddr ?? '?'})`);
          return send(res, 200, r);
        }
        const device = pairing.verify(req.headers.authorization as string | undefined, remoteAddr);
        if (!device) throw new HttpError(401, 'Este computador não está pareado com o Aurora Board principal.', 'pairing_required');
        if (req.method === 'GET' && url.pathname === '/api/pairing/status') return send(res, 200, { paired: true, device: { id: device.id, name: device.name } });
        if (url.pathname.startsWith('/api/pairing/')) throw new HttpError(403, 'Pareamentos só podem ser gerenciados no computador principal.');
      } else {
        if (!isAllowedHostHeader(req.headers.host)) throw new HttpError(403, 'Host não permitido.');
        if (!isAllowedOrigin(req.headers.origin as string | undefined)) throw new HttpError(403, 'Origem não permitida.');
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; } // sem cabeçalhos CORS: nega origens externas
        if (url.pathname.startsWith('/api/pairing/')) {
          if (!pairing) throw new HttpError(404, 'Pareamento indisponível.');
          if (req.method === 'GET' && url.pathname === '/api/pairing/status') return send(res, 200, { paired: true, local: true });
          if (req.method === 'GET' && url.pathname === '/api/pairing/devices') return send(res, 200, { devices: pairing.list(), pending: pairing.pendingCode() });
          if (req.method === 'POST' && url.pathname === '/api/pairing/code') { await readJSON(req); return send(res, 200, pairing.createCode()); }
          if (req.method === 'POST' && url.pathname === '/api/pairing/cancel') { await readJSON(req); pairing.cancelCode(); return send(res, 200, { ok: true }); }
          if (req.method === 'POST' && url.pathname === '/api/pairing/revoke') {
            const body = (await readJSON(req)) as { id?: unknown };
            if (!pairing.revoke(body.id)) throw new HttpError(404, 'Dispositivo não encontrado.');
            return send(res, 200, { ok: true });
          }
          throw new HttpError(404, 'Rota não encontrada.');
        }
      }

      const op = routeOp(req.method ?? 'GET', url);
      if (op === 'method-not-allowed') {
        // Mesma ordem de antes: pareado sem permissão de leitura bancária recebe 403 antes do 405.
        if (remote && !resolvePluggy(deps.pluggy).allowPaired) throw new HttpError(403, 'O Meu Pluggy só pode ser consultado no computador principal.', 'local_only');
        throw new HttpError(405, 'Somente leitura.');
      }
      if (!op) throw new HttpError(404, 'Rota não encontrada.');
      // Cliente desistiu (fechou a conexão) → a operação externa é cancelada (IA, Pluggy, rede dos widgets).
      const ctrl = new AbortController();
      const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
      res.on('close', onClose);
      try {
        return sendResult(res, await service.call(op, { signal: ctrl.signal, remote, readBody: () => readJSON(req) }));
      } finally {
        res.off('close', onClose);
      }
    } catch (e) {
      sendResult(res, errorResult(e, log, `${req.method} ${url.pathname}`));
    }
  };
}
