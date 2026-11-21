/**
 * H2-A — HTML Network Bridge: protocolo do iframe, política de autorização/dados sensíveis e corretor do host.
 * Sem rede real: o transporte e as respostas da confirmação são injetados. Dados sintéticos apenas.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { createLinear, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import type { AuroraElement, LinearElement, WidgetElement } from '../../src/core/schema';
import { sanitizeSandbox } from '../../src/core/widgetData';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { setAdapter } from '../../src/persistence/autosave';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { checkResult, NET_LIMITS, parseAbortMessage, parseRequestMessage, validateNetUrl, type NetOutcome, type NetRequest } from '../../src/net/protocol';
import { activationStamp, evaluateNet, networkKey, sanitizeNetGrants, sensitiveUpstream, type NetContext } from '../../src/net/policy';
import { NetSession, netActivity, resetNetForTests, revokeNetAccess, setConsentPrompter, setNetTransport, type ConsentAnswer, type ConsentRequest } from '../../src/net/broker';
import { buildExport, parseImport } from '../../src/persistence/exportImport';

beforeAll(() => registerBuiltinWidgets());

const HTML = '<script>aurora.request({ url: "https://api.exemplo.com.br/x" })</script>';
const sandbox = (title = 'Painel', extra: Record<string, unknown> = {}) => createWidget(WIDGET.sandbox, '1.0.0', title, 0, 0, 360, 300, { html: HTML, state: null, ...extra }) as WidgetElement;
const bank = (cfg: Record<string, unknown> = {}) => createWidget(WIDGET.bankQuery, '1.0.0', 'Consulta bancária', -600, 0, 300, 200, { ledgerId: 'L1', accountIds: ['a1'], metric: 'expense', period: '2026-10', ...cfg }) as WidgetElement;
const dataset = () => createWidget(WIDGET.dataset, '1.0.0', 'Planilha', -600, 300, 300, 200, { source: { assetId: 'ds1', name: 'x.csv' }, view: {} }) as WidgetElement;
const notes = () => createWidget(WIDGET.notes, '1.0.0', 'Notas', -600, 600, 300, 200, { text: 'oi' }) as WidgetElement;
const ai = () => createWidget(WIDGET.ai, '1.0.0', 'Assistente', 600, 0, 380, 460, { provider: 'anthropic' }) as WidgetElement;
const formula = () => createWidget(WIDGET.formula, '1.0.0', 'Fórmula', -300, 0, 300, 200, { expression: 'a' }) as WidgetElement;
function link(a: AuroraElement, b: AuroraElement, kind: 'data' | 'context' = 'data'): LinearElement {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, kind);
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  return l;
}

const URL_OK = 'https://api.exemplo.com.br/repos/x?y=1';
const ORIGIN = 'https://api.exemplo.com.br';
const req = (id: string, url = URL_OK, extra: Record<string, unknown> = {}) => ({ type: 'aurora:request', token: 'tok', id, url, method: 'GET', responseType: 'json', ...extra });
const okOutcome = (data: unknown = { stars: 42 }): NetOutcome => ({ ok: true, result: { status: 200, url: URL_OK, contentType: 'application/json', bytes: 12, responseType: 'json', data } });

interface Harness { session: NetSession; msgs: Record<string, unknown>[]; prompts: ConsentRequest[]; calls: { req: NetRequest; signal: AbortSignal }[] }
let answers: ConsentAnswer[] = [];
let transportImpl: (r: NetRequest, s: AbortSignal) => Promise<NetOutcome> = async () => okOutcome();
let calls: Harness['calls'] = [];
let prompts: ConsentRequest[] = [];

function open(elementId: string, token = 'tok'): Harness {
  const msgs: Record<string, unknown>[] = [];
  const session = new NetSession({ elementId, token, post: (m) => msgs.push(m as Record<string, unknown>) });
  return { session, msgs, prompts, calls };
}
const responses = (h: Harness) => h.msgs.filter((m) => m.type === 'aurora:response');
const lastError = (h: Harness) => (responses(h).at(-1) as { error?: { code: string } } | undefined)?.error?.code;

beforeEach(() => {
  resetNetForTests();
  setState({ ...initialEditorState, boardId: 'b1', status: 'ready', elements: [], htmlNetGrants: [] });
  setAdapter(new MemoryAdapter());
  answers = [];
  calls = [];
  prompts = [];
  transportImpl = async () => okOutcome();
  setNetTransport((r, s) => { calls.push({ req: r, signal: s }); return transportImpl(r, s); });
  setConsentPrompter(async (r) => { prompts.push(r); return answers.length ? answers.shift()! : 'deny'; });
});
afterEach(() => { vi.useRealTimers(); resetNetForTests(); });

/* ================================================================== protocolo */

