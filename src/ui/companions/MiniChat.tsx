/**
 * AI Companions (issue #13): mini chat em popover, aberto pelo personagem no canvas ou pelo dock. Mesmas mensagens
 * (`AIData.messages`) e o MESMO controlador de envio do bloco clássico (`sendAIMessage`). Respostas com ações
 * estruturadas nunca são aplicadas daqui: o mini chat leva à conversa completa, onde está o fluxo de
 * prévia/aprovação existente.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Crosshair, Loader2, Maximize2, Pin, PinOff, Send, Square, X } from 'lucide-react';
import { useEditor, setState } from '../../store/editor';
import { focusElement, updateWidgetData } from '../../store/actions';
import { sanitizeAI } from '../../core/widgetData';
import { sanitizeCompanion, DEFAULT_COMPANION, VISUAL_LABEL, visualState } from '../../core/companion';
import { cancelAIRequest, clearAIError, sendAIMessage, useAIRequest, watchConversation } from '../../integrations/aiChat';
import { parseAIProposal, proposalDisplayText } from '../../integrations/aiActions';
import { contextSources } from '../../integrations/aiContext';
import { renderMarkdown } from '../../widgets/builtin/notes';
import { presetById } from '../../companions/presets';
import { getCanvasRect } from '../../canvas/Canvas';
import type { WidgetElement } from '../../core/schema';

const W = 340;

export function companionName(el: WidgetElement): string {
  const c = sanitizeCompanion((el.data as { companion?: unknown })?.companion);
  return c?.name || presetById(c?.preset)?.name || el.title || 'Assistente';
}

export function setDocked(id: string, docked: boolean) {
  updateWidgetData(id, (d) => {
    const cur = sanitizeAI(d);
    return { ...cur, companion: { ...(cur.companion ?? DEFAULT_COMPANION), docked } };
  });
}

/** Posição do popover: ao lado do item do dock, ou acima do personagem (seguindo a câmera), sempre dentro da tela. */
function usePosition(el: WidgetElement | undefined, from: 'canvas' | 'dock', anchor: { x: number; y: number } | null) {
  const cam = useEditor((s) => s.camera);
  if (from === 'dock' && anchor) return { left: anchor.x, top: anchor.y };
  if (!el) return { left: 16, top: 70 };
  const r = getCanvasRect();
  // Ao lado do personagem (direita, senão esquerda), sem cobri-lo; se não couber, acima/abaixo; sempre na tela.
  const xl = r.left + el.x * cam.zoom + cam.x, xr = xl + el.width * cam.zoom;
  const yTop = r.top + el.y * cam.zoom + cam.y;
  const yBottom = yTop + el.height * cam.zoom;
  const maxTop = Math.max(56, window.innerHeight - 390);
  const clampTop = (t: number) => Math.min(maxTop, Math.max(56, t));
  const right = Math.min(r.right, window.innerWidth);
  if (xr + 12 + W <= right - 8) return { left: xr + 12, top: clampTop(yTop) };
  if (xl - 12 - W >= Math.max(r.left, 0) + 8) return { left: xl - 12 - W, top: clampTop(yTop) };
  const left = Math.min(window.innerWidth - W - 8, Math.max(8, (xl + xr) / 2 - W / 2));
  const above = yTop - 12 - 380;
  return { left, top: above >= 56 ? above : clampTop(yBottom + 12) };
}

export function MiniChat() {
  const open = useEditor((s) => s.companionOpen);
  const el = useEditor((s) => (open ? (s.elements.find((e) => e.id === open.id) as WidgetElement | undefined) : undefined));
  // Assistente excluído (ou troca de quadro): fecha.
  useEffect(() => { if (open && !el) setState({ companionOpen: null }); }, [open, el]);
  if (!open || !el) return null;
  return <Popover key={el.id} el={el} from={open.from} anchor={open.anchor ?? null} />;
}

