import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelAIRequest, sendAIMessage, useAIRequest, watchConversation } from '../../integrations/aiChat';
import { CompanionCharacter } from '../../ui/companions/CompanionCharacter';
import { CompanionInspector } from '../../ui/companions/CompanionSettings';
import { Eye, Loader2, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import type { WidgetPlugin, WidgetProps } from '../registry';
import { sanitizeAI, type AIData, type AIMessage } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import type { AuroraElement } from '../../core/schema';
import { useEditor } from '../../store/editor';
import { fetchAIStatus, type AIStatus } from '../../integrations/aiClient';
import { buildContextText, buildSystemPrompt, contextSources, type QuickMode } from '../../integrations/aiContext';
import { interpretFinancialRequest, localMoneyAction, parseAIProposal, proposalDisplayText, proposalKey, type FinancialRequest, type ParsedProposal } from '../../integrations/aiActions';
import { renderMarkdown } from './notes';
import { ProposalCard } from './aiProposal';
import { CategorySuggestionCard } from './aiFinanceSuggestions';
import { openPairing } from '../../ui/PairingDialog';

const QUICK: { label: string; prompt: string; mode: QuickMode }[] = [
  { label: 'Resumir', prompt: 'Resuma o contexto conectado em tópicos curtos.', mode: 'chat' },
  { label: 'Sugerir melhorias', prompt: 'Analise a estrutura do contexto e sugira melhorias concretas.', mode: 'chat' },
  { label: 'Organizar tarefas', prompt: 'Organize as próximas ações como uma lista de tarefas priorizadas.', mode: 'structure' },
  { label: 'Gerar blocos', prompt: 'Gere notas estruturadas (blocos) que organizem este contexto visualmente.', mode: 'structure' },
  { label: 'Propor conexões', prompt: 'Proponha conexões entre os blocos do contexto que façam sentido, explicando o porquê.', mode: 'structure' },
];

function useAIStatus() {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const refresh = (force = false) => { setStatus(null); fetchAIStatus(force).then(setStatus); };
  useEffect(() => { fetchAIStatus().then(setStatus); }, []);
  return { status, refresh };
}

function MessageView({ m, request, props, validIds, elements }: { m: AIMessage; request: FinancialRequest | null; props: WidgetProps<AIData>; validIds: Set<string>; elements: AuroraElement[] }) {
  const proposal = useMemo(() => (m.role === 'assistant' ? parseAIProposal(m.content, validIds) : null), [m, validIds]);
  // A IA não propôs nenhuma ação financeira, mas o pedido é inequívoco ("Crie um bloco de receita de R$ 2.000,00"):
  // oferece a interpretação local, também só com prévia e confirmação.
  const local = useMemo<ParsedProposal | null>(() => {
    if (m.role !== 'assistant' || proposal?.actions.some((a) => a.type === 'money')) return null;
    const a = localMoneyAction(request);
    return a ? { version: 2, actions: [a], rejected: [], notices: [], raw: '' } : null;
  }, [m.role, proposal, request]);
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(proposalDisplayText(m.content, proposal)) : ''), [m, proposal]);
  return (
    <div className={`rounded-lg px-2.5 py-1.5 text-[12px] ${m.role === 'user' ? 'bg-panel-3 self-end max-w-[90%] whitespace-pre-wrap' : 'bg-[#0f1826] border border-line/60'}`}>
      {m.role === 'assistant' ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : m.content}
      {m.role === 'assistant' && <div className="text-[9px] text-soft mt-1">{m.provider} · {m.model}</div>}
      {/* key: se a lista de ações mudar (ex.: fonte desautorizada), o estado do cartão recomeça alinhado. */}
      {proposal && <ProposalCard key={JSON.stringify(proposal.actions)} proposal={proposal} origin="ai" applyKey={proposalKey(m.id, 'ai')} request={request} props={props} elements={elements} validIds={validIds} />}
      {m.role === 'assistant' && m.content.includes('categorize') && <CategorySuggestionCard reply={m.content} messageId={m.id} props={props} elements={elements} validIds={validIds} />}
      {local && <ProposalCard proposal={local} origin="local" applyKey={proposalKey(m.id, 'local')} request={request} props={props} elements={elements} validIds={validIds} />}
    </div>
  );
}

