/**
 * AI Companions (issue #13): dock lateral de assistentes FIXADOS no quadro ativo. Cada item é uma visualização do
 * mesmo assistente (mesmo id, mensagens, autorização e requisição) — não uma cópia. Ao trocar de quadro, o dock
 * mostra só os assistentes do novo quadro (escopo por quadro; nada de pin global nesta fase).
 * Respeita a Biblioteca/Propriedades redimensionáveis (#10), a barra superior e os controles de zoom.
 */
import { useMemo, useState } from 'react';
import { useEditor, setState } from '../../store/editor';
import { usePanelLayout } from '../PanelResizer';
import { sanitizeAI } from '../../core/widgetData';
import { DEFAULT_COMPANION, VISUAL_LABEL, visualState } from '../../core/companion';
import { useAIRequest } from '../../integrations/aiChat';
import { CompanionAvatar } from './CompanionAvatar';
import { companionName } from './MiniChat';
import type { WidgetElement } from '../../core/schema';
import { FullConversationDialog } from './FullConversation';

export function CompanionDock() {
  const elements = useEditor((s) => s.elements);
  const side = useEditor((s) => s.companionPrefs.dock);
  const compact = useEditor((s) => s.compact);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const propertiesOpen = useEditor((s) => s.propertiesOpen);
  const lib = usePanelLayout('library');
  const props = usePanelLayout('properties');
  const docked = useMemo(
    () => elements.filter((e): e is WidgetElement => e.type === 'widget' && e.widgetType === 'aurora.ai' && sanitizeAI(e.data).companion?.docked === true),
    [elements],
  );
  if (side === 'hidden' || !docked.length) return <FullConversationDialog />;
  // Encosta na borda livre do canvas (depois das laterais abertas no desktop; no celular, sobre o canvas).
  const offset = compact ? 8 : side === 'left' ? (libraryOpen ? lib.width + 8 : 8) : (propertiesOpen ? props.width + 8 : 8);
  return (
    <>
      <nav
        aria-label="Dock de assistentes"
        data-testid="companion-dock"
        className="fixed z-[30] top-1/2 -translate-y-1/2 flex flex-col gap-1.5 p-1.5 rounded-2xl glass max-h-[60vh] overflow-y-auto"
        style={side === 'left' ? { left: offset } : { right: offset }}
      >
        {docked.map((el) => <DockItem key={el.id} el={el} side={side} />)}
      </nav>
      <FullConversationDialog />
    </>
  );
}

function DockItem({ el, side }: { el: WidgetElement; side: 'left' | 'right' }) {
  const req = useAIRequest(el.id);
  const open = useEditor((s) => s.companionOpen?.id === el.id);
  const [hover, setHover] = useState(false);
  const data = sanitizeAI(el.data);
  const c = data.companion ?? DEFAULT_COMPANION;
  const name = companionName(el);
  const state = visualState(req, { hover, open }, Date.now());
  return (
    <button
      type="button"
      data-testid="companion-dock-item"
      data-id={el.id}
      data-state={state}
      aria-label={`${name}: ${VISUAL_LABEL[state]}`}
      aria-expanded={open}
      title={`${name} — ${VISUAL_LABEL[state]}`}
      className={`relative w-12 h-12 rounded-xl border ${open ? 'border-accent bg-[#2c3a6e]' : 'border-line bg-panel-3/60 hover:bg-panel-3'}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={(e) => {
        if (open) { setState({ companionOpen: null }); return; }
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = side === 'right' ? r.left - 340 - 10 : r.right + 10;
        setState({ companionOpen: { id: el.id, from: 'dock', anchor: { x: Math.max(8, x), y: Math.max(56, Math.min(window.innerHeight - 390, r.top - 40)) } } });
      }}
    >
      <CompanionAvatar preset={c.preset} name={name} req={req} hover={hover} open={open} size="dock" />
      {req.status === 'sending' && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#ffd36a] animate-pulse" aria-hidden="true" />}
      {req.unread && !open && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#ffd36a]" data-testid="companion-unread" aria-hidden="true" />}
      {(req.status === 'error' || req.status === 'cancelled') && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#e05a6c]" aria-hidden="true" />}
    </button>
  );
}
