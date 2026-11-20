/** Issue #15: abrir a Aurora Wheel sem o gesto (atalho W, botão “Criar”). */
import { getState } from '../store/editor';
import { screenToWorld, viewportCenterWorld, worldToScreen } from '../store/actions';
import { getCanvasRect } from '../canvas/Canvas';
import { openRadialAt } from '../canvas/radialGesture';

/**
 * No ponto do mouse sobre o quadro (se houver) ou no centro da área visível. O item nasce nesse ponto do mundo.
 * Não abre com diálogo, edição ou outra roda aberta.
 */
export function openRadialFromKeyboard(pointerWorld: { x: number; y: number } | null) {
  const s = getState();
  if (s.radial || s.dialog || s.checkpointEditor || s.shortcutsOpen || s.boardsPanelOpen || s.editingTextId) return;
  const r = getCanvasRect();
  if (pointerWorld) {
    const sp = worldToScreen(pointerWorld);
    openRadialAt({ x: r.left + sp.x, y: r.top + sp.y }, pointerWorld);
    return;
  }
  const world = viewportCenterWorld();
  const sp = worldToScreen(world);
  openRadialAt({ x: r.left + sp.x, y: r.top + sp.y }, Number.isFinite(world.x) ? world : screenToWorld({ x: 0, y: 0 }));
}
