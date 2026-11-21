/**
 * D1-B — IPC do Aurora Board Desktop: as integrações (IA, HTML Network Bridge, Meu Pluggy, pré-visualização de
 * links) rodam no processo principal com o MESMO serviço da API local da web (server/apiService.ts), sem servidor
 * HTTP. Cada chamada: remetente confiável → validação (desktop/ipcValidation.ts) → limites do serviço → resultado.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { ApiService } from '../server/apiService';
import type { ApiResult } from '../src/integrations/apiRoutes';
import { IPC_LIMITS, isTrustedSenderInfo, parseCancel, parseIpcCall } from './ipcValidation';

export function isTrustedSender(e: IpcMainInvokeEvent, appWindow: () => BrowserWindow | null): boolean {
  const win = appWindow();
  const frame = e.senderFrame;
  return isTrustedSenderInfo({
    isAppWindow: !!win && !win.isDestroyed() && e.sender === win.webContents,
    isMainFrame: !!frame && frame === e.sender.mainFrame,
    frameUrl: frame?.url,
  });
}

export function registerIpc(service: ApiService, appWindow: () => BrowserWindow | null, log: (m: string) => void = (m) => console.error(m)) {
  /** Operações em andamento por janela (webContents.id) → callId → cancelamento. */
  const pending = new Map<number, Map<string, AbortController>>();
  const watched = new WeakSet<WebContents>();
  const abortAll = (wc: WebContents) => {
    const m = pending.get(wc.id);
    if (!m) return;
    for (const c of m.values()) c.abort();
    pending.delete(wc.id);
  };
  const watch = (wc: WebContents) => {
    if (watched.has(wc)) return;
    watched.add(wc);
    // Recarregar, navegar, travar ou fechar a janela cancela tudo o que ela pediu.
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) abortAll(wc); });
    wc.on('render-process-gone', () => abortAll(wc));
    wc.once('destroyed', () => abortAll(wc));
  };

  ipcMain.handle('aurora:api', async (e, callId: unknown, op: unknown, body: unknown): Promise<ApiResult> => {
    if (!isTrustedSender(e, appWindow)) return { status: 403, body: { error: 'Remetente não autorizado.' } };
    const parsed = parseIpcCall(callId, op, body);
    if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
    watch(e.sender);
    let m = pending.get(e.sender.id);
    if (!m) { m = new Map(); pending.set(e.sender.id, m); }
    if (m.has(parsed.id)) return { status: 409, body: { error: 'Chamada repetida.' } };
    if (m.size >= IPC_LIMITS.maxPending) return { status: 429, body: { error: 'Muitas operações em andamento.' }, retryAfter: 2 };
    const ctrl = new AbortController();
    m.set(parsed.id, ctrl);
    try {
      return await service.call(parsed.op, { signal: ctrl.signal, remote: false, readBody: async () => parsed.body });
    } catch (err) {
      log(`[ipc] ${parsed.op.op}: falha inesperada (${(err as Error)?.name ?? 'erro'})`);
      return { status: 500, body: { error: 'Erro interno.' } };
    } finally {
      m.delete(parsed.id);
    }
  });

  ipcMain.handle('aurora:api-cancel', (e, callId: unknown) => {
    if (!isTrustedSender(e, appWindow)) return;
    const id = parseCancel(callId);
    if (id) pending.get(e.sender.id)?.get(id)?.abort();
  });
}
