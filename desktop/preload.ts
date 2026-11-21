/**
 * Preload do Aurora Board Desktop — roda isolado (contextIsolation + sandbox) e só no documento principal
 * (`nodeIntegrationInSubFrames: false`: o iframe dos widgets HTML não recebe nada).
 *
 * Expõe UM objeto congelado, sem `require`, `process`, `ipcRenderer` ou objetos do Electron. As chamadas viram
 * dois canais IPC fixos; o processo principal revalida remetente, operação e argumentos (desktop/ipcValidation.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = Object.freeze({
  /** Operação da API local (mesmas da versão web): resultado `{ status, body, retryAfter? }`. */
  call: (callId: string, op: unknown, body?: unknown) => ipcRenderer.invoke('aurora:api', String(callId), op, body),
  cancel: (callId: string) => { void ipcRenderer.invoke('aurora:api-cancel', String(callId)); },
});

contextBridge.exposeInMainWorld('auroraDesktop', Object.freeze({
  isDesktop: true as const,
  platform: process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'other',
  api,
}));
