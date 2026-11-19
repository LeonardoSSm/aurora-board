import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import type { WidgetPlugin, WidgetProps } from '../registry';
import { sanitizeAI, type AIData, type AIMessage } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { createLinear, createWidget, uid } from '../../core/elements';
import { resolveLinear } from '../../core/bindings';
import { useEditor } from '../../store/editor';
import { fetchAIStatus, sendChat, type AIStatus, type ProviderId } from '../../integrations/aiClient';
import { buildContextText, buildSystemPrompt, contextSources, parseProposal, stripProposal, type AIProposal, type QuickMode } from '../../integrations/aiContext';
import { renderMarkdown } from './notes';
import { appendTasks } from './tasks';
import { sanitizeTasks } from '../../core/widgetData';

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

function ProposalCard({ proposal, props }: { proposal: AIProposal; props: WidgetProps<AIData> }) {
  const { element, api } = props;
  const [applied, setApplied] = useState(false);
  // Destinos de execução: setas "execution" saindo deste bloco para blocos de Tarefas.
  const taskTargets = api
    .connections()
    .filter((c) => c.connection.kind === 'execution' && c.startBinding?.elementId === element.id && c.endBinding)
    .map((c) => api.getElement(c.endBinding!.elementId))
    .filter((e): e is Extract<NonNullable<typeof e>, { type: 'widget' }> => !!e && e.type === 'widget' && e.widgetType === WIDGET.tasks);

  const createOnBoard = async () => {
    const ok = await api.confirm(
      'Criar elementos sugeridos pela IA',
      `Serão criados: ${proposal.notes.length} nota(s), ${proposal.tasks.length ? '1 lista com ' + proposal.tasks.length + ' tarefa(s)' : '0 listas'}, ${proposal.connections.length} conexão(ões). Você pode desfazer com Ctrl+Z.`,
      'Criar no quadro',
    );
    if (!ok) return;
    const x0 = element.x + element.width + 60;
    let y = element.y;
    const created = [];
    for (const n of proposal.notes) {
      const w = createWidget(WIDGET.notes, '1.0.0', n.title || 'Nota', x0, y, 320, 220, { markdown: n.content, mode: 'preview' });
      w.style.strokeColor = '#f3c577';
      created.push(w);
      y += 240;
    }
    if (proposal.tasks.length) {
      const t = createWidget(WIDGET.tasks, '1.0.0', 'Tarefas sugeridas', x0 + (proposal.notes.length ? 350 : 0), element.y, 320, 300, appendTasks(sanitizeTasks({}), proposal.tasks));
      t.style.strokeColor = '#5addaa';
      created.push(t);
    }
    const byId = new Map(api.getElements().map((e) => [e.id, e]));
    for (const c of proposal.connections) {
      const a = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: '#8fa6c8' }, 'visual');
      a.startBinding = { elementId: c.from, fixedPoint: null };
      a.endBinding = { elementId: c.to, fixedPoint: null };
      a.text = c.label ?? '';
      a.connection.relation = 'sugerida pela IA';
      created.push(resolveLinear(a, byId));
    }
    api.addElements(created, true);
    setApplied(true);
    api.toast('Elementos criados. Ctrl+Z desfaz.', 'success');
  };

  const sendToTasks = async (targetId: string, title: string) => {
    const ok = await api.confirm('Enviar tarefas', `Adicionar ${proposal.tasks.length} tarefa(s) ao bloco “${title}”? (conexão de execução)`, 'Enviar');
    if (!ok) return;
    api.updateWidgetData(targetId, (d) => appendTasks(sanitizeTasks(d), proposal.tasks));
    api.toast(`Tarefas enviadas para “${title}”.`, 'success');
  };

  return (
    <div className="mt-1.5 rounded-lg border border-accent-2/40 bg-accent-2/10 p-2 text-[11px]">
      <div className="font-bold text-accent-2 uppercase tracking-wider text-[10px] mb-1">Proposta estruturada</div>
      <div className="text-fg-2">
        {proposal.notes.length} nota(s) · {proposal.tasks.length} tarefa(s) · {proposal.connections.length} conexão(ões)
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        <button disabled={applied} onClick={createOnBoard} className="h-7 px-2 rounded-md bg-[#5b46a8] text-white font-semibold">{applied ? 'Criado' : 'Criar no quadro…'}</button>
        {proposal.tasks.length > 0 && taskTargets.map((t) => (
          <button key={t.id} onClick={() => sendToTasks(t.id, t.title)} className="h-7 px-2 rounded-md border border-ok/50 text-ok">Enviar para “{t.title}”…</button>
        ))}
      </div>
      <div className="text-[10px] text-soft mt-1">Nada é criado ou enviado sem sua confirmação.</div>
    </div>
  );
}

