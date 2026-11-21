/**
 * H2 — corretor de requisições do HOST (origem do app). É a camada que decide se um iframe pode consultar a rede:
 *
 *   iframe ──aurora:request──▶ SandboxFrame (confere janela de origem e token) ──▶ NetSession.handle()
 *     valida mensagem/URL · limites por iframe · política (autorização + dados sensíveis) · confirmação (fila única)
 *     ──▶ transporte (servidor local) ──▶ revalida (revogação, desmontagem) ──▶ aurora:response ──▶ iframe
 *
 * Garantias desta camada: autorização do usuário, política de dados sensíveis, limites por iframe, cancelamento
 * (desmontagem, troca de quadro, revogação, edição). O servidor local impõe sozinho as regras de REDE (SSRF, DNS,
 * tamanho, tempo, tipos) — ver server/netBridge.ts e docs/HTML_NETWORK_BRIDGE.md › Fronteiras de confiança.
 */
import { getState, useEditor } from '../store/editor';
import { WIDGET } from '../core/widgetIds';
import { sanitizeSandbox, type SandboxData } from '../core/widgetData';
import type { AuroraElement, WidgetElement } from '../core/schema';
import { LOCAL_API_ENABLED } from '../config/runtime';
import { checkResult, NET_LIMITS, netError, netOrigin, parseAbortMessage, parseRequestMessage, responseMessage, type NetError, type NetErrorCode, type NetOutcome, type NetRequest } from './protocol';
import { activationStamp, evaluateNet, mergeSources, sensitiveUpstream, sourcesFromIds, type NetContext, type NetDecision, type NetGrant, type SensitiveSource } from './policy';
import { addNetGrants, removeNetGrants } from './grants';

/* ------------------------------------------------------------------ transporte */

export type NetTransport = (req: NetRequest, signal: AbortSignal) => Promise<NetOutcome>;
export interface NetAvailability { available: boolean; message: string }

export const STATIC_NET_MESSAGE = 'O acesso à rede dos blocos HTML não está disponível nesta versão pública do Aurora Board (não há servidor local).';
const INACTIVE_NET_MESSAGE = 'O transporte de rede dos blocos HTML ainda não está habilitado nesta versão.';

let transport: NetTransport | null = null;
let availability: NetAvailability = LOCAL_API_ENABLED ? { available: false, message: INACTIVE_NET_MESSAGE } : { available: false, message: STATIC_NET_MESSAGE };

/** Transporte padrão do app (registrado na inicialização) ou simulado (testes). `null` = indisponível. */
export function setNetTransport(t: NetTransport | null, message = INACTIVE_NET_MESSAGE) {
  if (!LOCAL_API_ENABLED && t) return; // build público: nunca há transporte (nem por gancho de teste)
  transport = t;
  availability = t ? { available: true, message: '' } : { available: false, message: LOCAL_API_ENABLED ? message : STATIC_NET_MESSAGE };
  notify();
}
export const netAvailability = (): NetAvailability => availability;

/* ------------------------------------------------------------------ confirmação */

export type ConsentAnswer = 'deny' | 'once' | 'always' | null;
export interface ConsentRequest {
  elementId: string;
  title: string;
  origin: string;
  method: 'GET';
  need: 'network' | 'sensitive';
  sensitive: SensitiveSource[];
  /** Títulos dos blocos ligados às entradas (aviso de que dados recebidos podem ir na URL). */
  inputs: string[];
  /** Quantas consultas estão esperando esta resposta. */
  waiting: () => number;
  /** Abortado quando ninguém mais espera a resposta (bloco fechado, consultas canceladas): a janela fecha sozinha. */
  signal: AbortSignal;
}
export type ConsentPrompter = (req: ConsentRequest) => Promise<ConsentAnswer>;
let prompter: ConsentPrompter = async () => 'deny';
/** Registrado pela interface (src/net/consent.tsx); testes injetam respostas. */
export function setConsentPrompter(p: ConsentPrompter) { prompter = p; }

/* ------------------------------------------------------------------ histórico mínimo (sem conteúdo) */

