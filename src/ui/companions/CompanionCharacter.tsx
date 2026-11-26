/**
 * AI Companions (issue #13): visual “Personagem” do bloco de IA no canvas. Mesmo elemento, mesmo widgetType, mesmas
 * mensagens: só o desenho muda. Clique no personagem abre o mini chat; arrastar o corpo move o bloco como qualquer
 * widget (moldura “bare”: só o botão do personagem e o balão recebem o ponteiro).
 */
import { useState } from 'react';
import type { WidgetElement } from '../../core/schema';
import type { AIData } from '../../core/widgetData';
import { DEFAULT_COMPANION, VISUAL_LABEL, visualState } from '../../core/companion';
import { useAIRequest } from '../../integrations/aiChat';
import { useEditor, setState } from '../../store/editor';
import { CompanionAvatar } from './CompanionAvatar';
import { companionName } from './MiniChat';

export function CompanionCharacter({ element, data }: { element: WidgetElement; data: AIData }) {
  const c = data.companion ?? DEFAULT_COMPANION;
  const req = useAIRequest(element.id);
  const open = useEditor((s) => s.companionOpen?.id === element.id);
  const muted = useEditor((s) => !s.companionPrefs.ambientBubbles);
  const [hover, setHover] = useState(false);
  const name = companionName(element);
  const state = visualState(req, { hover, open }, Date.now());
  const last = [...data.messages].reverse().find((m) => m.role === 'assistant');
  // Balão: só a última resposta REAL, e só depois que ela chegou (ou não lida). Truncado; o mini chat mostra tudo.
  const showBubble = !open && !!last && (state === 'replying' || state === 'unread');
  void muted; // falas de ambientação são opcionais e desligadas por padrão (nenhuma é gerada pela IA)
  return (
    <div className="w-full h-full relative flex flex-col items-center justify-end" data-testid="companion-character" data-id={element.id} data-state={state}>
      {showBubble && (
        <button
          type="button"
          data-interactive
          data-testid="companion-reply-bubble"
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 max-w-[260px] w-max rounded-xl rounded-bl-sm border border-line bg-[#0f1826f2] px-2.5 py-1.5 text-[11px] text-fg-2 text-left shadow-[0_8px_24px_#0008] line-clamp-3"
          onClick={() => setState({ companionOpen: { id: element.id, from: 'canvas' } })}
        >
          {last!.artifact ? 'Proposta de Artifact disponível na conversa.' : `${last!.content.replace(/```[\s\S]*?```/g, '[código]').slice(0, 160)}${last!.content.length > 160 ? '…' : ''}`}
        </button>
      )}
      <button
        type="button"
        data-interactive
        data-testid="companion-open"
        aria-label={`${name} — ${VISUAL_LABEL[state]}. Abrir conversa`}
        aria-expanded={open}
        title={`${name} — clique para conversar`}
        className="flex-1 min-h-0 w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[#9aa3ff]"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => setState({ companionOpen: open ? null : { id: element.id, from: 'canvas' } })}
      >
        <CompanionAvatar preset={c.preset} name={name} req={req} hover={hover} open={open} />
      </button>
      <div className="shrink-0 mt-0.5 px-2 py-0.5 rounded-full bg-[#0f1826d9] border border-line/60 text-[10px] text-fg-2 max-w-full truncate pointer-events-none" data-testid="companion-name">
        {name} · <span className={state === 'error' ? 'text-danger' : state === 'thinking' ? 'text-warn' : 'text-soft'}>{VISUAL_LABEL[state]}</span>
      </div>
    </div>
  );
}