function MessageView({ m, props, validIds }: { m: AIMessage; props: WidgetProps<AIData>; validIds: Set<string> }) {
  const proposal = useMemo(() => (m.role === 'assistant' ? parseProposal(m.content, validIds) : null), [m, validIds]);
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(proposal ? stripProposal(m.content) : m.content) : ''), [m, proposal]);
  return (
    <div className={`rounded-lg px-2.5 py-1.5 text-[12px] ${m.role === 'user' ? 'bg-panel-3 self-end max-w-[90%] whitespace-pre-wrap' : 'bg-[#0f1826] border border-line/60'}`}>
      {m.role === 'assistant' ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : m.content}
      {m.role === 'assistant' && <div className="text-[9px] text-soft mt-1">{m.provider} · {m.model}</div>}
      {proposal && <ProposalCard proposal={proposal} props={props} />}
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
  Component: function AIBlock(props) {
    const { data, update, element, api } = props;
    const { status, refresh } = useAIStatus();
    const elements = useEditor((s) => s.elements);
    const sources = useMemo(() => contextSources(elements, element.id, data.authorized), [elements, element.id, data.authorized]);
    const validIds = useMemo(() => new Set(sources.filter((s) => s.authorized).map((s) => s.id)), [sources]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showPayload, setShowPayload] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const configured = status?.state === 'ready' ? status.providers.filter((p) => p.configured) : [];
    const provider = configured.find((p) => p.id === data.provider) ?? configured[0];

    useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [data.messages.length, loading]);

    const contextText = buildContextText(elements, sources);
    const send = async (text: string, mode: QuickMode) => {
      if (!text.trim() || loading) return;
      if (!provider) { setError('Nenhum provedor configurado.'); return; }
      setError('');
      const userMsg: AIMessage = { id: uid(), role: 'user', content: text.trim(), at: Date.now() };
      const history = [...data.messages.slice(-12), userMsg].map((m) => ({ role: m.role, content: m.content }));
      update((d) => ({ ...d, messages: [...d.messages, userMsg] }));
      setInput('');
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await sendChat({ provider: provider.id as ProviderId, model: data.model || undefined, system: buildSystemPrompt(data.instruction, contextText, mode), messages: history }, ctrl.signal);
        update((d) => ({ ...d, messages: [...d.messages, { id: uid(), role: 'assistant', content: res.text, at: Date.now(), provider: res.provider, model: res.model }] }));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
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
              <span className="text-[9px] text-soft">{s.includable ? s.kind : `${s.kind} · não enviado`}</span>
              {!s.includable && s.kind === 'visual' && (
                <button className="text-[9px] text-accent underline" onClick={() => api.updateElement(s.edgeId, { connection: { kind: 'context', relation: '' } } as never)}>tornar contexto</button>
              )}
            </label>
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
          {data.messages.map((m) => <MessageView key={m.id} m={m} props={props} validIds={validIds} />)}
          {loading && <div className="text-[11px] text-muted flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Aguardando {provider?.name}… <button className="underline" onClick={() => abortRef.current?.abort()}>cancelar</button></div>}
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
  },
};
