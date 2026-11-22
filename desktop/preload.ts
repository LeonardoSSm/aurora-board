/**
 * Preload do Aurora Board Desktop — roda isolado (contextIsolation + sandbox) e só no documento principal
 * (`nodeIntegrationInSubFrames: false`: o iframe dos widgets HTML não recebe nada).
 *
 * Expõe UM objeto congelado, sem `require`, `process`, `ipcRenderer` ou objetos do Electron. As chamadas viram
 * canais IPC fixos; o processo principal revalida remetente, operação e argumentos (desktop/ipcValidation.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = Object.freeze({
  /** Operação da API local (mesmas da versão web): resultado `{ status, body, retryAfter? }`. */
  call: (callId: string, op: unknown, body?: unknown) => ipcRenderer.invoke('aurora:api', String(callId), op, body),
  cancel: (callId: string) => { void ipcRenderer.invoke('aurora:api-cancel', String(callId)); },
});

/** Credenciais: só status e escrita — o valor nunca volta ao renderer. */
const secrets = Object.freeze({
  status: () => ipcRenderer.invoke('aurora:secrets-status'),
  set: (name: string, value: string, mode: 'vault' | 'session') => ipcRenderer.invoke('aurora:secrets-set', String(name), String(value), String(mode)),
  clear: (name: string) => ipcRenderer.invoke('aurora:secrets-clear', String(name)),
});

/** Encerramento seguro: o processo principal pede para gravar o pendente antes de fechar a janela. */
const lifecycle = Object.freeze({
  onBeforeClose: (handler: () => Promise<boolean>) => {
    ipcRenderer.removeAllListeners('aurora:before-close');
    ipcRenderer.on('aurora:before-close', async () => {
      let ok = false;
      try { ok = (await handler()) === true; } catch { ok = false; }
      void ipcRenderer.invoke('aurora:close-ready', ok);
    });
  },
  /** Itens do menu nativo (Importar, Migrar, Exportar, Configurações): só nomes da allowlist. */
  onMenu: (handler: (action: string) => void) => {
    ipcRenderer.removeAllListeners('aurora:menu');
    ipcRenderer.on('aurora:menu', (_e, action: unknown) => { if (typeof action === 'string') handler(action); });
  },
});

contextBridge.exposeInMainWorld('auroraDesktop', Object.freeze({
  isDesktop: true as const,
  platform: process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'other',
  api,
  secrets,
  files: Object.freeze({ pickImport: () => ipcRenderer.invoke('aurora:import-file') }),
  lifecycle,
}));