export const aiPlugin: WidgetPlugin<AIData> = {
  id: WIDGET.ai,
  name: 'Assistente IA',
  description: 'Chat com modelos (OpenAI, Claude, Gemini) usando apenas o contexto conectado e autorizado.',
  icon: Sparkles,
  version: '1.0.0',
  category: 'IA',
  status: 'ready',
  statusNote: 'Exige o servidor local com uma chave de API configurada (.env). Sem chave, fica “não configurado”.',
  accent: '#b998ff',
  permissions: ['ai:send-context'],
  defaultSize: { width: 380, height: 480 },
  inputs: [{ id: 'context', label: 'Contexto', type: 'any' }],
  outputs: [{ id: 'reply', label: 'Última resposta', type: 'text' }],
  createData: () => sanitizeAI({}),
  sanitize: sanitizeAI,
  compute: (d) => ({ reply: [...d.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '' }),
  summarize: (d) => `Instrução: ${d.instruction}\n` + d.messages.slice(-6).map((m) => `${m.role === 'user' ? 'Usuário' : 'IA'}: ${m.content}`).join('\n'),
  // Issue #13: o mesmo assistente em dois visuais. O personagem usa moldura mínima (arrastar move o bloco).
  frameFor: (d) => (d.companion?.displayMode === 'character' ? 'bare' : 'standard'),
  Component: function AIBlock(props) {
    if (props.data.companion?.displayMode === 'character') return <CompanionCharacter element={props.element} data={props.data} />;
    return <AIClassic {...props} />;
  },
  Inspector: CompanionInspector,
};

/**
 * Visual clássico (chat completo, contexto, autorização, propostas). O envio passa pelo controlador compartilhado
 * (`integrations/aiChat.ts`), o mesmo do personagem e do dock: desmontar ou trocar o visual não cancela nem
 * duplica a conversa. Usado também na “conversa completa” aberta pelo mini chat.
 */
export function AIClassic(props: WidgetProps<AIData>) {
    const { data, update, element, api } = props;
    const { status, refresh } = useAIStatus();
    const elements = useEditor((s) => s.elements);
    const sources = useMemo(() => contextSources(elements, element.id, data.authorized), [elements, element.id, data.authorized]);
    const validIds = useMemo(() => new Set(sources.filter((s) => s.authorized).map((s) => s.id)), [sources]);
    // Pedido do usuário que originou cada resposta (conferência local de valores financeiros).
    const requests = useMemo(() => {
      const out = new Map<string, FinancialRequest | null>();
      let last: FinancialRequest | null = null;
      for (const m of data.messages) {
        if (m.role === 'user') last = interpretFinancialRequest(m.content);
        else out.set(m.id, last);
      }
      return out;
    }, [data.messages]);
    const [input, setInput] = useState('');
    const req = useAIRequest(element.id);
    const loading = req.status === 'sending';
    const error = req.status === 'error' ? req.error : '';
    const [showPayload, setShowPayload] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    // Conversa visível = lida (o dock não marca “nova resposta” enquanto o bloco está à vista).
    useEffect(() => watchConversation(element.id), [element.id]);

    const configured = status?.state === 'ready' ? status.providers.filter((p) => p.configured) : [];
    const provider = configured.find((p) => p.id === data.provider) ?? configured[0];

    useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [data.messages.length, loading]);

    const contextText = buildContextText(elements, sources);
    const send = async (text: string, mode: QuickMode) => {
      if (!text.trim() || loading || !provider) return;
      setInput('');
      // Mesmo contexto/autorização/prompt: o controlador recalcula com as mesmas funções no momento do envio.
      await sendAIMessage(element.id, text, mode);
    };

    return (
      <div className="flex flex-col gap-2 h-full">
        {/* Estado do provedor */}
        {!status ? (
          <div className="text-[11px] text-muted flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Verificando provedores…</div>
        ) : status.state === 'unavailable' ? (
          <div className="rounded-lg border border-line bg-panel-3/40 p-2 text-[11px] text-muted" data-testid="ai-status">
            <b>Indisponível.</b> {status.message}
          </div>
        ) : status.state === 'pairing' ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn" data-testid="ai-status">
            <b>Computador não pareado.</b> {status.message} A IA usa as chaves do computador principal; pareie este computador com um código gerado lá.
            <button onClick={() => openPairing()} className="ml-1 underline">Parear este computador</button>
          </div>
        ) : status.state === 'offline' ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn" data-testid="ai-status">
            <b>Não configurado.</b> {status.message}
            <button onClick={() => refresh(true)} className="ml-1 underline">Tentar de novo</button>
          </div>
        ) : !configured.length ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn" data-testid="ai-status">
            <b>Não configurado.</b> Nenhuma chave de API no servidor. Defina <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code> ou <code>GEMINI_API_KEY</code> no arquivo <code>.env</code> e reinicie <code>npm run dev</code>.
            <button onClick={() => refresh(true)} className="ml-1 underline">Verificar</button>
          </div>
        ) : (
          <div className="flex gap-1.5 items-center" data-testid="ai-status">
            <select aria-label="Provedor" value={provider?.id} onChange={(e) => update({ provider: e.target.value, model: '' })} className="h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px]">
              {configured.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="Modelo" value={data.model} placeholder={provider?.defaultModel} onChange={(e) => update({ model: e.target.value.trim() }, { coalesce: true })} className="flex-1 min-w-0 h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px] font-mono" />
            <button aria-label="Atualizar provedores" onClick={() => refresh(true)} className="p-1 text-muted hover:text-fg"><RefreshCw size={12} /></button>
          </div>
        )}

        {/* Fontes de contexto */}
        <div className="rounded-lg border border-line/60 p-2 bg-[#0f1826]">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
            <span>Contexto autorizado ({validIds.size})</span>
            <button className="normal-case tracking-normal font-normal flex items-center gap-1 hover:text-fg" onClick={() => setShowPayload((v) => !v)}>
              <Eye size={11} /> {showPayload ? 'Ocultar' : 'Ver o que será enviado'}
            </button>
          </div>
          {!sources.length && <div className="text-[11px] text-soft">Nenhum bloco conectado. Use a ferramenta Conectar (C) com o tipo “Contexto” ligando blocos a este assistente.</div>}
          {sources.map((s) => (
            <label key={s.id} className={`flex items-center gap-1.5 text-[11px] py-0.5 ${s.includable ? 'text-fg-2' : 'text-soft'}`}>
              <input
                type="checkbox"
                disabled={!s.includable}
                checked={s.authorized}
                onChange={(e) => update((d) => ({ ...d, authorized: { ...d.authorized, [s.id]: e.target.checked } }))}
                className="accent-accent-2"
              />
              <span className="truncate flex-1">{s.title}</span>
              <span className="text-[9px] text-soft" title={s.note}>{s.includable ? s.kind : `${s.kind} · não enviado`}</span>
              {!s.includable && s.kind === 'visual' && (
                <button className="text-[9px] text-accent underline" onClick={() => api.updateElement(s.edgeId, { connection: { kind: 'context', relation: '' } } as never)}>tornar contexto</button>
              )}
              {s.note && <span className="sr-only">{s.note}</span>}
            </label>
          ))}
          {sources.some((s) => s.type === 'aurora.bank-query' && s.authorized) && (
            <div className="text-[10px] text-warn" data-testid="ai-finance-history-note">Dados financeiros autorizados: perguntas e respostas ficam salvas neste quadro. Limpe a conversa antes de compartilhar o quadro.</div>
          )}
          {sources.filter((s) => s.note).map((s) => (
            <div key={`note-${s.id}`} className="text-[10px] text-warn" data-testid="ai-source-note">🔒 {s.title}: {s.note}</div>
          ))}
          {showPayload && (
            <pre className="mt-1.5 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-muted bg-[#0a111c] p-1.5 rounded" data-scrollable>
              {buildSystemPrompt(data.instruction, contextText, 'structure')}
            </pre>
          )}
        </div>

        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted">Instrução permanente</summary>
          <textarea value={data.instruction} onChange={(e) => update({ instruction: e.target.value }, { coalesce: true })} className="mt-1 w-full min-h-[48px] px-2 py-1 rounded-md bg-[#0f1826] border border-line text-[11px] resize-y" />
        </details>

        {/* Conversa */}
        <div ref={listRef} className="flex-1 min-h-[60px] overflow-auto flex flex-col gap-1.5" data-scrollable>
          {data.messages.map((m) => <MessageView key={m.id} m={m} request={requests.get(m.id) ?? null} props={props} validIds={validIds} elements={elements} />)}
          {loading && <div className="text-[11px] text-muted flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Aguardando {provider?.name}… <button className="underline" onClick={() => cancelAIRequest(element.id)}>cancelar</button></div>}
          {error && <div className="text-[11px] text-danger">{error}</div>}
        </div>

        <div className="flex flex-wrap gap-1">
          {QUICK.map((q) => (
            <button key={q.label} disabled={!provider || loading} onClick={() => send(q.prompt, q.mode)} className="h-6 px-2 rounded-md border border-line text-[10px] text-fg-2 hover:bg-panel-3">{q.label}</button>
          ))}
          {data.messages.length > 0 && (
            <button aria-label="Limpar conversa" onClick={() => update({ messages: [] })} className="h-6 px-1.5 text-soft hover:text-danger ml-auto"><Trash2 size={12} /></button>
          )}
        </div>
        <div className="flex gap-1.5">
          <textarea
            value={input}
            disabled={!provider}
            placeholder={provider ? 'Pergunte algo sobre o contexto… (Enter envia)' : 'IA não configurada'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input, 'structure'); } }}
            className="flex-1 h-14 px-2 py-1.5 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent-2 text-[12px] resize-none"
          />
          <button aria-label="Enviar" disabled={!provider || loading || !input.trim()} onClick={() => send(input, 'structure')} className="w-10 rounded-lg bg-[#5b46a8] text-white grid place-items-center">
            <Send size={14} />
          </button>
        </div>
      </div>
    );
}

