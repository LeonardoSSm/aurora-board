/** Issue #14: abrir o Command Center e a Captura rápida (atalhos, barra superior, paleta). */
import { getState, setState } from '../store/editor';

const blocked = () => {
  const s = getState();
  return !!s.dialog || s.shortcutsOpen || !!s.checkpointEditor || !!s.radial;
};

export function openCommandCenter() {
  if (blocked()) return;
  setState({ commandOpen: true, captureOpen: false, contextMenu: null });
}

export function openCapture() {
  if (blocked()) return;
  setState({ captureOpen: true, commandOpen: false, contextMenu: null });
}
