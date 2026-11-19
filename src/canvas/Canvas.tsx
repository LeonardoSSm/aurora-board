import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useEditor, getState, setState } from '../store/editor';
import { boxesIntersect, getElementBounds } from '../core/geometry';
import { addWidget, insertImageFiles, panBy, pickImages, putAsset, screenToWorld, zoomAt } from '../store/actions';
import { cameraTarget, cancelCameraAnimation, zoomTowardAnchor } from '../store/cameraMotion';
import { isWheelNotch, normalizeWheel, wheelZoomFactor } from '../core/camera';
import { toast } from '../store/ui';
import { WIDGET } from '../core/widgetIds';
import { uid } from '../core/elements';
import { ElementView } from './ElementView';
import { Overlay } from './Overlay';
import { TextEditor } from './TextEditor';
import { cancelGesture, currentGesture, doubleClick, elementAt, isSpaceHeld, pointerCancel, pointerDown, pointerMove, pointerUp, type PointerInfo } from './controller';
import { hitHandle, linearHandles, transformHandles } from './handles';
import { handleCursor } from '../core/transform';
import { isLinear } from '../core/schema';

export const WIDGET_DRAG_MIME = 'application/x-aurora-widget';

/**
 * Retângulo do canvas em cache (atualizado por ResizeObserver/resize). Ler getBoundingClientRect a cada
 * evento de ponteiro/roda forçava recálculo de layout de todos os elementos logo após cada mudança de câmera.
 */
let canvasRect: DOMRect | null = null;
export function getCanvasRect(): { left: number; top: number; right: number; bottom: number } {
  if (canvasRect) return canvasRect;
  const el = document.querySelector('[data-testid="canvas"]');
  return el ? el.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
}

const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], [data-interactive], iframe, label';

