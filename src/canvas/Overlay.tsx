import { useEditor } from '../store/editor';
import type { AuroraElement } from '../core/schema';
import { isBindable, isLinear } from '../core/schema';
import { CONNECTION_POINTS, fixedPointToWorld, getCommonBounds, getElementBounds } from '../core/geometry';
import { HANDLE_SIZE, linearHandles, selectionFrame, toScreen, transformHandles } from './handles';

const ACCENT = '#8f9bff';

function Outline({ el, dashed, color = ACCENT }: { el: AuroraElement; dashed?: boolean; color?: string }) {
  const cam = useEditor((s) => s.camera);
  const f = selectionFrame([el], cam);
  if (!f) return null;
  if (isLinear(el)) return null;
  return <polygon points={f.corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={color} strokeWidth={1} strokeDasharray={dashed ? '4 3' : undefined} />;
}

export function Overlay() {
  const cam = useEditor((s) => s.camera);
  const elements = useEditor((s) => s.elements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const marquee = useEditor((s) => s.marquee);
  const bindingHint = useEditor((s) => s.bindingHint);
  const hoverId = useEditor((s) => s.hoverId);
  const tool = useEditor((s) => s.tool);
  const editingGroupId = useEditor((s) => s.editingGroupId);
  const editingTextId = useEditor((s) => s.editingTextId);
  const interacting = useEditor((s) => s.interacting);
  const snapGuides = useEditor((s) => s.snapGuides);
  const selectedPoint = useEditor((s) => s.selectedPointIndex);
  const drafting = useEditor((s) => s.linearDraftId);

  const selSet = new Set(selectedIds);
  const selected = elements.filter((e) => selSet.has(e.id));
  const showHandles = !editingTextId && !(interacting && selected.length === 0);
  const frame = selected.length ? selectionFrame(selected, cam) : null;
  const handles = showHandles ? transformHandles(selected, cam) : [];
  const single = selected.length === 1 ? selected[0] : null;
  const lHandles = single && isLinear(single) && showHandles ? linearHandles(single, cam).filter((h) => !drafting || (h.kind === 'point' && h.index < single.points.length - 1)) : [];
  const hover = hoverId && !selSet.has(hoverId) && tool === 'select' && !interacting ? elements.find((e) => e.id === hoverId) : null;
  const hintEl = bindingHint ? elements.find((e) => e.id === bindingHint.elementId) : null;
  const groupBox = editingGroupId ? getCommonBounds(elements.filter((e) => e.groupIds.includes(editingGroupId))) : null;

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" data-testid="overlay">
      {groupBox && (
        <rect
          x={toScreen({ x: groupBox.minX, y: groupBox.minY }, cam).x - 8}
          y={toScreen({ x: groupBox.minX, y: groupBox.minY }, cam).y - 8}
          width={(groupBox.maxX - groupBox.minX) * cam.zoom + 16}
          height={(groupBox.maxY - groupBox.minY) * cam.zoom + 16}
          fill="none"
          stroke="#f3c577"
          strokeDasharray="6 4"
          rx={6}
        />
      )}
      {hover && !isLinear(hover) && <Outline el={hover} color="#5d6bd8" />}
      {hover && isLinear(hover) && (() => {
        const b = getElementBounds(hover);
        const a = toScreen({ x: b.minX, y: b.minY }, cam);
        return <rect x={a.x - 4} y={a.y - 4} width={(b.maxX - b.minX) * cam.zoom + 8} height={(b.maxY - b.minY) * cam.zoom + 8} fill="none" stroke="#5d6bd8" strokeDasharray="3 3" />;
      })()}
      {selected.length > 1 && selected.map((el) => <Outline key={el.id} el={el} dashed color="#7d86d8" />)}
      {frame && !(single && isLinear(single)) && (
        <polygon points={frame.corners.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={1.25} strokeDasharray={selected.length > 1 ? '5 4' : undefined} />
      )}
      {single && isLinear(single) && !drafting && (() => {
        const b = getElementBounds(single);
        const a = toScreen({ x: b.minX, y: b.minY }, cam);
        return <rect x={a.x - 6} y={a.y - 6} width={(b.maxX - b.minX) * cam.zoom + 12} height={(b.maxY - b.minY) * cam.zoom + 12} fill="none" stroke={ACCENT} strokeOpacity={0.5} strokeDasharray="4 4" />;
      })()}
      {handles.map((h, i) =>
        h.kind === 'rotate' ? (
          <circle key={i} cx={h.pos.x} cy={h.pos.y} r={5.5} fill="#151c2c" stroke={ACCENT} strokeWidth={1.5} data-handle="rotate" />
        ) : (
          <rect
            key={i}
            x={h.pos.x - HANDLE_SIZE / 2}
            y={h.pos.y - HANDLE_SIZE / 2}
            width={HANDLE_SIZE}
            height={HANDLE_SIZE}
            rx={2}
            fill="#151c2c"
            stroke={ACCENT}
            strokeWidth={1.5}
            transform={`rotate(${(h.angle * 180) / Math.PI} ${h.pos.x} ${h.pos.y})`}
            data-handle={h.handle}
          />
        ),
      )}
      {lHandles.map((h, i) =>
        h.kind === 'mid' ? (
          <circle key={i} cx={h.pos.x} cy={h.pos.y} r={4} fill={ACCENT} fillOpacity={0.28} stroke={ACCENT} strokeOpacity={0.7} strokeWidth={1} data-handle="mid" />
        ) : (
          <circle
            key={i}
            cx={h.pos.x}
            cy={h.pos.y}
            r={selectedPoint === h.index ? 6.5 : 5.5}
            fill={selectedPoint === h.index ? ACCENT : '#151c2c'}
            stroke={ACCENT}
            strokeWidth={1.5}
            data-handle="point"
          />
        ),
      )}
      {hintEl && isBindable(hintEl) && (
        <g>
          <Outline el={hintEl} color="#5addaa" />
          {CONNECTION_POINTS.map((fp, i) => {
            const p = toScreen(fixedPointToWorld(hintEl, fp), cam);
            const active = bindingHint?.fixedPoint && bindingHint.fixedPoint[0] === fp[0] && bindingHint.fixedPoint[1] === fp[1];
            return <circle key={i} cx={p.x} cy={p.y} r={active ? 6 : 4} fill={active ? '#5addaa' : '#0c1420'} stroke="#5addaa" strokeWidth={1.5} />;
          })}
        </g>
      )}
      {snapGuides.map((g, i) => {
        const a = toScreen({ x: g.x1, y: g.y1 }, cam), b = toScreen({ x: g.x2, y: g.y2 }, cam);
        return <line key={i} data-testid="snap-guide" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ff6b8b" strokeWidth={1} strokeDasharray="4 3" />;
      })}
      {marquee && (() => {
        const a = toScreen({ x: marquee.minX, y: marquee.minY }, cam);
        return (
          <rect
            data-testid="marquee"
            x={a.x}
            y={a.y}
            width={(marquee.maxX - marquee.minX) * cam.zoom}
            height={(marquee.maxY - marquee.minY) * cam.zoom}
            fill="#8f9bff22"
            stroke={ACCENT}
            strokeDasharray="4 3"
          />
        );
      })()}
    </svg>
  );
}
