/**
 * Preload do Aurora Board Desktop — roda isolado (contextIsolation + sandbox) e só no documento principal
 * (`nodeIntegrationInSubFrames: false`: o iframe dos widgets HTML não recebe nada).
 *
 * Expõe UM objeto congelado, sem `require`, `process`, `ipcRenderer` ou objetos do Electron.
 */
import { contextBridge } from 'electron';

const api = Object.freeze({
  isDesktop: true as const,
  platform: process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'other',
});

contextBridge.exposeInMainWorld('auroraDesktop', api);