describe('protocolo do iframe', () => {
  it('aceita GET https com padrões (GET, json, 10 s) e normaliza o tempo limite', () => {
    const m = parseRequestMessage({ type: 'aurora:request', token: 't', id: 'r1', url: URL_OK });
    expect(m).toEqual({ kind: 'request', token: 't', id: 'r1', request: { url: URL_OK, method: 'GET', responseType: 'json', timeoutMs: NET_LIMITS.defaultTimeoutMs } });
    const lo = parseRequestMessage({ ...req('r2'), timeoutMs: 5 });
    const hi = parseRequestMessage({ ...req('r3'), timeoutMs: 999_999 });
    expect(lo?.kind === 'request' && lo.request.timeoutMs).toBe(NET_LIMITS.minTimeoutMs);
    expect(hi?.kind === 'request' && hi.request.timeoutMs).toBe(NET_LIMITS.maxTimeoutMs);
  });

  it('recusa cabeçalhos, credenciais, corpo e métodos de escrita', () => {
    const code = (x: unknown) => { const m = parseRequestMessage(x); return m?.kind === 'invalid' ? m.error.code : m?.kind; };
    expect(code({ ...req('a'), headers: { Authorization: 'Bearer x' } })).toBe('headers_not_allowed');
    expect(code({ ...req('b'), credentials: 'include' })).toBe('headers_not_allowed');
    expect(code({ ...req('c'), body: 'x' })).toBe('invalid_request');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(code({ ...req('d'), method })).toBe('method_not_allowed');
    expect(code({ ...req('e'), responseType: 'blob' })).toBe('invalid_request');
  });

  it('bloqueia esquemas, portas, IPs, nomes locais e URLs malformadas', () => {
    const blocked = [
      'http://api.exemplo.com.br/', 'file:///etc/passwd', 'data:text/plain,oi', 'javascript:alert(1)', 'blob:https://x.com/uuid', 'ftp://x.com/', 'ws://x.com/', 'wss://x.com/',
      'https://localhost/', 'https://localhost./', 'https://app.localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[64:ff9b::7f00:1]/',
      'https://10.0.0.1/', 'https://192.168.0.10/', 'https://172.16.5.4/', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://0.0.0.0/',
      'https://2130706433/', 'https://0x7f000001/', 'https://017700000001/', 'https://impressora.local/', 'https://metadata.google.internal/', 'https://intranet/',
      'https://api.exemplo.com.br:8443/', 'https://user:senha@api.exemplo.com.br/', 'https://x.test/',
    ];
    for (const u of blocked) {
      const r = validateNetUrl(u);
      expect(r.ok, u).toBe(false);
    }
    expect(validateNetUrl('https://a b.com/').ok).toBe(false);
    expect(validateNetUrl('https://api.exemplo.com.br/' + 'x'.repeat(NET_LIMITS.maxUrlChars)).ok).toBe(false);
    expect(validateNetUrl('https://api.github.com:443/repos/x#frag')).toMatchObject({ ok: true });
  });

  it('mensagens sem token/id utilizáveis não são respondidas; abort exige campos exatos', () => {
    expect(parseRequestMessage({ type: 'aurora:request', id: 'x', url: URL_OK })).toBeNull();
    expect(parseRequestMessage({ type: 'aurora:request', token: 't', id: 'x y', url: URL_OK })).toBeNull();
    expect(parseRequestMessage({ type: 'aurora:publish', token: 't', id: 'x' })).toBeNull();
    expect(parseAbortMessage({ type: 'aurora:abort', token: 't', id: 'r1' })).toEqual({ token: 't', id: 'r1' });
    expect(parseAbortMessage({ type: 'aurora:abort', token: 't', id: 'r1', extra: 1 })).toBeNull();
  });

  it('confere a resposta do transporte (tamanho, status, tipo) antes de entregar', () => {
    const r: NetRequest = { url: URL_OK, method: 'GET', responseType: 'json', timeoutMs: 10_000 };
    expect(checkResult(okOutcome({ a: 1 }), r)).toMatchObject({ ok: true, result: { data: { a: 1 } } });
    expect(checkResult({ ok: true, result: { status: 200, bytes: NET_LIMITS.maxResponseBytes + 1, data: {} } }, r)).toMatchObject({ ok: false, error: { code: 'response_too_large' } });
    expect(checkResult({ ok: true, result: { status: 302, bytes: 0 } }, r)).toMatchObject({ ok: false });
    expect(checkResult({ ok: true, result: { status: 200, bytes: 0 } }, r)).toMatchObject({ ok: true, result: { data: null } });
    expect(checkResult({ ok: true, result: { status: 200, bytes: 2, data: 'x' } }, { ...r, responseType: 'text' })).toMatchObject({ ok: false });
    expect(checkResult({ ok: false, error: { code: 'nao-existe', message: 'x' } }, r)).toMatchObject({ ok: false, error: { code: 'network_error' } });
    expect(checkResult({ ok: false, error: { code: 'http_error', status: 404, message: 'x', data: { message: 'Not Found' } } }, r)).toMatchObject({ ok: false, error: { code: 'http_error', status: 404, data: { message: 'Not Found' } } });
    expect(checkResult('lixo', r)).toMatchObject({ ok: false });
  });
});

