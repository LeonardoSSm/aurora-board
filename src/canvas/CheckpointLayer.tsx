/**
 * Camada de navegação: marcadores dos checkpoints visíveis e indicadores presos às bordas para os
 * que estão fora da tela. Depende só da câmera, do viewport e dos checkpoints (nunca dos elementos).
 */
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { ArrowRight, BookOpen, Bot, Building2, Flag, Lightbulb, MapPin, Plane, Rocket, Star, Wallet } from 'lucide-react';
import { useEditor } from '../store/editor';
import { toScreenPoint } from '../core/camera';
import { directionName, layoutIndicators, type EdgeIndicator, type Rect } from '../core/edgeIndicators';
import type { CheckpointIcon, SpatialCheckpoint } from '../core/checkpoints';
import { navigateToCheckpoint, openCheckpointEdit } from '../store/checkpointActions';

export const CHECKPOINT_ICON: Record<CheckpointIcon, ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>> = {
  pin: MapPin, flag: Flag, star: Star, wallet: Wallet, building: Building2, rocket: Rocket, lightbulb: Lightbulb, plane: Plane, book: BookOpen, bot: Bot,
};

/** Área útil para indicadores: sem a barra de ferramentas (topo), controles de zoom (base) e painéis sobrepostos. */
export function safeRect(vp: { width: number; height: number }, o: { compact: boolean; libraryOpen: boolean; propertiesOpen: boolean }): { visible: Rect; safe: Rect } {
  const visible: Rect = { left: 0, top: 0, right: vp.width, bottom: vp.height };
  const left = 10 + (o.compact && o.libraryOpen ? Math.min(256, vp.width * 0.85) : 0);
  const right = vp.width - 10 - (o.compact && o.propertiesOpen ? Math.min(288, vp.width * 0.85) : 0);
  const safe: Rect = { left, top: vp.height < 520 ? 64 : 86, right: Math.max(left + 40, right), bottom: Math.max(150, vp.height - 64) };
  return { visible, safe };
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

function chipPosition(e: EdgeIndicator): React.CSSProperties {
  const t = e.side === 'left' ? 'translate(0,-50%)' : e.side === 'right' ? 'translate(-100%,-50%)' : e.side === 'top' ? 'translate(-50%,0)' : 'translate(-50%,-100%)';
  return { left: e.x, top: e.y, transform: t };
}

function EdgeChip({ e, cps, open, setOpen }: { e: EdgeIndicator; cps: Map<string, SpatialCheckpoint>; open: boolean; setOpen: (v: boolean) => void }) {
  const first = cps.get(e.ids[0])!;
  const deg = (e.angle * 180) / Math.PI;
  const dir = directionName(e.angle);
  const Arrow = <ArrowRight size={13} style={{ transform: `rotate(${deg}deg)` }} className="shrink-0" aria-hidden />;
  const group = e.ids.length > 1;
  const Icon = CHECKPOINT_ICON[first.icon];
  const arrowFirst = e.side !== 'right';
  return (
    <div className="absolute pointer-events-auto" style={chipPosition(e)} onPointerDown={stop} onDoubleClick={stop} onContextMenu={stop}>
      <button
        type="button"
        data-testid="checkpoint-indicator"
        data-side={e.side}
        data-ids={e.ids.join(',')}
        aria-label={group ? `${e.ids.length} locais ${dir}: ${e.ids.map((id) => cps.get(id)!.name).join(', ')}` : `Ir para ${first.name} (${dir})`}
        aria-expanded={group ? open : undefined}
        title={group ? e.ids.map((id) => cps.get(id)!.name).join('\n') : [first.name, first.description].filter(Boolean).join('\n')}
        onClick={() => (group ? setOpen(!open) : navigateToCheckpoint(first.id))}
        className="flex items-center gap-1.5 h-7 max-w-[170px] px-2 rounded-full border bg-[#121a28ee] text-[11px] font-semibold text-fg-2 shadow-[0_6px_18px_#0008] backdrop-blur hover:text-fg hover:bg-[#1a2538] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        style={{ borderColor: `${first.color}88` }}
      >
        {arrowFirst && Arrow}
        {group ? (
          <span className="truncate">{e.ids.length} locais</span>
        ) : (
          <>
            <Icon size={12} className="shrink-0" />
            <span className="truncate">{first.name}</span>
          </>
        )}
        {!arrowFirst && Arrow}
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: first.color }} aria-hidden />
      </button>
      {group && open && (
        <div role="menu" aria-label="Locais nesta direção" className="absolute z-10 mt-1 min-w-[160px] max-h-60 overflow-y-auto glass rounded-xl p-1" style={{ [e.side === 'right' ? 'right' : 'left']: 0, ...(e.side === 'bottom' ? { bottom: 34 } : {}) }}>
          {e.ids.map((id) => {
            const cp = cps.get(id)!;
            const I = CHECKPOINT_ICON[cp.icon];
            return (
              <button key={id} role="menuitem" type="button" data-testid="checkpoint-group-item" onClick={() => { setOpen(false); navigateToCheckpoint(id); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[12px] text-fg-2 hover:bg-panel-3">
                <I size={12} style={{ color: cp.color }} />
                <span className="truncate">{cp.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CheckpointLayer() {
  const cps = useEditor((s) => s.checkpoints);
  const camera = useEditor((s) => s.camera);
  const viewport = useEditor((s) => s.viewport);
  const show = useEditor((s) => s.boards.find((b) => b.id === s.boardId)?.settings.showCheckpointIndicators !== false);
  const compact = useEditor((s) => s.compact);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const propertiesOpen = useEditor((s) => s.propertiesOpen);
  const flash = useEditor((s) => s.checkpointFlash);
  const prevInside = useRef<Set<string>>(new Set());
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => force((n) => n + 1), 1300);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (!openGroup) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpenGroup(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [openGroup]);
  if (!cps.length) return null;
  const byId = new Map(cps.map((c) => [c.id, c]));
  const { visible, safe } = safeRect(viewport, { compact, libraryOpen, propertiesOpen });
  const layout = layoutIndicators(cps.map((c) => ({ id: c.id, screen: toScreenPoint(c, camera) })), visible, safe, prevInside.current);
  prevInside.current = new Set(layout.inside.map((i) => i.id));
  const flashing = flash && Date.now() - flash.at < 1300 ? flash.id : null;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-[5]" data-testid="checkpoint-layer">
      {layout.inside.map((m) => {
        const cp = byId.get(m.id)!;
        const Icon = CHECKPOINT_ICON[cp.icon];
        return (
          <button
            key={m.id}
            type="button"
            data-testid="checkpoint-marker"
            data-id={m.id}
            aria-label={`Checkpoint ${cp.name} — editar`}
            title={[cp.name, cp.description, 'Clique para editar'].filter(Boolean).join('\n')}
            className="absolute pointer-events-auto flex items-center gap-1 -translate-x-[9px] -translate-y-1/2 group focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded-full"
            style={{ left: m.x, top: m.y }}
            onPointerDown={stop}
            onDoubleClick={stop}
            onContextMenu={stop}
            onClick={() => openCheckpointEdit(cp.id)}
          >
            <span className="relative grid place-items-center w-[18px] h-[18px] rounded-full border-2 bg-[#0c1420]" style={{ borderColor: cp.color, color: cp.color }}>
              <Icon size={10} />
              {flashing === m.id && <span className="absolute inset-[-6px] rounded-full border-2 animate-ping" style={{ borderColor: cp.color }} />}
            </span>
            <span className="px-1.5 py-0.5 rounded-md bg-[#0c1420cc] text-[11px] font-semibold text-fg-2 opacity-80 group-hover:opacity-100 whitespace-nowrap">{cp.name}</span>
          </button>
        );
      })}
      {show && layout.edges.map((e) => {
        const key = e.ids.join(',');
        return <EdgeChip key={key} e={e} cps={byId} open={openGroup === key} setOpen={(v) => setOpenGroup(v ? key : null)} />;
      })}
    </div>
  );
}