function Popover({ el, from, anchor }: { el: WidgetElement; from: 'canvas' | 'dock'; anchor: { x: number; y: number } | null }) {
  const data = useMemo(() => sanitizeAI(el.data), [el.data]);
  const companion = data.companion ?? DEFAULT_COMPANION;
  const req = useAIRequest(el.id);
  const elements = useEditor((s) => s.elements);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pos = usePosition(el, from, anchor);
  const name = companionName(el);
  const state = visualState(req, { hover: false, open: true }, Date.now());
  const sending = req.status === 'sending';
  const validIds = useMemo(() => new Set(contextSources(elements, el.id, data.authorized).filter((s) => s.authorized).map((s) => s.id)), [elements, el.id, data.authorized]);
  const financeShared = useMemo(() => contextSources(elements, el.id, data.authorized).some((s) => s.type === 'aurora.bank-query' && s.authorized), [elements, el.id, data.authorized]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const stop = watchConversation(el.id);
    inputRef.current?.focus();
    return () => { stop(); if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, [el.id]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [data.messages.length, sending]);

  const close = () => setState({ companionOpen: null });
  const send = () => { const t = text; if (!t.trim() || sending) return; setText(''); void sendAIMessage(el.id, t, 'structure'); };
  const recent = data.messages.slice(-8);

  return (
    <div
      role="dialog"
      aria-label={`Conversa com ${name}`}
      data-testid="companion-minichat"
      data-id={el.id}
      className="fixed z-[75] rounded-2xl border border-[#405a78] bg-[#162336f2] shadow-[0_24px_60px_#000a] flex flex-col"
      style={{ left: pos.left, top: pos.top, width: W, maxHeight: 380 }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 px-3 h-10 border-b border-line/60 shrink-0">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: state === 'error' ? '#e05a6c' : sending ? '#ffd36a' : '#5addaa' }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate">{name}</div>
          <div className="text-[10px] text-soft truncate" data-testid="companion-status">{VISUAL_LABEL[state]}{data.provider ? ` · ${data.provider}` : ''}</div>
        </div>
        <button type="button" title={companion.docked ? 'Desafixar do dock' : 'Fixar no dock'} aria-label={companion.docked ? 'Desafixar do dock' : 'Fixar no dock'} className="p-1 rounded hover:bg-panel-3" onClick={() => setDocked(el.id, !companion.docked)}>{companion.docked ? <PinOff size={13} /> : <Pin size={13} />}</button>
        <button type="button" title="Ir para o assistente no quadro" aria-label="Ir para o assistente no quadro" className="p-1 rounded hover:bg-panel-3" onClick={() => { focusElement(el.id); }}><Crosshair size={13} /></button>
        <button type="button" title="Abrir a conversa completa" aria-label="Abrir a conversa completa" className="p-1 rounded hover:bg-panel-3" onClick={() => setState({ companionOpen: null, companionFull: el.id })}><Maximize2 size={13} /></button>
        <button type="button" aria-label="Fechar conversa" className="p-1 rounded hover:bg-panel-3" onClick={close}><X size={14} /></button>
      </div>
      <div ref={listRef} className="flex-1 min-h-[80px] overflow-y-auto px-3 py-2 flex flex-col gap-1.5" data-testid="companion-messages">
        {recent.length === 0 && <div className="text-[11px] text-soft">Pergunte algo. Uso o mesmo contexto autorizado do bloco ({validIds.size} fonte{validIds.size === 1 ? '' : 's'}).</div>}
        {data.messages.length > recent.length && <button type="button" className="text-[10px] text-accent self-start underline" onClick={() => setState({ companionOpen: null, companionFull: el.id })}>{data.messages.length - recent.length} mensagens anteriores — conversa completa</button>}
        {recent.map((m) => {
          if (m.role === 'user') return <div key={m.id} className="self-end max-w-[85%] rounded-xl rounded-br-sm bg-panel-3 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap" data-testid="companion-bubble-user">{m.content}</div>;
          const proposal = parseAIProposal(m.content, validIds);
          const display = proposalDisplayText(m.content, proposal);
          const long = display.length > 420 && expanded !== m.id;
          const html = renderMarkdown(long ? `${display.slice(0, 420)}…` : display);
          return (
            <div key={m.id} className="self-start max-w-[92%] rounded-xl rounded-bl-sm border border-line/60 bg-[#0f1826] px-2.5 py-1.5 text-[12px]" data-testid="companion-bubble">
              <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
              {long && <button type="button" className="text-[10px] text-accent underline" onClick={() => setExpanded(m.id)}>mostrar tudo</button>}
              {proposal && proposal.actions.length > 0 && (
                <button type="button" data-testid="companion-review-actions" className="mt-1 inline-flex items-center gap-1 text-[10px] text-warn underline" onClick={() => setState({ companionOpen: null, companionFull: el.id })}>
                  <ArrowUpRight size={10} /> {proposal.actions.length} ação(ões) proposta(s): revisar e aprovar na conversa completa
                </button>
              )}
            </div>
          );
        })}
        {sending && <div className="self-start text-[11px] text-muted flex items-center gap-1.5" data-testid="companion-waiting"><Loader2 size={12} className="animate-spin" /> Aguardando a resposta…</div>}
        {(req.status === 'error' || req.status === 'cancelled') && (
          <div role="alert" className="text-[11px] text-danger flex items-center gap-2" data-testid="companion-error">{req.error} <button type="button" className="underline text-soft" onClick={() => clearAIError(el.id)}>ok</button></div>
        )}
        {financeShared && <div className="text-[10px] text-warn">Dados financeiros autorizados: perguntas e respostas ficam salvas neste quadro.</div>}
      </div>
      <div aria-live="polite" className="sr-only">{req.status === 'error' ? `Erro: ${req.error}` : !sending && data.messages.at(-1)?.role === 'assistant' ? `${name} respondeu.` : ''}</div>
      <form className="flex gap-1.5 p-2 border-t border-line/60 shrink-0" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef}
          aria-label={`Mensagem para ${name}`}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Escreva… (Enter envia)"
          className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent-2 text-[12px] resize-none"
        />
        {sending ? (
          <button type="button" aria-label="Parar" title="Parar (cancelar o pedido)" className="w-9 rounded-lg border border-line grid place-items-center" onClick={() => cancelAIRequest(el.id)}><Square size={13} /></button>
        ) : (
          <button type="submit" aria-label="Enviar" disabled={!text.trim()} className="w-9 rounded-lg bg-[#5b46a8] text-white grid place-items-center disabled:opacity-50"><Send size={13} /></button>
        )}
      </form>
    </div>
  );
}