/* ================================================================== política */

describe('política de dados sensíveis', () => {
  it('fontes protegidas a montante: banco, dados importados, finanças e o que passa por Fórmula/IA', () => {
    const h = sandbox(), b = bank(), d = dataset(), f = formula(), a = ai(), n = notes();
    expect(sensitiveUpstream([h, n, link(n, h)], h.id)).toEqual([]);
    expect(sensitiveUpstream([h, b, link(b, h)], h.id).map((s) => s.kind)).toEqual(['bank']);
    expect(sensitiveUpstream([h, d, f, link(d, f), link(f, h)], h.id).map((s) => s.kind)).toEqual(['dataset']);
    // Banco → (contexto) → Assistente → (dados: resposta) → HTML: a resposta da IA deriva do banco.
    expect(sensitiveUpstream([h, b, a, link(b, a, 'context'), link(a, h)], h.id).map((s) => s.kind)).toEqual(['bank']);
    // Uma conexão de contexto direta no HTML não leva dados ao iframe.
    expect(sensitiveUpstream([h, b, link(b, h, 'context')], h.id)).toEqual([]);
  });

  it('a chave da autorização muda com HTML, conexões, ativação, quadro e origem', () => {
    const h = sandbox(), n = notes();
    const ctx = (over: Partial<NetContext> = {}): NetContext => ({ elementId: h.id, boardId: 'b1', html: HTML, activation: 'local', elements: [h, n], ...over });
    const base = networkKey(ctx(), ORIGIN);
    expect(networkKey(ctx(), ORIGIN)).toBe(base);
    expect(networkKey(ctx({ html: HTML + ' ' }), ORIGIN)).not.toBe(base);
    expect(networkKey(ctx({ elements: [h, n, link(n, h)] }), ORIGIN)).not.toBe(base);
    expect(networkKey(ctx({ activation: activationStamp({ state: 'allowed', source: 'import', at: 5 }) }), ORIGIN)).not.toBe(base);
    expect(networkKey(ctx({ boardId: 'b2' }), ORIGIN)).not.toBe(base);
    expect(networkKey(ctx(), 'https://outra.com')).not.toBe(base);
  });

  it('sensível exige a autorização ADICIONAL; fonte que sumiu bloqueia; negação vale para a execução', () => {
    const h = sandbox(), b = bank();
    const ctx: NetContext = { elementId: h.id, boardId: 'b1', html: HTML, activation: 'local', elements: [h, b, link(b, h)] };
    const sens = sensitiveUpstream(ctx.elements, h.id);
    const nk = networkKey(ctx, ORIGIN);
    const grant = { v: 1 as const, kind: 'network' as const, elementId: h.id, boardId: 'b1', origin: ORIGIN, method: 'GET' as const, key: nk, at: 1, title: '' };
    const d = evaluateNet({ ctx, origin: ORIGIN, sensitive: sens, grants: [grant], once: new Set(), denied: new Set() });
    expect(d).toMatchObject({ state: 'prompt', need: 'sensitive' });
    const missing = evaluateNet({ ctx, origin: ORIGIN, sensitive: [{ id: 'x', kind: 'missing', title: '', descriptor: 'x:missing' }], grants: [], once: new Set(), denied: new Set() });
    expect(missing.state).toBe('blocked');
    expect(evaluateNet({ ctx, origin: ORIGIN, sensitive: [], grants: [], once: new Set(), denied: new Set([nk]) }).state).toBe('denied');
  });

  it('concessões forjadas/malformadas na configuração local são descartadas', () => {
    const good = { v: 1, kind: 'network', elementId: 'el1', boardId: 'b1', origin: ORIGIN, method: 'GET', key: '0123456789abcdef', at: 1, title: 'x' };
    expect(sanitizeNetGrants([good])).toHaveLength(1);
    expect(sanitizeNetGrants([{ ...good, origin: 'http://x.com' }, { ...good, origin: 'https://localhost' }, { ...good, method: 'POST' }, { ...good, key: 'zz' }, { ...good, kind: 'ai' }, 'lixo', null])).toEqual([]);
  });
});

