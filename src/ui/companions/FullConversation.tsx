/**
 * AI Companions (issue #13): conversa completa num diálogo — renderiza o MESMO componente do bloco clássico
 * (contexto, autorização, propostas com prévia e aprovação, limpar conversa). Nada é duplicado.
 */
import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useEditor, setState } from '../../store/editor';
import { updateWidgetData } from '../../store/actions';
import { getWidget } from '../../widgets/registry';
import { makeHostApi } from '../../widgets/WidgetFrame';
import type { WidgetElement } from '../../core/schema';
import { watchConversation } from '../../integrations/aiChat';
import { companionName } from './MiniChat';
import { AIClassic } from '../../widgets/builtin/ai';

export function FullConversationDialog() {
  const id = useEditor((s) => s.companionFull);
  const el = useEditor((s) => (id ? (s.elements.find((e) => e.id === id) as WidgetElement | undefined) : undefined));
  useEffect(() => { if (id && !el) setState({ companionFull: null }); }, [id, el]);
  if (!id || !el) return null;
  return <Dialog el={el} />;
}

function Dialog({ el }: { el: WidgetElement }) {
  const plugin = getWidget(el.widgetType)!;
  const data = useMemo(() => plugin.sanitize(el.data), [plugin, el.data]);
  const api = useMemo(() => makeHostApi(el.id), [el.id]);
  useEffect(() => watchConversation(el.id), [el.id]);
  const update = (updater: unknown, opts?: { coalesce?: boolean }) =>
    updateWidgetData(el.id, (raw) => {
      const cur = plugin.sanitize(raw);
      return typeof updater === 'function' ? (updater as (d: unknown) => unknown)(cur) : { ...(cur as object), ...(updater as object) };
    }, opts?.coalesce);
  const close = () => setState({ companionFull: null });
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[#060a12bb] p-3" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Conversa completa com ${companionName(el)}`}
        data-testid="companion-full"
        className="w-full max-w-[560px] h-[min(80vh,720px)] rounded-2xl border border-[#405a78] bg-[#1a293c] shadow-[0_30px_80px_#000b] flex flex-col"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-line">
          <h2 className="text-[14px] font-bold truncate">{companionName(el)} — conversa completa</h2>
          <button type="button" aria-label="Fechar conversa completa" className="p-1 rounded hover:bg-panel-3" onClick={close}><X size={15} /></button>
        </div>
        <div className="flex-1 min-h-0 p-3 text-[13px] text-fg-2" data-companion-full>
          <AIClassic element={el} data={data as never} update={update as never} selected inputs={{}} outputs={{}} api={api} />
        </div>
      </div>
    </div>
  );
}