export interface NetActivity {
  /** Última consulta concluída: só origem, código, status HTTP, bytes e horário. Nunca o caminho, a consulta ou o corpo. */
  last?: { origin: string; at: number; ok: boolean; code?: NetErrorCode; status?: number; bytes?: number; ms: number };
  ok: number;
  blocked: number;
  /** Último bloqueio (motivo), sem a URL. */
  lastBlocked?: { at: number; code: NetErrorCode; origin?: string };
  pendingConsent: boolean;
}
const activity = new Map<string, NetActivity>();
const listeners = new Set<() => void>();
let version = 0;
function notify() { version++; for (const l of listeners) l(); }
export function subscribeNet(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
export const netVersion = () => version;
export const netActivity = (elementId: string): NetActivity | undefined => activity.get(elementId);
function touch(elementId: string): NetActivity {
  let a = activity.get(elementId);
  if (!a) { a = { ok: 0, blocked: 0, pendingConsent: false }; activity.set(elementId, a); }
  return a;
}

/* ------------------------------------------------------------------ sessões (uma por montagem do iframe) */

interface Pending {
  /** Libera a vaga global de execução (uma única vez: fim normal, tempo, cancelamento, revogação). */
  release?: () => void;
  id: string;
  req: NetRequest;
  origin: string;
  phase: 'consent' | 'queued' | 'running';
  ctrl: AbortController;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface ConsentJob {
  session: NetSession;
  key: string;
  decision: Extract<NetDecision, { state: 'prompt' }>;
  waiters: Set<string>;
  ctrl: AbortController;
}

const sessions = new Set<NetSession>();
/**
 * Fontes protegidas que já alimentaram cada bloco HTML nesta página (memória do iframe, saídas publicadas que
 * sobrevivem à desmontagem). Vale para blocos a JUSANTE também. Zera ao trocar de quadro ou recarregar a página.
 */
const remembered = new Map<string, Set<string>>();
const rememberedOf = (elementId: string): Iterable<string> => remembered.get(elementId) ?? [];
const consentQueue: ConsentJob[] = [];
let consentBusy = false;
const runQueue: { session: NetSession; id: string }[] = [];
let running = 0;

export interface NetSessionOptions {
  elementId: string;
  token: string;
  post: (msg: unknown) => void;
  now?: () => number;
}

interface Snapshot { el: WidgetElement; data: SandboxData; elements: AuroraElement[]; boardId: string }

export class NetSession {
  readonly elementId: string;
  readonly token: string;
  private post: (msg: unknown) => void;
  private now: () => number;
  private readonly boardId: string;
  private pending = new Map<string, Pending>();
  private done = new Set<string>();
  private hits: number[] = [];
  private msgWindow = 0;
  private msgCount = 0;
  /** Concessões “Permitir uma vez”: valem até esta montagem do iframe acabar. */
  readonly once = new Set<string>();
  private onceOrigin = new Map<string, string>();
  readonly denied = new Set<string>();
  /** Fontes protegidas que alimentaram ESTA execução em algum momento (o iframe pode guardar os dados na memória). */
  readonly sticky = new Set<string>();
  disposed = false;

  constructor(o: NetSessionOptions) {
    this.elementId = o.elementId;
    this.token = o.token;
    this.post = o.post;
    this.now = o.now ?? (() => Date.now());
    this.boardId = getState().boardId ?? '';
    sessions.add(this);
    this.observe();
  }

  /** Atualiza as fontes “grudadas” desta execução (chamado também a cada mudança do quadro). */
  observe() {
    if (this.disposed) return;
    const s = getState();
    for (const src of sensitiveUpstream(s.elements, this.elementId, rememberedOf)) this.sticky.add(src.id);
    if (this.sticky.size) {
      let set = remembered.get(this.elementId);
      if (!set) { set = new Set(); remembered.set(this.elementId, set); }
      for (const x of this.sticky) set.add(x);
    }
  }

  private snapshot(): Snapshot | null {
    const s = getState();
    if (this.disposed || (s.boardId ?? '') !== this.boardId) return null;
    const el = s.elements.find((e) => e.id === this.elementId);
    if (!el || el.type !== 'widget' || el.widgetType !== WIDGET.sandbox) return null;
    return { el, data: sanitizeSandbox(el.data), elements: s.elements, boardId: this.boardId };
  }

  context(snap: Snapshot): NetContext {
    return { elementId: this.elementId, boardId: snap.boardId, html: snap.data.html, activation: activationStamp(snap.data.activation), elements: snap.elements };
  }

  sensitive(snap: Snapshot): SensitiveSource[] {
    return mergeSources(sensitiveUpstream(snap.elements, this.elementId, rememberedOf), sourcesFromIds(snap.elements, this.sticky), sourcesFromIds(snap.elements, snap.data.stateTaint?.sources ?? []));
  }

  decide(origin: string): NetDecision | null {
    const snap = this.snapshot();
    if (!snap) return null;
    return evaluateNet({ ctx: this.context(snap), origin, sensitive: this.sensitive(snap), grants: getState().htmlNetGrants, once: this.once, denied: this.denied });
  }

  /** Ids das fontes protegidas desta execução (para marcar o estado gravado). */
  taintIds(): string[] {
    const snap = this.snapshot();
    return snap ? this.sensitive(snap).map((s) => s.id) : [...this.sticky];
  }

  private respond(id: string, outcome: NetOutcome, origin?: string) {
    const p = this.pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    p?.release?.();
    this.pending.delete(id);
    this.remember(id);
    const a = touch(this.elementId);
    if (outcome.ok) {
      a.ok++;
      a.last = { origin: origin ?? '', at: this.now(), ok: true, status: outcome.result.status, bytes: outcome.result.bytes, ms: p ? this.now() - p.started : 0 };
    } else {
      const blockedCodes: NetErrorCode[] = ['permission_denied', 'sensitive_blocked', 'blocked_url', 'blocked_address', 'invalid_url', 'headers_not_allowed', 'method_not_allowed', 'rate_limited', 'too_many_pending', 'redirect_blocked', 'unavailable', 'local_only', 'revoked'];
      if (blockedCodes.includes(outcome.error.code)) { a.blocked++; a.lastBlocked = { at: this.now(), code: outcome.error.code, ...(origin ? { origin } : {}) }; }
      if (p?.phase === 'running' || outcome.error.code === 'http_error') a.last = { origin: origin ?? '', at: this.now(), ok: false, code: outcome.error.code, ...(outcome.error.status ? { status: outcome.error.status } : {}), ms: p ? this.now() - p.started : 0 };
    }
    notify();
    cancelStaleConsent(this);
    if (!this.disposed) this.post(responseMessage(this.token, id, outcome));
  }

  private remember(id: string) {
    this.done.add(id);
    if (this.done.size > 500) this.done.delete(this.done.values().next().value as string);
  }

  /** Mensagem do iframe (a janela de origem e o token já foram conferidos pelo SandboxFrame). Retorna se tratou. */
  handle(data: unknown): boolean {
    const ab = parseAbortMessage(data);
    if (ab) {
      if (ab.token === this.token) this.abort(ab.id, netError('aborted', 'Consulta cancelada pelo bloco.'));
      return true;
    }
    const m = parseRequestMessage(data);
    if (!m) return (data as { type?: unknown } | null)?.type === 'aurora:request';
    if (m.token !== this.token || this.disposed) return true;
    // IDs repetidos (em andamento ou já respondidos) são ignorados: responder trocaria a resposta da original.
    if (this.pending.has(m.id) || this.done.has(m.id)) return true;
    const t = this.now();
    if (t - this.msgWindow >= 1000) { this.msgWindow = t; this.msgCount = 0; }
    if (++this.msgCount > NET_LIMITS.maxMessagesPerSecond) { this.remember(m.id); return true; } // inundação: descarta em silêncio
    if (m.kind === 'invalid') { this.respond(m.id, { ok: false, error: m.error }); return true; }
    const origin = netOrigin(m.request.url);
    if (!availability.available || !transport) { this.respond(m.id, netError('unavailable', availability.message), origin); return true; }
    if (this.pending.size >= NET_LIMITS.maxPendingPerFrame) { this.respond(m.id, netError('too_many_pending', `Mais de ${NET_LIMITS.maxPendingPerFrame} consultas em andamento neste bloco: aguarde as anteriores.`), origin); return true; }
    while (this.hits.length && t - this.hits[0] >= 60_000) this.hits.shift();
    if (this.hits.length >= NET_LIMITS.maxPerMinutePerFrame) { this.respond(m.id, netError('rate_limited', `Limite de ${NET_LIMITS.maxPerMinutePerFrame} consultas por minuto por bloco.`), origin); return true; }
    this.hits.push(t);
    const p: Pending = { id: m.id, req: m.request, origin, phase: 'consent', ctrl: new AbortController(), started: t };
    this.pending.set(m.id, p);
    this.route(p);
    return true;
  }

  /** Decide o próximo passo de uma consulta: executar, pedir confirmação ou recusar. */
  route(p: Pending) {
    const d = this.decide(p.origin);
    if (!d) return this.respond(p.id, netError('unmounted', 'O bloco foi fechado, movido para outro quadro ou excluído.'), p.origin);
    if (d.state === 'blocked') return this.respond(p.id, netError('sensitive_blocked', d.reason), p.origin);
    if (d.state === 'denied') return this.respond(p.id, netError('permission_denied', 'Acesso negado pelo usuário a este destino (nesta execução do bloco).'), p.origin);
    if (d.state === 'prompt') return enqueueConsent(this, p.id, d);
    p.phase = 'queued';
    runQueue.push({ session: this, id: p.id });
    pump();
  }

  /** Executa (chamado pela fila global quando há vaga). */
  async run(id: string) {
    const p = this.pending.get(id);
    if (!p || this.disposed || !transport) { running--; pump(); return; }
    // A vaga volta à fila uma única vez — mesmo se o transporte nunca terminar (tempo, cancelamento, revogação).
    let released = false;
    p.release = () => { if (released) return; released = true; running--; pump(); };
    // Revalida IMEDIATAMENTE antes de enviar: a URL já carrega os dados — recusar a resposta depois não desfaz o envio.
    // (Revogação/edição enquanto a consulta esperava vaga na fila.)
    const before = this.decide(p.origin);
    if (!before) return this.respond(id, netError('unmounted', 'O bloco foi fechado, movido para outro quadro ou excluído.'), p.origin);
    if (before.state !== 'allowed') return this.respond(id, netError('revoked', 'A autorização deixou de valer antes do envio (revogada, ou o HTML/as conexões mudaram).'), p.origin);
    p.phase = 'running';
    p.started = this.now();
    const t = transport;
    p.timer = setTimeout(() => this.abort(id, netError('timeout', `Tempo esgotado (${Math.round(p.req.timeoutMs / 1000)} s).`)), p.req.timeoutMs + 1500);
    let out: NetOutcome;
    try {
      out = await t(p.req, p.ctrl.signal);
    } catch {
      out = netError(p.ctrl.signal.aborted ? 'aborted' : 'network_error', p.ctrl.signal.aborted ? 'Consulta cancelada.' : 'Falha ao consultar pelo servidor local.');
    } finally {
      p.release();
    }
    if (this.pending.get(id) !== p || p.ctrl.signal.aborted) return; // já respondida (cancelada, revogada, tempo)
    // Revalida no fim: a autorização pode ter caído (revogação, edição, conexão nova) durante a consulta.
    const d = this.decide(p.origin);
    if (!d) return this.respond(id, netError('unmounted', 'O bloco foi fechado ou excluído durante a consulta.'), p.origin);
    if (d.state !== 'allowed') return this.respond(id, netError('revoked', 'A autorização deixou de valer durante a consulta (revogada, ou o HTML/as conexões mudaram).'), p.origin);
    this.respond(id, checkResult(out, p.req), p.origin);
  }

  abort(id: string, error: { ok: false; error: NetError }) {
    const p = this.pending.get(id);
    if (!p) return;
    p.ctrl.abort();
    this.respond(id, error, p.origin);
  }

  /** Reavalia consultas em andamento/na fila (revogação, mudança de configuração). */
  recheck() {
    for (const p of [...this.pending.values()]) {
      if (p.phase === 'consent') continue; // a resposta da confirmação reavalia
      const d = this.decide(p.origin);
      if (!d) this.abort(p.id, netError('unmounted', 'O bloco foi fechado, movido para outro quadro ou excluído.'));
      else if (d.state !== 'allowed') this.abort(p.id, netError('revoked', 'Autorização revogada ou desatualizada: consulta cancelada.'));
    }
  }

  pendingIds(): string[] { return [...this.pending.keys()]; }
  phaseOf(id: string) { return this.pending.get(id)?.phase; }
  pendingEntry(id: string) { return this.pending.get(id); }

  /** Desmontagem do iframe (fechar, editar, excluir, trocar de quadro, navegação bloqueada). */
  dispose() {
    if (this.disposed) return;
    // Primeiro marca e tira da fila: liberar as vagas abaixo chama pump(), que não pode despachar nada desta sessão.
    this.disposed = true;
    sessions.delete(this);
    for (let i = runQueue.length - 1; i >= 0; i--) if (runQueue[i].session === this) runQueue.splice(i, 1);
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) { p.ctrl.abort(); if (p.timer) clearTimeout(p.timer); p.release?.(); }
    cancelStaleConsent(this);
    for (let i = consentQueue.length - 1; i >= 0; i--) if (consentQueue[i].session === this && !(consentBusy && i === 0)) consentQueue.splice(i, 1);
    const a = activity.get(this.elementId);
    if (a?.pendingConsent && ![...sessions].some((s) => s.elementId === this.elementId && consentQueue.some((j) => j.session === s))) a.pendingConsent = false;
    notify();
  }

  allowOnce(key: string, origin: string) { this.once.add(key); this.onceOrigin.set(key, origin); }
  /** Concessões “uma vez” desta execução (revogação pelo painel), de todas as origens ou de uma. */
  forgetOnce(origin?: string) {
    for (const k of [...this.once]) if (!origin || this.onceOrigin.get(k) === origin) { this.once.delete(k); this.onceOrigin.delete(k); }
  }
}

/* ------------------------------------------------------------------ fila de confirmações (uma por vez) */

/** Confirmação sem ninguém esperando (bloco fechado, consultas canceladas): fecha a janela. */
function cancelStaleConsent(session: NetSession) {
  for (const j of consentQueue) {
    if (j.session !== session || j.ctrl.signal.aborted) continue;
    if (session.disposed || ![...j.waiters].some((id) => session.phaseOf(id) === 'consent')) j.ctrl.abort();
  }
}

function enqueueConsent(session: NetSession, id: string, d: Extract<NetDecision, { state: 'prompt' }>) {
  const key = d.need === 'sensitive' ? `s:${d.sensitiveKey}` : `n:${d.networkKey}`;
  // Pedidos simultâneos do mesmo bloco para o mesmo destino esperam UMA confirmação.
  const job = consentQueue.find((j) => j.session === session && j.key === key);
  if (job) { job.waiters.add(id); return; }
  consentQueue.push({ session, key, decision: d, waiters: new Set([id]), ctrl: new AbortController() });
  touch(session.elementId).pendingConsent = true;
  notify();
  void pumpConsent();
}

async function waitDialogFree() {
  if (!getState().dialog) return;
  await new Promise<void>((resolve) => {
    const un = useEditor.subscribe((s) => { if (!s.dialog) { un(); resolve(); } });
  });
}

async function pumpConsent() {
  if (consentBusy) return;
  consentBusy = true;
  try {
    while (consentQueue.length) {
      const job = consentQueue[0];
      const s = job.session;
      const live = () => [...job.waiters].filter((id) => s.phaseOf(id) === 'consent');
      if (s.disposed || !live().length) { consentQueue.shift(); continue; }
      await waitDialogFree();
      if (s.disposed || !live().length) { consentQueue.shift(); continue; }
      const st = getState();
      const el = st.elements.find((e) => e.id === s.elementId);
      const inputs = [...new Set(st.elements.flatMap((x) => (x.type === 'arrow' || x.type === 'line') && x.connection.kind === 'data' && x.endBinding?.elementId === s.elementId && x.startBinding ? [titleOf(st.elements, x.startBinding.elementId)] : []))];
      let answer: ConsentAnswer = null;
      try {
        answer = job.ctrl.signal.aborted ? null : await prompter({ elementId: s.elementId, title: el?.type === 'widget' ? el.title : 'Bloco HTML', origin: job.decision.origin, method: 'GET', need: job.decision.need, sensitive: job.decision.sensitive, inputs, waiting: () => live().length, signal: job.ctrl.signal });
      } catch { answer = null; }
      consentQueue.shift();
      await applyAnswer(job, answer);
      if (!consentQueue.some((j) => j.session.elementId === s.elementId)) { touch(s.elementId).pendingConsent = false; notify(); }
    }
  } finally {
    consentBusy = false;
  }
}

function titleOf(elements: AuroraElement[], id: string) {
  const e = elements.find((x) => x.id === id);
  return (e?.type === 'widget' ? e.title : e && 'text' in e ? String((e as { text?: unknown }).text ?? '').split('\n')[0] : id).slice(0, 60) || 'Bloco';
}

async function applyAnswer(job: ConsentJob, answer: ConsentAnswer) {
  const s = job.session;
  const d = job.decision;
  const waiters = [...job.waiters].filter((id) => s.phaseOf(id) === 'consent');
  if (s.disposed) return;
  if (answer === 'deny' || answer === null) {
    // “Negar” vale para esta execução (sem nova pergunta a cada consulta); fechar a janela recusa só estas.
    if (answer === 'deny') { s.denied.add(d.networkKey); if (d.sensitiveKey) s.denied.add(d.sensitiveKey); }
    for (const id of waiters) s.abort(id, netError('permission_denied', answer === 'deny' ? 'Acesso negado pelo usuário.' : 'Confirmação fechada sem permitir.'));
    return;
  }
  if (answer === 'once') {
    s.allowOnce(d.networkKey, d.origin);
    if (d.sensitiveKey) s.allowOnce(d.sensitiveKey, d.origin);
  } else {
    const st = getState();
    const el = st.elements.find((e) => e.id === s.elementId);
    const base = { v: 1 as const, elementId: s.elementId, boardId: st.boardId ?? '', origin: d.origin, method: 'GET' as const, at: Date.now(), title: el?.type === 'widget' ? el.title.slice(0, 60) : '' };
    const grants: NetGrant[] = [{ ...base, kind: 'network', key: d.networkKey }];
    if (d.sensitiveKey) grants.push({ ...base, kind: 'sensitive', key: d.sensitiveKey, sources: d.sensitive.flatMap((x) => (x.kind === 'missing' ? [] : [{ id: x.id, kind: x.kind, title: x.title }])) });
    await addNetGrants(grants);
  }
  // Reavalia: a configuração pode ter mudado com a janela aberta (a autorização dada pode não valer mais).
  for (const id of waiters) {
    const p = s.pendingEntry(id);
    if (!p || p.phase !== 'consent') continue;
    const now = s.decide(p.origin);
    if (now?.state === 'allowed') s.route(p);
    else s.abort(id, netError('revoked', 'O bloco mudou enquanto a confirmação estava aberta: tente de novo.'));
  }
}

/* ------------------------------------------------------------------ fila de execução (concorrência global) */

function pump() {
  while (running < NET_LIMITS.maxConcurrent && runQueue.length) {
    const next = runQueue.shift()!;
    if (next.session.disposed || next.session.phaseOf(next.id) !== 'queued') continue;
    running++;
    void next.session.run(next.id);
  }
}

/* ------------------------------------------------------------------ revogação */

/** Revoga o acesso de um bloco (todas as origens ou uma): persistentes, “uma vez” e consultas em andamento. */
export async function revokeNetAccess(elementId: string, origin?: string) {
  const boardId = getState().boardId ?? '';
  for (const s of sessions) if (s.elementId === elementId) s.forgetOnce(origin);
  await removeNetGrants(elementId, boardId, origin);
  for (const s of sessions) if (s.elementId === elementId) s.recheck();
  notify();
}

// Mudanças no quadro (conexões, HTML, quadro aberto) e nas concessões: reavalia tudo o que está em andamento.
let lastElements: unknown = null, lastGrants: unknown = null, lastBoard: unknown = null;
useEditor.subscribe((s) => {
  if (s.elements === lastElements && s.htmlNetGrants === lastGrants && s.boardId === lastBoard) return;
  if (s.boardId !== lastBoard) remembered.clear();
  lastElements = s.elements; lastGrants = s.htmlNetGrants; lastBoard = s.boardId;
  if (!sessions.size) return;
  for (const x of [...sessions]) { x.observe(); x.recheck(); }
});

/** Somente testes. */
export function resetNetForTests() {
  for (const s of [...sessions]) s.dispose();
  consentQueue.length = 0;
  runQueue.length = 0;
  running = 0;
  consentBusy = false;
  activity.clear();
  remembered.clear();
  transport = null;
  availability = LOCAL_API_ENABLED ? { available: false, message: INACTIVE_NET_MESSAGE } : { available: false, message: STATIC_NET_MESSAGE };
  prompter = async () => 'deny';
}
