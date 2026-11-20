/**
 * Alça de redimensionamento das laterais (issue #10).
 *
 * - Arrastar (mouse, caneta ou toque SÓ na alça; `touch-action: none` vale apenas para ela): largura muda na
 *   hora; ao soltar, a preferência é gravada nas configurações locais.
 * - Teclado: ←/→ (16 px), Shift+←/→ (64 px), Home/End (mínimo/máximo), Enter ou duplo clique: largura padrão.
 * - `role="separator"` vertical com `aria-valuemin/max/now` (WAI-ARIA “window splitter”).
 * - Durante o arrasto o documento fica com cursor `col-resize` e sem seleção de texto; nada no quadro muda.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { useEditor } from '../store/editor';
import { resetPanelWidth, setPanelWidth } from '../store/actions';
import { effectivePanelWidth, maxPanelWidth, PANEL_DEFAULTS, PANEL_MIN, PANEL_STEP, PANEL_STEP_LARGE, type PanelSide } from '../core/panels';

const subscribeResize = (cb: () => void) => { window.addEventListener('resize', cb); return () => window.removeEventListener('resize', cb); };
const viewportWidth = () => window.innerWidth;
export const useViewportWidth = () => useSyncExternalStore(subscribeResize, viewportWidth, () => 1280);

const OTHER: Record<PanelSide, PanelSide> = { library: 'properties', properties: 'library' };
const OPEN_KEY: Record<PanelSide, 'libraryOpen' | 'propertiesOpen'> = { library: 'libraryOpen', properties: 'propertiesOpen' };

/** Largura efetiva e limites atuais de uma lateral. */
export function usePanelLayout(side: PanelSide) {
  const vw = useViewportWidth();
  const compact = useEditor((s) => s.compact);
  const stored = useEditor((s) => s.panelWidths[side]);
  const other = useEditor((s) => s.panelWidths[OTHER[side]]);
  const otherOpen = useEditor((s) => s[OPEN_KEY[OTHER[side]]]);
  const opts = { compact, otherOpen, other };
  return { width: effectivePanelWidth(stored, vw, opts), max: compact ? Math.round(vw * 0.85) : maxPanelWidth(vw, opts), stored, compact };
}

const LABEL: Record<PanelSide, string> = { library: 'Redimensionar Biblioteca', properties: 'Redimensionar Propriedades' };

export function PanelResizer({ side, width, max }: { side: PanelSide; width: number; max: number }) {
  const drag = useRef<{ startX: number; startW: number; id: number } | null>(null);
  const min = Math.min(PANEL_MIN, max);
  // Biblioteca cresce para a direita; Propriedades, para a esquerda.
  const dir = side === 'library' ? 1 : -1;
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [max, min]);

  const end = useCallback((commit: boolean) => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove('panel-resizing');
    if (commit) void setPanelWidth(side, useEditor.getState().panelWidths[side]);
  }, [side]);
  useEffect(() => () => end(true), [end]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: width, id: e.pointerId };
    document.documentElement.classList.add('panel-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    void setPanelWidth(side, clamp(d.startW + dir * (e.clientX - d.startX)), false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? PANEL_STEP_LARGE : PANEL_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = width + dir * step;
    else if (e.key === 'ArrowLeft') next = width - dir * step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void resetPanelWidth(side); return; }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation(); // não deixa as setas moverem a seleção do quadro
    void setPanelWidth(side, clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={LABEL[side]}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels${width === PANEL_DEFAULTS[side] ? ' (padrão)' : ''}`}
      title={`${LABEL[side]} — arraste; duplo clique ou Enter restaura ${PANEL_DEFAULTS[side]} px`}
      tabIndex={0}
      data-testid={`resize-${side}`}
      className={`panel-resizer absolute inset-y-0 ${side === 'library' ? 'right-0' : 'left-0'} w-2 z-30 cursor-col-resize group outline-none`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={() => end(true)}
      onDoubleClick={() => void resetPanelWidth(side)}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent group-active:bg-accent transition-colors" />
    </div>
  );
}
