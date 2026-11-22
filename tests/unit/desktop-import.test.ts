import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImportFile } from '../../desktop/importFile';
import { IMPORT_LIMITS } from '../../src/persistence/importBudget';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, BrowserWindow: {} }));
vi.mock('electron', () => electron);
const fsMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  fsMock.open.mockImplementation(fs.open);
  return { ...fs, open: fsMock.open };
});
import { registerImportIpc } from '../../desktop/ipc';

const dir = await mkdtemp(join(tmpdir(), 'aurora-import-unit-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('leitura nativa limitada', () => {
  it('lê UTF-8 e devolve somente nome e texto, sem o caminho privado', async () => {
    const path = join(dir, 'quadro.JSON');
    await writeFile(path, '{"nome":"ação 😀"}');
    expect(await readImportFile(path)).toEqual({ name: 'quadro.JSON', text: '{"nome":"ação 😀"}' });
  });

  it('recusa extensão diferente, diretório e arquivo acima do teto antes da leitura', async () => {
    await expect(readImportFile(join(dir, 'secret.txt'))).rejects.toThrow('JSON');
    const folder = join(dir, 'folder.json');
    await mkdir(folder);
    await expect(readImportFile(folder)).rejects.toThrow();
    const path = join(dir, 'large.json');
    const file = await open(path, 'w');
    await file.truncate(IMPORT_LIMITS.maxFileBytes + 1);
    await file.close();
    await expect(readImportFile(path)).rejects.toThrow('grande demais');
  });

  it('não lê um arquivo grande e sempre fecha o descritor', async () => {
    const file = { stat: async () => ({ isFile: () => true, size: IMPORT_LIMITS.maxFileBytes + 1 }), read: vi.fn(), close: vi.fn() };
    fsMock.open.mockResolvedValueOnce(file);
    await expect(readImportFile('grande.json')).rejects.toThrow('grande demais');
    expect(file.read).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('limita também o crescimento durante a leitura e fecha o descritor ao recusar', async () => {
    // O limite menor evita alocar 200 MB no teste; o mesmo laço de leitura é exercitado.
    const original = IMPORT_LIMITS.maxFileBytes;
    Object.assign(IMPORT_LIMITS, { maxFileBytes: 4 });
    const file = {
      stat: async () => ({ isFile: () => true, size: 2 }),
      read: vi.fn(async (buffer: Buffer) => { buffer.fill(97); return { bytesRead: buffer.length }; }),
      close: vi.fn(),
    };
    fsMock.open.mockResolvedValueOnce(file);
    try {
      await expect(readImportFile('crescendo.json')).rejects.toThrow('grande demais');
      expect(file.read).toHaveBeenCalledOnce();
      expect(file.close).toHaveBeenCalledOnce();
    } finally { Object.assign(IMPORT_LIMITS, { maxFileBytes: original }); }
  });
});

describe('IPC do seletor nativo', () => {
  const frame = { url: 'aurora://app/index.html' };
  const sender = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: frame };
  let invoke: (event: unknown, ...args: unknown[]) => Promise<unknown>;
  beforeEach(() => {
    vi.clearAllMocks();
    registerImportIpc(() => win as never);
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('aurora:import-file', expect.any(Function));
    invoke = electron.ipcMain.handle.mock.calls[0][1];
  });

  it('recusa subframe, outra janela, outra origem e argumentos/caminhos fornecidos pelo renderer', async () => {
    for (const bad of [{ ...event, senderFrame: { url: frame.url } }, { ...event, sender: { mainFrame: frame } }]) {
      expect(await invoke(bad)).toHaveProperty('error');
    }
    frame.url = 'https://example.com';
    try { expect(await invoke(event)).toHaveProperty('error'); } finally { frame.url = 'aurora://app/index.html'; }
    expect(await invoke(event, join(dir, 'quadro.JSON'))).toHaveProperty('error');
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('cancela sem ler; só um seletor simultâneo; nova chamada funciona depois de cancelar', async () => {
    let cancel!: (r: unknown) => void;
    electron.dialog.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => { cancel = resolve; }));
    const pending = invoke(event);
    expect(await invoke(event)).toEqual({ canceled: true });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledOnce();
    cancel({ canceled: true, filePaths: [join(dir, 'nao-existe.json')] });
    expect(await pending).toEqual({ canceled: true });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(event)).toEqual({ canceled: true });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(2);
  });

  it('usa só a seleção do SO; erros não vazam caminhos e não mantêm a trava', async () => {
    const path = join(dir, 'selecionado.json');
    await writeFile(path, '{}');
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    expect(await invoke(event)).toEqual({ canceled: false, name: 'selecionado.json', text: '{}' });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(win, expect.objectContaining({ properties: ['openFile'] }));
    electron.dialog.showOpenDialog.mockRejectedValueOnce(new Error(`segredo ${path}`));
    expect(await invoke(event)).toEqual({ error: 'Não foi possível ler o arquivo selecionado.' });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(event)).toEqual({ canceled: true });
  });

  it('descarta a seleção se o documento deixou de ser confiável enquanto o diálogo estava aberto', async () => {
    electron.dialog.showOpenDialog.mockImplementationOnce(async () => {
      frame.url = 'https://example.com';
      return { canceled: false, filePaths: [join(dir, 'nao-existe.json')] };
    });
    try { expect(await invoke(event)).toEqual({ canceled: true }); } finally { frame.url = 'aurora://app/index.html'; }
  });
});
