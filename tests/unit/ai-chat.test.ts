/** Issue #13 — controlador de conversa compartilhado (clássico, personagem e dock usam o mesmo). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendChat = vi.fn();
const READY = { state: 'ready', providers: [{ id: 'openai', name: 'OpenAI', configured: true, defaultModel: 'x' }] };
const fetchAIStatus = vi.fn(async () => READY);
vi.mock('../../src/integrations/aiClient', () => ({
  fetchAIStatus: () => fetchAIStatus(),
  sendChat: (...a: unknown[]) => sendChat(...a),
}));

import { createLinear, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import { sanitizeAI } from '../../src/core/widgetData';
import type { AuroraElement, LinearElement, WidgetElement } from '../../src/core/schema';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { __resetAIChat, cancelAIRequest, requestState, sendAIMessage, startAIChatHousekeeping, watchConversation } from '../../src/integrations/aiChat';

registerBuiltinWidgets();
startAIChatHousekeeping();

const ai = (title = 'IA', extra: object = {}) => createWidget(WIDGET.ai, '1.0.0', title, 0, 0, 380, 480, { ...extra }) as WidgetElement;
function link(a: AuroraElement, b: AuroraElement): LinearElement {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'context');
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  return l;
}
const msgs = (id: string) => sanitizeAI((getState().elements.find((e) => e.id === id) as WidgetElement).data).messages;

/** Resposta controlada (resolve quando o teste mandar). */
function deferred() {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

beforeEach(() => {
  __resetAIChat();
  sendChat.mockReset();
  fetchAIStatus.mockReset();
  fetchAIStatus.mockImplementation(async () => READY);
  setState({ ...initialEditorState, status: 'ready', boardId: 'B1', elements: [], history: {} });
});
afterEach(() => __resetAIChat());

describe('envio compartilhado', () => {
  it('grava pergunta e resposta no MESMO AIData.messages; estados sending → idle/replied', async () => {
    const a = ai();
    setState({ elements: [a] });
    const d = deferred();
    sendChat.mockImplementation(() => d.p);
    const pending = sendAIMessage(a.id, 'Olá');
    await Promise.resolve(); await Promise.resolve();
    expect(requestState(a.id).status).toBe('sending');
    expect(msgs(a.id).map((m) => m.role)).toEqual(['user']);
    d.resolve({ text: 'Oi!', provider: 'openai', model: 'x' });
    expect(await pending).toBe(true);
    expect(msgs(a.id).map((m) => [m.role, m.content])).toEqual([['user', 'Olá'], ['assistant', 'Oi!']]);
    expect(requestState(a.id)).toMatchObject({ status: 'idle', unread: true });
    expect(requestState(a.id).repliedAt).toBeGreaterThan(0);
  });

  it('com a conversa aberta (mini chat/dock/clássico) a resposta não fica “não lida”', async () => {
    const a = ai();
    setState({ elements: [a] });
    sendChat.mockResolvedValue({ text: 'ok', provider: 'openai', model: 'x' });
    const stop = watchConversation(a.id);
    await sendAIMessage(a.id, 'oi');
    expect(requestState(a.id).unread).toBe(false);
    stop();
  });

  it('sem request duplicado: um segundo envio durante o pendente é recusado', async () => {
    const a = ai();
    setState({ elements: [a] });
    const d = deferred();
    sendChat.mockImplementation(() => d.p);
    const first = sendAIMessage(a.id, 'um');
    await Promise.resolve(); await Promise.resolve();
    expect(await sendAIMessage(a.id, 'dois')).toBe(false);
    d.resolve({ text: 'r', provider: 'openai', model: 'x' });
    await first;
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(msgs(a.id).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['um']);
  });

  it('dois assistentes: estados, históricos e pedidos isolados', async () => {
    const a = ai('A'), b = ai('B');
    setState({ elements: [a, b] });
    const da = deferred(), db = deferred();
    sendChat.mockImplementationOnce(() => da.p).mockImplementationOnce(() => db.p);
    const pa = sendAIMessage(a.id, 'para A');
    await Promise.resolve(); await Promise.resolve();
    const pb = sendAIMessage(b.id, 'para B');
    await Promise.resolve(); await Promise.resolve();
    db.resolve({ text: 'resposta B', provider: 'openai', model: 'x' });
    await pb;
    expect(requestState(a.id).status).toBe('sending');
    expect(requestState(b.id).status).toBe('idle');
    da.resolve({ text: 'resposta A', provider: 'openai', model: 'x' });
    await pa;
    expect(msgs(a.id).map((m) => m.content)).toEqual(['para A', 'resposta A']);
    expect(msgs(b.id).map((m) => m.content)).toEqual(['para B', 'resposta B']);
  });

  it('cancelar: estado “cancelado”, nenhuma resposta gravada', async () => {
    const a = ai();
    setState({ elements: [a] });
    sendChat.mockImplementation((_req: unknown, signal: AbortSignal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })))));
    const p = sendAIMessage(a.id, 'x');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    cancelAIRequest(a.id);
    expect(await p).toBe(false);
    expect(requestState(a.id).status).toBe('cancelled');
    expect(msgs(a.id).map((m) => m.role)).toEqual(['user']);
  });

  it('trocar de quadro durante o pedido: aborta e nunca grava no outro quadro', async () => {
    const a = ai();
    setState({ elements: [a] });
    const d = deferred();
    sendChat.mockImplementation((_r: unknown, signal: AbortSignal) => { signal.addEventListener('abort', () => d.reject(Object.assign(new Error('abort'), { name: 'AbortError' }))); return d.p; });
    const p = sendAIMessage(a.id, 'x');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const other = ai('Outro');
    setState({ boardId: 'B2', elements: [other] });
    expect(await p).toBe(false);
    expect(sanitizeAI(other.data).messages).toEqual([]);
    expect(getState().elements[0]).toBe(other);
  });

  it('erro do provedor: estado de erro com mensagem; nada inventado', async () => {
    const a = ai();
    setState({ elements: [a] });
    sendChat.mockRejectedValue(new Error('Limite de uso atingido'));
    expect(await sendAIMessage(a.id, 'x')).toBe(false);
    expect(requestState(a.id)).toMatchObject({ status: 'error', error: 'Limite de uso atingido' });
    expect(msgs(a.id).map((m) => m.role)).toEqual(['user']);
  });
});

