import { isMenuAction, type MenuAction } from '../../desktop/menuActions';

/** A trava cobre também os intervalos assíncronos em que a operação ainda não abriu um diálogo. */
export function createMenuHandler(
  actions: Record<MenuAction, () => Promise<void>>,
  blocked: () => boolean,
  onError: () => void,
) {
  let busy = false;
  return async (action: unknown): Promise<void> => {
    if (!isMenuAction(action) || busy || blocked()) return;
    busy = true;
    try { await actions[action](); }
    catch { onError(); }
    finally { busy = false; }
  };
}
