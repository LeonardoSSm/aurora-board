/**
 * AI Companions (issue #13) — controlador ÚNICO de conversa, compartilhado pelo bloco clássico, pelo personagem no
 * canvas e pelo dock. Não é outro motor: usa exatamente `contextSources`, `buildContextText`, `buildSystemPrompt`
 * (com `financialTaint`), `sendChat` e o mesmo histórico `AIData.messages` do widget.
 *
 * - Estado de requisição por assistente (id do elemento) num módulo, fora dos componentes: desmontar o bloco,
 *   trocar o visual ou abrir/fechar o mini chat não cancela nem duplica a conversa.
 * - Um envio por vez por assistente; dois assistentes no mesmo quadro são independentes.
 * - Trocar de quadro ou excluir o assistente aborta o pedido pendente — a resposta nunca é gravada em outro
 *   quadro ou assistente.
 * - Sem streaming: “thinking” significa só “aguardando resposta”.
 */
import { useSyncExternalStore } from 'react';
import { uid } from '../core/elements';
import { sanitizeAI, type AIData, type AIMessage } from '../core/widgetData';
import { IDLE_REQUEST, type RequestState } from '../core/companion';
import type { WidgetElement } from '../core/schema';
import { getState, useEditor } from '../store/editor';
import { updateWidgetData } from '../store/actions';
import { fetchAIStatus, sendChat, type ProviderId } from './aiClient';
import { buildContextText, buildSystemPrompt, contextSources, type QuickMode } from './aiContext';

interface Entry { state: RequestState; controller: AbortController | null; boardId: string }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Quem está olhando a conversa de cada assistente (mini chat, dock, conversa completa). */
const viewers = new Map<string, number>();

function emit() { listeners.forEach((l) => l()); }
function set(id: string, patch: Partial<RequestState>) {
  const e = entries.get(id) ?? { state: IDLE_REQUEST, controller: null, boardId: getState().boardId };
  entries.set(id, { ...e, state: { ...e.state, ...patch } });
  emit();
}

export function requestState(id: string): RequestState {
  return entries.get(id)?.state ?? IDLE_REQUEST;
}

function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Hook: estado da requisição do assistente `id` (re-renderiza só quando muda). */
export function useAIRequest(id: string): RequestState {
  return useSyncExternalStore(subscribe, () => requestState(id), () => IDLE_REQUEST);
}

/** Um visualizador abriu/fechou a conversa (zera “não lida” ao abrir). Devolve a função de fechar. */
export function watchConversation(id: string): () => void {
  viewers.set(id, (viewers.get(id) ?? 0) + 1);
  if (requestState(id).unread) set(id, { unread: false });
  return () => {
    const n = (viewers.get(id) ?? 1) - 1;
    if (n <= 0) viewers.delete(id);
    else viewers.set(id, n);
  };
}

export function markRead(id: string) {
  if (requestState(id).unread) set(id, { unread: false });
}

export function cancelAIRequest(id: string) {
  const e = entries.get(id);
  e?.controller?.abort();
}

/** Limpa o erro exibido (o estado volta a idle). */
export function clearAIError(id: string) {
  const s = requestState(id);
  if (s.status === 'error' || s.status === 'cancelled') set(id, { status: 'idle', error: '' });
}

function aiElement(id: string): WidgetElement | null {
  const el = getState().elements.find((e) => e.id === id);
  return el && el.type === 'widget' && el.widgetType === 'aurora.ai' ? (el as WidgetElement) : null;
}

/**
 * Envia uma mensagem do assistente `id`. Mesmo contexto, autorização, prompt de sistema e histórico do modo
 * clássico. Recusa envio duplicado enquanto houver um pendente. Devolve false se não enviou.
 */