/* ================================================================== corretor do host */

function board(...els: AuroraElement[]) { setState({ elements: els }); }

describe('corretor do host (consentimento, limites, cancelamento)', () => {
  it('build sem transporte: “indisponível” sem perguntar e sem consultar', async () => {
    setNetTransport(null, 'Indisponível nesta versão.');
    const h = sandbox(); board(h);
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(lastError(x)).toBe('unavailable');
    expect(prompts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('GET autorizado sempre: pergunta UMA vez, grava localmente e não pergunta de novo', async () => {
    const h = sandbox('Painel GitHub'); board(h);
    answers = ['always'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(responses(x)[0]).toMatchObject({ type: 'aurora:response', token: 'tok', id: 'r1', ok: true, result: { data: { stars: 42 } } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ title: 'Painel GitHub', origin: ORIGIN, method: 'GET', need: 'network' });
    expect(getState().htmlNetGrants).toHaveLength(1);
    expect(await (await import('../../src/persistence/autosave')).getAdapter().getSetting('htmlNetGrants')).toHaveLength(1);
    x.session.handle(req('r2'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(2));
    expect(prompts).toHaveLength(1);
    expect(calls.map((c) => c.req.url)).toEqual([URL_OK, URL_OK]);
    expect(netActivity(h.id)?.last).toMatchObject({ origin: ORIGIN, ok: true, status: 200 });
    // O histórico guarda só a origem — nunca caminho/consulta.
    expect(JSON.stringify(netActivity(h.id))).not.toContain('repos');
  });

  it('negar: nada é consultado e não pergunta de novo nesta execução', async () => {
    const h = sandbox(); board(h);
    answers = ['deny'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(lastError(x)).toBe('permission_denied');
    x.session.handle(req('r2'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(2));
    expect(lastError(x)).toBe('permission_denied');
    expect(prompts).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(getState().htmlNetGrants).toHaveLength(0);
  });

  it('permitir uma vez: vale só para esta execução do bloco (nova montagem pergunta de novo)', async () => {
    const h = sandbox(); board(h);
    answers = ['once', 'deny'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    x.session.handle(req('r2'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(2));
    expect(prompts).toHaveLength(1); // simultâneas: uma única confirmação
    expect(getState().htmlNetGrants).toHaveLength(0);
    x.session.dispose();
    const y = open(h.id, 'tok2');
    y.session.handle({ ...req('r1'), token: 'tok2' });
    await vi.waitFor(() => expect(responses(y)).toHaveLength(1));
    expect(prompts).toHaveLength(2);
    expect(lastError(y)).toBe('permission_denied');
  });

  it('várias consultas simultâneas ao mesmo destino → uma confirmação; respostas não se misturam', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = async (r) => okOutcome({ echo: r.url });
    const x = open(h.id);
    for (let i = 1; i <= 6; i++) x.session.handle(req(`r${i}`, `${URL_OK}&n=${i}`));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(6));
    expect(prompts).toHaveLength(1);
    for (const m of responses(x) as { id: string; result: { data: { echo: string } } }[]) expect(m.result.data.echo).toBe(`${URL_OK}&n=${m.id.slice(1)}`);
  });

  it('mensagens com token antigo, ids repetidos e rajadas são descartados', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    let release!: () => void;
    transportImpl = () => new Promise((r) => { release = () => r(okOutcome()); });
    const x = open(h.id);
    x.session.handle({ ...req('r1'), token: 'velho' });
    x.session.handle(req('r1'));
    x.session.handle(req('r1')); // repetido enquanto pendente
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    x.session.handle(req('r1')); // repetido depois de respondido
    await Promise.resolve();
    expect(responses(x)).toHaveLength(1);
  });

  it('limites por iframe: pendentes e consultas por minuto', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = () => new Promise(() => {}); // nunca responde
    const x = open(h.id);
    for (let i = 0; i < NET_LIMITS.maxPendingPerFrame + 1; i++) x.session.handle(req(`p${i}`));
    await vi.waitFor(() => expect(lastError(x)).toBe('too_many_pending'));
    x.session.dispose();
    transportImpl = async () => okOutcome();
    const y = open(h.id, 'tok');
    for (let i = 0; i < NET_LIMITS.maxPerMinutePerFrame + 1; i++) {
      y.session.handle(req(`q${i}`));
      await vi.waitFor(() => expect(responses(y)).toHaveLength(i + 1));
    }
    expect(lastError(y)).toBe('rate_limited');
  });

  it('revogar durante a consulta: a consulta é cancelada e a resposta não chega ao HTML', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = (_r, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(okOutcome({ tarde: true }))));
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await revokeNetAccess(h.id);
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(lastError(x)).toBe('revoked');
    expect(calls[0].signal.aborted).toBe(true);
    expect(JSON.stringify(x.msgs)).not.toContain('tarde');
    expect(getState().htmlNetGrants).toHaveLength(0);
  });

  it('editar o HTML ou ligar uma conexão durante a consulta cancela (autorização desatualizada)', async () => {
    const h = sandbox(), n = notes(); board(h, n);
    answers = ['always'];
    transportImpl = (_r, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(okOutcome())));
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    board({ ...h, data: { ...(h.data as object), html: HTML + '<!-- novo -->' } } as WidgetElement, n);
    await vi.waitFor(() => expect(lastError(x)).toBe('revoked'));
    // Nova conexão de entrada também invalida a autorização gravada.
    board(h, n, link(n, h));
    x.session.handle(req('r2'));
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
  });

  it('desmontagem/exclusão: cancela pendentes e não responde a um iframe que não existe mais', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = (_r, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(okOutcome())));
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    x.session.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    await Promise.resolve();
    expect(responses(x)).toHaveLength(0);
    // Excluído do quadro: novas mensagens não consultam.
    const y = open(h.id, 'tok');
    board();
    y.session.handle(req('r9'));
    await vi.waitFor(() => expect(lastError(y)).toBe('unmounted'));
    expect(calls).toHaveLength(1);
  });

  it('tempo esgotado: o host responde “timeout” mesmo se o transporte travar', async () => {
    vi.useFakeTimers();
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = () => new Promise(() => {});
    const x = open(h.id);
    x.session.handle({ ...req('r1'), timeoutMs: 2000 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(3600);
    expect(lastError(x)).toBe('timeout');
    expect(calls[0].signal.aborted).toBe(true);
  });

  it('cancelamento pelo HTML (aurora:abort) e erros estruturados do transporte', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = (_r, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(okOutcome())));
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    x.session.handle({ type: 'aurora:abort', token: 'tok', id: 'r1' });
    await vi.waitFor(() => expect(lastError(x)).toBe('aborted'));
    for (const [code, extra] of [['http_error', { status: 500 }], ['invalid_json', {}], ['network_error', {}], ['timeout', {}]] as const) {
      transportImpl = async () => ({ ok: false, error: { code, message: 'falhou', ...extra } });
      x.session.handle(req(`e-${code}`));
      await vi.waitFor(() => expect(lastError(x)).toBe(code));
    }
  });

  it('dados protegidos: a autorização comum não basta; a específica lista as fontes', async () => {
    const h = sandbox(), b = bank(); board(h, b, link(b, h));
    answers = ['always'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(prompts[0]).toMatchObject({ need: 'sensitive' });
    expect(prompts[0].sensitive.map((s) => [s.id, s.kind])).toEqual([[b.id, 'bank']]);
    const g = getState().htmlNetGrants;
    expect(g.map((x) => x.kind).sort()).toEqual(['network', 'sensitive']);
    expect(g.find((x) => x.kind === 'sensitive')?.sources).toEqual([{ id: b.id, kind: 'bank', title: 'Consulta bancária' }]);
    // Mudar a consulta bancária (outra conta) invalida a autorização específica — e só ela.
    board(h, { ...b, data: { ...(b.data as object), accountIds: ['a1', 'a2'] } } as WidgetElement, link(b, h));
    answers = ['deny'];
    x.session.handle(req('r2'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(2));
    expect(lastError(x)).toBe('permission_denied');
    expect(prompts[1].need).toBe('sensitive');
    expect(calls).toHaveLength(1);
  });

  it('dados protegidos negados: nenhuma consulta; a autorização de IA não conta', async () => {
    const d = dataset(), h = sandbox(); board(h, d, link(d, h));
    setState({ datasetAiGrants: [`${d.id}:0123456789abcdef`], htmlAiGrants: [`${h.id}:0123456789abcdef`] });
    answers = ['deny'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(lastError(x)).toBe('permission_denied'));
    expect(prompts[0].need).toBe('sensitive');
    expect(calls).toHaveLength(0);
  });

  it('desconectar a fonte NÃO limpa a execução atual (o iframe pode ter guardado os dados)', async () => {
    const h = sandbox(), b = bank(), e = link(b, h); board(h, b, e);
    const x = open(h.id);
    board(h, b); // desconecta
    answers = ['deny'];
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(lastError(x)).toBe('permission_denied'));
    expect(prompts[0].need).toBe('sensitive');
    // Uma montagem nova (memória limpa) sem a conexão e sem estado marcado é comum.
    x.session.dispose();
    answers = ['deny'];
    const y = open(h.id);
    y.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(y)).toHaveLength(1));
    expect(prompts[1].need).toBe('network');
  });

  it('estado gravado com dados protegidos: marca persiste; fonte excluída bloqueia sem bypass', async () => {
    const h = sandbox(), b = bank(); board(h, b, link(b, h));
    const x = open(h.id);
    const taint = x.session.taintIds();
    expect(taint).toEqual([b.id]);
    const marked = { ...h, data: { ...(h.data as object), state: { copia: 1 }, stateTaint: { sources: taint, at: 1 } } } as WidgetElement;
    x.session.dispose();
    // Sem a conexão, mas com o estado marcado: ainda é sensível.
    board(marked, b);
    answers = ['deny'];
    const y = open(h.id);
    y.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(y)).toHaveLength(1));
    expect(prompts[0].need).toBe('sensitive');
    y.session.dispose();
    // Fonte excluída: não há como identificar a origem → bloqueado, sem perguntar.
    board(marked);
    const z = open(h.id);
    z.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(z)).toHaveLength(1));
    expect(lastError(z)).toBe('sensitive_blocked');
    expect(prompts).toHaveLength(1);
    expect(sanitizeSandbox({ html: '', stateTaint: { sources: ['<lixo>'] } }).stateTaint?.sources).toEqual(['desconhecida']);
  });

  it('Codex PR #31: HTML a montante com estado marcado ou memória de fonte protegida contamina o bloco a jusante', async () => {
    const b = bank(), a = sandbox('A'), c = sandbox('B');
    const aMarked = { ...a, data: { ...(a.data as object), stateTaint: { sources: [b.id], at: 1 } } } as WidgetElement;
    board(aMarked, c, b, link(aMarked, c));
    answers = ['deny'];
    const x = open(c.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    expect(prompts[0].need).toBe('sensitive');
    expect(prompts[0].sensitive.map((s) => s.id)).toEqual([b.id]);
    x.session.dispose();
    // Fonte original excluída: a jusante também fica bloqueado (sem como identificar a origem).
    board(aMarked, c, link(aMarked, c));
    const y = open(c.id);
    y.session.handle(req('r1'));
    await vi.waitFor(() => expect(lastError(y)).toBe('sensitive_blocked'));
    y.session.dispose();
    // Sem marca no estado, mas a execução de A recebeu o banco (memória/saídas): B continua sensível.
    board(a, c, b, link(b, a), link(a, c));
    const ra = open(a.id, 'tok-a');
    board(a, c, b, link(a, c)); // desconecta banco → A
    answers = ['deny'];
    const z = open(c.id, 'tok-c');
    z.session.handle({ ...req('r2'), token: 'tok-c' });
    await vi.waitFor(() => expect(responses(z)).toHaveLength(1));
    expect(prompts.at(-1)?.need).toBe('sensitive');
    ra.session.dispose();
  });

  it('Codex PR #31: consultas que estouram o tempo com transporte travado liberam a vaga global', async () => {
    vi.useFakeTimers();
    const h = sandbox(); board(h);
    answers = ['always'];
    transportImpl = () => new Promise(() => {}); // nunca termina
    const x = open(h.id);
    for (let i = 0; i < NET_LIMITS.maxConcurrent; i++) x.session.handle({ ...req(`t${i}`), timeoutMs: 1000 });
    await vi.waitFor(() => expect(calls).toHaveLength(NET_LIMITS.maxConcurrent));
    await vi.advanceTimersByTimeAsync(3000);
    expect(responses(x).filter((m) => (m as { error?: { code: string } }).error?.code === 'timeout')).toHaveLength(NET_LIMITS.maxConcurrent);
    transportImpl = async () => okOutcome();
    x.session.handle(req('depois'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(NET_LIMITS.maxConcurrent + 1));
    expect(responses(x).at(-1)).toMatchObject({ id: 'depois', ok: true });
  });

  it('confirmação fecha sozinha quando o bloco desmonta', async () => {
    const h = sandbox(); board(h);
    let aborted = false;
    setConsentPrompter((r) => new Promise((resolve) => r.signal.addEventListener('abort', () => { aborted = true; resolve(null); })));
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(netActivity(h.id)?.pendingConsent).toBe(true));
    x.session.dispose();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(calls).toHaveLength(0);
  });
});