/** Codex P2 (PR #19): cancelamento desde a descoberta do provedor e identidade do pedido. */
describe('cancelamento e concorrência durante a descoberta do provedor', () => {
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  function pendingStatus() {
    const d = deferred();
    fetchAIStatus.mockImplementation(() => d.p as Promise<typeof READY>);
    return d;
  }

  it('cancelar enquanto descobre o provedor: estado cancelado na hora, nenhum envio, nada gravado', async () => {
    const a = ai();
    setState({ elements: [a] });
    const st = pendingStatus();
    const p = sendAIMessage(a.id, 'x');
    await flush();
    expect(requestState(a.id).status).toBe('sending');
    cancelAIRequest(a.id);
    expect(await p).toBe(false);
    expect(requestState(a.id).status).toBe('cancelled');
    st.resolve(READY);
    await flush();
    expect(sendChat).not.toHaveBeenCalled();
    expect(msgs(a.id)).toEqual([]);
  });

  it('trocar de quadro durante a descoberta: nenhum envio, estado não é recriado, outro quadro intacto', async () => {
    const a = ai();
    setState({ elements: [a] });
    const st = pendingStatus();
    const p = sendAIMessage(a.id, 'x');
    await flush();
    const other = ai('Outro');
    setState({ boardId: 'B2', elements: [other] });
    st.resolve(READY);
    expect(await p).toBe(false);
    expect(sendChat).not.toHaveBeenCalled();
    expect(requestState(a.id).status).toBe('idle');
    expect(getState().elements[0]).toBe(other);
  });

  it('excluir o assistente durante a descoberta: nenhum envio e nada é recriado', async () => {
    const a = ai();
    setState({ elements: [a] });
    const st = pendingStatus();
    const p = sendAIMessage(a.id, 'x');
    await flush();
    setState({ elements: [] });
    st.resolve(READY);
    expect(await p).toBe(false);
    expect(sendChat).not.toHaveBeenCalled();
    expect(requestState(a.id).status).toBe('idle');
  });

  it('excluir e desfazer (mesmo id) durante a resposta: a resposta antiga não é gravada', async () => {
    const a = ai();
    setState({ elements: [a] });
    const d = deferred();
    sendChat.mockImplementation(() => d.p); // ignora o sinal de propósito (resposta chega mesmo assim)
    const p = sendAIMessage(a.id, 'x');
    await flush();
    const restored = getState().elements[0];
    setState({ elements: [] });
    setState({ elements: [restored] });
    d.resolve({ text: 'tardia', provider: 'openai', model: 'x' });
    expect(await p).toBe(false);
    expect(msgs(a.id).map((m) => m.role)).toEqual(['user']);
    expect(requestState(a.id).status).toBe('idle');
  });

  it('sem duplicado durante a descoberta: segundo envio recusado, um único pedido ao provedor', async () => {
    const a = ai();
    setState({ elements: [a] });
    const st = pendingStatus();
    sendChat.mockResolvedValue({ text: 'r', provider: 'openai', model: 'x' });
    const first = sendAIMessage(a.id, 'um');
    expect(await sendAIMessage(a.id, 'dois')).toBe(false);
    st.resolve(READY);
    expect(await first).toBe(true);
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(msgs(a.id).map((m) => m.content)).toEqual(['um', 'r']);
  });

  it('pedido cancelado que responde tarde não grava nem muda o estado do pedido seguinte', async () => {
    const a = ai();
    setState({ elements: [a] });
    const late = deferred(), next = deferred();
    sendChat.mockImplementationOnce(() => late.p).mockImplementationOnce(() => next.p);
    const p1 = sendAIMessage(a.id, 'primeira');
    await flush();
    cancelAIRequest(a.id);
    // `late` ignora o sinal: o cancelamento não espera a rede.
    expect(await p1).toBe(false);
    expect(requestState(a.id).status).toBe('cancelled');
    const p2 = sendAIMessage(a.id, 'segunda');
    await flush();
    expect(requestState(a.id).status).toBe('sending');
    late.resolve({ text: 'resposta da primeira (tardia)', provider: 'openai', model: 'x' });
    await flush();
    expect(requestState(a.id).status).toBe('sending');
    next.resolve({ text: 'resposta da segunda', provider: 'openai', model: 'x' });
    expect(await p2).toBe(true);
    expect(msgs(a.id).map((m) => m.content)).toEqual(['primeira', 'segunda', 'resposta da segunda']);
    expect(sendChat).toHaveBeenCalledTimes(2);
  });

  it('cancelar durante a resposta mesmo que o provedor ignore o sinal: resposta descartada', async () => {
    const a = ai();
    setState({ elements: [a] });
    const d = deferred();
    sendChat.mockImplementation(() => d.p);
    const p = sendAIMessage(a.id, 'x');
    await flush();
    cancelAIRequest(a.id);
    d.resolve({ text: 'não deveria entrar', provider: 'openai', model: 'x' });
    expect(await p).toBe(false);
    expect(requestState(a.id).status).toBe('cancelled');
    expect(msgs(a.id).map((m) => m.role)).toEqual(['user']);
  });
});