export async function sendAIMessage(id: string, text: string, mode: QuickMode = 'structure'): Promise<boolean> {
  const content = text.trim();
  if (!content) return false;
  const prev = entries.get(id);
  if (prev?.state.status === 'sending' || prev?.controller) return false;
  const el = aiElement(id);
  if (!el) return false;
  const data: AIData = sanitizeAI(el.data);
  const boardId = getState().boardId;
  // O cancelamento existe DESDE O INÍCIO (inclusive durante a descoberta do provedor). O controlador também é a
  // identidade do pedido: só o pedido atual pode mudar o estado; um pedido abandonado (quadro trocado, assistente
  // excluído, cancelado) não recria a entrada, não envia e não grava nada.
  const ctrl = new AbortController();
  entries.set(id, { state: { ...(prev?.state ?? IDLE_REQUEST), status: 'sending', error: '' }, controller: ctrl, boardId });
  emit();
  const isCurrent = () => entries.get(id)?.controller === ctrl;
  /** Ainda vale continuar: não cancelado, mesmo pedido, mesmo quadro e o assistente existe. */
  const alive = () => !ctrl.signal.aborted && isCurrent() && getState().boardId === boardId && !!aiElement(id);
  try {
    const status = await abortable(fetchAIStatus(), ctrl.signal);
    if (!alive()) throw abortError();
    const configured = status.state === 'ready' ? status.providers.filter((p) => p.configured) : [];
    const provider = configured.find((p) => p.id === data.provider) ?? configured[0];
    if (!provider) {
      set(id, { status: 'error', error: status.state === 'ready' || status.state === 'offline' ? 'IA não configurada: nenhum provedor com chave no servidor local.' : status.message });
      return false;
    }
    // Dados e contexto lidos AGORA (após a espera), com o estado atual — mesmas funções do bloco clássico.
    const fresh = sanitizeAI(aiElement(id)!.data);
    const elements = getState().elements;
    const sources = contextSources(elements, id, fresh.authorized);
    const contextText = buildContextText(elements, sources);
    const userMsg: AIMessage = { id: uid(), role: 'user', content, at: Date.now() };
    const history = [...fresh.messages.slice(-12), userMsg].map((m) => ({ role: m.role, content: m.content }));
    updateWidgetData(id, (d) => { const cur = sanitizeAI(d); return { ...cur, messages: [...cur.messages, userMsg] }; });
    const res = await abortable(sendChat({ provider: provider.id as ProviderId, model: fresh.model || undefined, system: buildSystemPrompt(fresh.instruction, contextText, mode), messages: history }, ctrl.signal), ctrl.signal);
    // Cancelado, quadro trocado ou assistente excluído enquanto esperava: descarta (nunca grava no lugar errado).
    if (!alive()) throw abortError();
    updateWidgetData(id, (d) => { const cur = sanitizeAI(d); return { ...cur, messages: [...cur.messages, { id: uid(), role: 'assistant', content: res.text, at: Date.now(), provider: res.provider, model: res.model }] }; });
    set(id, { status: 'idle', error: '', repliedAt: Date.now(), unread: !viewers.has(id) });
    return true;
  } catch (e) {
    // Pedido abandonado pela limpeza (troca de quadro/exclusão): a entrada já foi descartada — não a recria.
    if (!isCurrent()) return false;
    if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) set(id, { status: 'cancelled', error: 'Pedido cancelado.' });
    else set(id, { status: 'error', error: (e as Error).message || 'Falha ao falar com a IA.' });
    return false;
  } finally {
    const cur = entries.get(id);
    if (cur && cur.controller === ctrl) entries.set(id, { ...cur, controller: null });
  }
}

function abortError(): Error { return Object.assign(new Error('Pedido cancelado.'), { name: 'AbortError' }); }

/** Promessa que rejeita com AbortError assim que o sinal aborta (a operação de baixo é compartilhada e segue). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** Troca de quadro ou exclusão do assistente: aborta pendências e descarta estados órfãos. */
let started = false;
export function startAIChatHousekeeping() {
  if (started) return;
  started = true;
  useEditor.subscribe((s) => s.boardId, () => {
    for (const [id, e] of entries) {
      e.controller?.abort();
      entries.delete(id);
    }
    emit();
  });
  useEditor.subscribe((s) => s.elements, (els) => {
    let changed = false;
    for (const [id, e] of entries) {
      if (!els.some((x) => x.id === id)) { e.controller?.abort(); entries.delete(id); changed = true; }
    }
    if (changed) emit();
  });
}

/** Testes. */
export function __resetAIChat() { for (const e of entries.values()) e.controller?.abort(); entries.clear(); viewers.clear(); emit(); }