function useVisibleElements() {
  const elements = useEditor((s) => s.elements);
  const camera = useEditor((s) => s.camera);
  const viewport = useEditor((s) => s.viewport);
  const selectedIds = useEditor((s) => s.selectedIds);
  const editingTextId = useEditor((s) => s.editingTextId);
  return useMemo(() => {
    const margin = 200 / camera.zoom;
    const view = {
      minX: -camera.x / camera.zoom - margin,
      minY: -camera.y / camera.zoom - margin,
      maxX: (viewport.width - camera.x) / camera.zoom + margin,
      maxY: (viewport.height - camera.y) / camera.zoom + margin,
    };
    const keep = new Set(selectedIds);
    if (editingTextId) keep.add(editingTextId);
    return elements.filter((el) => keep.has(el.id) || boxesIntersect(view, getElementBounds(el)));
  }, [elements, camera, viewport, selectedIds, editingTextId]);
}

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const camera = useEditor((s) => s.camera);
  const tool = useEditor((s) => s.tool);
  const selectedIds = useEditor((s) => s.selectedIds);
  const editingTextId = useEditor((s) => s.editingTextId);
  const eraserPending = useEditor((s) => s.eraserPending);
  const settings = useEditor((s) => s.boards.find((b) => b.id === s.boardId)?.settings);
  const visible = useVisibleElements();
  const [cursor, setCursor] = useState('default');
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const eraseSet = useMemo(() => new Set(eraserPending), [eraserPending]);

  // Tamanho do viewport
  useEffect(() => {
    const el = ref.current!;
    const update = () => {
      canvasRect = el.getBoundingClientRect();
      const vp = getState().viewport;
      if (vp.width !== el.clientWidth || vp.height !== el.clientHeight) cancelCameraAnimation();
      setState({ viewport: { width: el.clientWidth, height: el.clientHeight } });
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    update();
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  // Roda do mouse / touchpad (não-passivo para poder impedir o zoom do navegador)
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      const widget = target.closest('[data-widget-body]');
      if (widget && !e.ctrlKey) {
        const id = widget.getAttribute('data-widget-body');
        const scrollable = target.closest('[data-scrollable]') as HTMLElement | null;
        if (id && getState().selectedIds.includes(id) && scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
      }
      e.preventDefault();
      const rect = getCanvasRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const s = getState();
      const wheelMode = s.boards.find((b) => b.id === s.boardId)?.settings.wheelMode ?? 'zoom';
      const pixelMode = e.deltaMode === 0;
      // Touchpad (rolagem com dois dedos) continua fazendo pan no modo "zoom": deslocamento horizontal
      // ou eventos pequenos fracionários. Rodas (cliques ou alta resolução) dão zoom.
      const trackpadLike = pixelMode && (Math.abs(e.deltaX) > 0 || (Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)));
      const { dx, dy } = normalizeWheel(e, window.innerHeight);
      if (e.ctrlKey || e.metaKey) {
        const factor = wheelZoomFactor(e, s.zoomPrefs, window.innerHeight);
        // Pinça do touchpad: aplicada direto (segue os dedos). Ctrl + clique de roda: suave e acumulado.
        if (isWheelNotch(e)) zoomTowardAnchor(factor, anchor);
        else zoomAt(cameraTarget().zoom * factor, anchor);
      } else if (e.shiftKey) {
        panBy(-(dy || dx), 0);
      } else if (wheelMode === 'zoom' && !trackpadLike) {
        zoomTowardAnchor(wheelZoomFactor(e, s.zoomPrefs, window.innerHeight), anchor);
      } else {
        panBy(-dx, -dy);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const info = (e: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): PointerInfo => {
    const rect = getCanvasRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const pe = e as Partial<PointerEvent>;
    return {
      screen,
      world: screenToWorld(screen),
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      pointerType: pe.pointerType ?? 'mouse',
      pointerId: pe.pointerId ?? 1,
      pressure: pe.pressure || 0.5,
    };
  };

  const computeCursor = (p: PointerInfo) => {
    const s = getState();
    if (s.tool === 'hand' || isSpaceHeld()) return currentGesture()?.type === 'pan' ? 'grabbing' : 'grab';
    if (s.tool === 'eraser') return 'cell';
    if (s.tool === 'text') return 'text';
    if (s.tool !== 'select') return 'crosshair';
    const selected = s.elements.filter((e) => s.selectedIds.includes(e.id));
    if (selected.length === 1 && isLinear(selected[0]) && hitHandle(linearHandles(selected[0], s.camera), p.screen, 10)) return 'pointer';
    const th = hitHandle(transformHandles(selected, s.camera), p.screen, 9);
    if (th) return th.kind === 'rotate' ? 'grab' : handleCursor(th.handle!, th.angle);
    const hit = elementAt(p.world);
    if (hit) return hit.locked ? 'not-allowed' : 'move';
    return 'default';
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-text-editor], [data-testid="text-editor"]')) return;
    if (target.closest(INTERACTIVE) && getState().tool === 'select') return;
    if (e.button === 2) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    ref.current!.focus({ preventScroll: true });
    try { ref.current!.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Impede a ação padrão (foco/seleção de texto/autoscroll): o foco é gerenciado aqui,
    // e o editor de texto aberto por este clique não pode perdê-lo para o canvas.
    e.preventDefault();
    pointerDown(info(e));
    setCursor(computeCursor(info(e)));
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = info(e);
    pointerMove(p);
    if (!currentGesture()) setCursor(computeCursor(p));
    else if (currentGesture()?.type === 'pan') setCursor('grabbing');
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    try { ref.current!.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pointerUp(info(e));
    setCursor(computeCursor(info(e)));
  };

  useEffect(() => {
    const onBlur = () => cancelGesture();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const grid = settings?.grid && camera.zoom > 0.3;
  const gridSize = (settings?.gridSize ?? 20) * camera.zoom;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="application"
      aria-label="Quadro branco infinito"
      data-testid="canvas"
      data-tool={tool}
      className="absolute inset-0 overflow-hidden bg-canvas outline-none touch-none select-none"
      style={{
        cursor,
        backgroundImage: grid ? 'radial-gradient(circle, #283a52 1px, transparent 1.2px)' : undefined,
        backgroundSize: grid ? `${gridSize}px ${gridSize}px` : undefined,
        backgroundPosition: grid ? `${camera.x}px ${camera.y}px` : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => pointerCancel(info(e))}
      onPointerLeave={() => { if (!currentGesture() && getState().hoverId) setState({ hoverId: null }); }}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest(INTERACTIVE) || target.closest('[data-widget-root]')) return;
        doubleClick(info(e).world);
      }}
      onContextMenu={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        const p = info(e);
        const hit = elementAt(p.world);
        if (hit && !getState().selectedIds.includes(hit.id)) setState({ selectedIds: [hit.id] });
        setState({ contextMenu: { x: e.clientX, y: e.clientY, world: p.world, targetId: hit?.id ?? null } });
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(WIDGET_DRAG_MIME) || e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={async (e) => {
        const p = info(e).world;
        const type = e.dataTransfer.getData(WIDGET_DRAG_MIME);
        if (type) {
          e.preventDefault();
          if (type === 'tool:image') void pickImages(p);
          else addWidget(type, p);
          return;
        }
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        const images = files.filter((f) => f.type.startsWith('image/'));
        const others = files.filter((f) => !f.type.startsWith('image/'));
        if (images.length) await insertImageFiles(images, p);
        if (others.length) {
          const docs = [];
          for (const f of others) {
            try {
              const assetId = await putAsset(f, f.name);
              docs.push({ id: uid(), name: f.name, mimeType: f.type, size: f.size, assetId, url: '', description: '', tags: [], addedAt: Date.now() });
            } catch (err) {
              toast(`"${f.name}": ${(err as Error).message}`, 'error');
            }
          }
          if (docs.length) addWidget(WIDGET.documents, p, { docs, selected: docs[0].id });
        }
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`, willChange: 'transform' }}
        data-testid="world"
      >
        {visible.map((el) => (
          <ElementView key={el.id} el={el} editing={editingTextId === el.id} selected={selSet.has(el.id)} erasing={eraseSet.has(el.id)} />
        ))}
        <TextEditor />
      </div>
      <Overlay />
    </div>
  );
}