/* ================================================================== backups e importação */

describe('autorizações nunca viajam em quadros/backups', () => {
  it('exportação não leva htmlNetGrants; importar não cria autorização; ativação nova invalida a antiga', async () => {
    const h = sandbox(); board(h);
    answers = ['always'];
    const x = open(h.id);
    x.session.handle(req('r1'));
    await vi.waitFor(() => expect(responses(x)).toHaveLength(1));
    const grantKey = getState().htmlNetGrants[0].key;
    const board1 = { id: 'b1', workspaceId: 'w1', name: 'Q', description: '', elements: [h], camera: { x: 0, y: 0, zoom: 1 }, createdAt: 1, updatedAt: 1, schemaVersion: 1 };
    const exported = buildExport([board1 as never], []);
    expect(exported).not.toContain(grantKey);
    expect(exported).not.toContain('htmlNetGrants');
    // Backup forjado declarando autorização dentro do bloco: ignorado (e o HTML chega desativado).
    const forged = JSON.parse(exported);
    forged.htmlNetGrants = getState().htmlNetGrants;
    forged.boards[0].elements[0].data.netGrants = [{ origin: ORIGIN }];
    const r = parseImport(JSON.stringify(forged), 'w1');
    const imported = r.boards[0].elements[0] as WidgetElement;
    expect(sanitizeSandbox(imported.data)).not.toHaveProperty('netGrants');
    expect(sanitizeSandbox(imported.data).activation?.state).toBe('blocked');
    // Mesmo ativado de novo, a marca de ativação é outra: a autorização antiga não vale para o importado.
    const activated = { ...imported, data: { ...(imported.data as object), activation: { state: 'allowed', source: 'import', at: Date.now() + 1 } } } as WidgetElement;
    board(activated);
    answers = ['deny'];
    x.session.dispose();
    const y = open(h.id);
    y.session.handle(req('r2'));
    await vi.waitFor(() => expect(responses(y)).toHaveLength(1));
    expect(prompts).toHaveLength(2);
  });
});
