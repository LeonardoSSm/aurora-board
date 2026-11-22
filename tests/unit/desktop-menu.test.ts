import { describe, expect, it, vi } from 'vitest';
import { createMenuHandler } from '../../src/desktop/menu';
import { MENU_ACTIONS } from '../../desktop/menuActions';

const actions = () => ({ import: vi.fn(async () => {}), migrate: vi.fn(async () => {}), 'export-workspace': vi.fn(async () => {}), settings: vi.fn(async () => {}) });

describe('menu nativo: diálogos e operações concorrentes', () => {
  it('recusa todas as ações enquanto outro diálogo está aberto e ignora nomes fora da allowlist', async () => {
    const run = actions();
    let dialog = true;
    const menu = createMenuHandler(run, () => dialog, vi.fn());
    for (const action of MENU_ACTIONS) await menu(action);
    for (const fn of Object.values(run)) expect(fn).not.toHaveBeenCalled();
    dialog = false;
    for (const action of ['constructor', 'quit', null, {}]) await menu(action);
    for (const action of MENU_ACTIONS) { await menu(action); expect(run[action]).toHaveBeenCalledOnce(); }
  });

  it('mantém a trava durante a promessa inteira e libera após cancelar/confirmar', async () => {
    const run = actions();
    let finish!: () => void;
    run.import.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const menu = createMenuHandler(run, () => false, vi.fn());
    const pending = menu('import');
    for (const action of MENU_ACTIONS) await menu(action);
    expect(run.import).toHaveBeenCalledOnce();
    expect(run.settings).not.toHaveBeenCalled();
    expect(run.migrate).not.toHaveBeenCalled();
    expect(run['export-workspace']).not.toHaveBeenCalled();
    finish();
    await pending;
    await menu('settings');
    expect(run.settings).toHaveBeenCalledOnce();
  });

  it('trata rejeição sem promessa abandonada e libera ações posteriores', async () => {
    const run = actions(), error = vi.fn();
    run.import.mockRejectedValueOnce(new Error('falha de leitura'));
    const menu = createMenuHandler(run, () => false, error);
    await expect(menu('import')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    await menu('migrate');
    expect(run.migrate).toHaveBeenCalledOnce();
  });
});