describe('contexto e autorização (mesmas regras do clássico)', () => {
  it('só fontes conectadas e AUTORIZADAS entram no prompt; o visual não muda nada', async () => {
    const ok = createWidget(WIDGET.notes, '1.0.0', 'Ideias', 0, 0, 200, 100, { markdown: 'TEXTO-AUTORIZADO', mode: 'preview' }) as WidgetElement;
    const no = createWidget(WIDGET.notes, '1.0.0', 'Diário', 0, 0, 200, 100, { markdown: 'TEXTO-NAO-AUTORIZADO', mode: 'preview' }) as WidgetElement;
    const a = ai('IA', { authorized: { [ok.id]: true, [no.id]: false }, companion: { displayMode: 'character', preset: 'aurora', name: 'Aurora', docked: true } });
    setState({ elements: [ok, no, a, link(ok, a), link(no, a)] });
    sendChat.mockResolvedValue({ text: 'r', provider: 'openai', model: 'x' });
    await sendAIMessage(a.id, 'resuma');
    const system = (sendChat.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain('TEXTO-AUTORIZADO');
    expect(system).not.toContain('TEXTO-NAO-AUTORIZADO');
  });

  it('consulta bancária sem concessão local continua bloqueada mesmo com o assistente no dock', async () => {
    const bank = createWidget(WIDGET.bankQuery, '1.0.0', 'Banco', 0, 0, 230, 120, { period: '2026-11', metric: 'expense' }) as WidgetElement;
    const a = ai('IA', { authorized: { [bank.id]: true }, companion: { displayMode: 'character', preset: 'aurora', name: '', docked: true } });
    setState({ elements: [bank, a, link(bank, a)] });
    sendChat.mockResolvedValue({ text: 'r', provider: 'openai', model: 'x' });
    await sendAIMessage(a.id, 'quanto gastei?');
    const system = (sendChat.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain('CONTEXTO AUTORIZADO: (nenhum bloco conectado/autorizado)');
    expect(system).not.toContain('Banco');
  });
});
