/**
 * HTML Network Bridge (H2) — política de autorização e de dados sensíveis (PURA: recebe elementos e concessões).
 *
 * Duas autorizações distintas, ambas LOCAIS (configuração `htmlNetGrants` no IndexedDB do app; nunca no quadro,
 * em backups, em importações ou declaradas pelo próprio HTML):
 *
 * 1. `network` — o bloco pode consultar (GET) uma ORIGEM. Vale para: id do bloco + quadro + marca de ativação
 *    (importar/colar/duplicar gera outra) + resumo do HTML + conexões de entrada + origem + método.
 * 2. `sensitive` — ADICIONAL e específica: o bloco que recebe dados protegidos pode enviar consultas para aquela
 *    origem. Cobre, além do item 1, a lista exata de FONTES protegidas (id, tipo e configuração de cada uma).
 *
 * Fontes protegidas: Consulta bancária (contas bancárias / Meu Pluggy), Dados importados (Data Hub) e o bloco
 * Finanças (lançamentos digitados). Saídas que dependem delas também contam — o percurso segue conexões de DADOS
 * a montante (Fórmula, Mês, outro HTML…) e, num Assistente IA, também tudo o que ele lê (a resposta da IA deriva
 * do contexto autorizado para a IA — autorização para IA NÃO é autorização para enviar a uma API).
 */
import type { AuroraElement } from '../core/schema';
import { isLinear } from '../core/schema';
import { WIDGET } from '../core/widgetIds';
import { digest } from '../core/htmlBridge';
import { directInputEdges } from '../core/dataUpstream';
import { isNetOrigin } from './protocol';

export type SensitiveKind = 'bank' | 'dataset' | 'finance';
export interface SensitiveSource {
  id: string;
  kind: SensitiveKind | 'missing';
  title: string;
  /** Identidade + configuração da fonte (muda → a autorização sensível deixa de valer). */
  descriptor: string;
}

export const SENSITIVE_LABELS: Record<SensitiveKind | 'missing', string> = {
  bank: 'dados bancários (Consulta bancária / Meu Pluggy)',
  dataset: 'dados importados (Data Hub)',
  finance: 'lançamentos financeiros',
  missing: 'fonte protegida que não existe mais',
};

const cleanTitle = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

function sourceOf(el: AuroraElement): SensitiveSource | null {
  if (el.type !== 'widget') return null;
  const d = (el.data && typeof el.data === 'object' ? el.data : {}) as Record<string, unknown>;
  if (el.widgetType === WIDGET.bankQuery) {
    // Configuração da consulta (o que é lido do razão). Exibição e escolhas de IA não mudam o que flui.
    const cfg = ['ledgerId', 'accountIds', 'metric', 'category', 'periodMode', 'period', 'from', 'to', 'months', 'currency'].map((k) => d[k]);
    return { id: el.id, kind: 'bank', title: cleanTitle(el.title), descriptor: `${el.id}:bank:${digest(JSON.stringify(cfg))}` };
  }
  if (el.widgetType === WIDGET.dataset) {
    return { id: el.id, kind: 'dataset', title: cleanTitle(el.title), descriptor: `${el.id}:dataset:${digest(JSON.stringify([d.source ?? null, d.view ?? null]))}` };
  }
  if (el.widgetType === WIDGET.finance) {
    return { id: el.id, kind: 'finance', title: cleanTitle(el.title), descriptor: `${el.id}:finance:${digest(JSON.stringify([d.currency ?? null]))}` };
  }
  return null;
}

/**
 * Fontes protegidas que alimentam o bloco `id`, direta ou indiretamente. Segue conexões de DADOS a montante e,
 * ao passar por um Assistente IA, tudo o que ele pode ler (conexões de contexto/dados em qualquer sentido, como
 * em `contextSources`).
 *
 * Um bloco HTML a montante também carrega o que GUARDOU: a marca do estado gravado (`stateTaint`) e, via
 * `remembered`, as fontes que já alimentaram a execução dele nesta página (memória do iframe e saídas publicadas
 * continuam valendo depois de a conexão sumir). Fonte lembrada que não existe mais vira `missing` (bloqueia).
 */
export function sensitiveUpstream(elements: AuroraElement[], id: string, remembered: (elementId: string) => Iterable<string> = () => []): SensitiveSource[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const upstream = new Map<string, string[]>();
  const aiLinks = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  const isAI = (x: string) => { const e = byId.get(x); return e?.type === 'widget' && e.widgetType === WIDGET.ai; };
  for (const e of elements) {
    if (!isLinear(e) || !e.startBinding || !e.endBinding) continue;
    const a = e.startBinding.elementId, b = e.endBinding.elementId;
    if (e.connection.kind === 'data') add(upstream, b, a);
    if (e.connection.kind === 'data' || e.connection.kind === 'context') {
      if (isAI(a)) add(aiLinks, a, b);
      if (isAI(b)) add(aiLinks, b, a);
    }
  }
  const seen = new Set<string>([id]);
  const out: SensitiveSource[] = [];
  const queue = [...(upstream.get(id) ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const el = byId.get(cur);
    if (!el) continue;
    const s = sourceOf(el);
    if (s) out.push(s);
    if (el.type === 'widget' && el.widgetType === WIDGET.sandbox) {
      const t = (el.data as { stateTaint?: { sources?: unknown } } | null)?.stateTaint?.sources;
      const ids = [...(Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []), ...remembered(cur)];
      if (ids.length) out.push(...sourcesFromIds(elements, ids));
    }
    queue.push(...(upstream.get(cur) ?? []));
    if (isAI(cur)) queue.push(...(aiLinks.get(cur) ?? []));
  }
  return mergeSources(out);
}

/** Fontes a partir de ids lembrados (marca do estado, execução atual). Id que sumiu → `missing` (não verificável). */
export function sourcesFromIds(elements: AuroraElement[], ids: Iterable<string>): SensitiveSource[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out: SensitiveSource[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    const s = el ? sourceOf(el) : null;
    out.push(s ?? { id, kind: 'missing', title: '', descriptor: `${id}:missing` });
  }
  return out;
}

export function mergeSources(...lists: SensitiveSource[][]): SensitiveSource[] {
  const m = new Map<string, SensitiveSource>();
  for (const l of lists) for (const s of l) if (!m.has(s.id) || m.get(s.id)!.kind === 'missing') m.set(s.id, s);
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ chaves */

export interface NetContext {
  elementId: string;
  boardId: string;
  html: string;
  /** Marca de ativação: `local` para HTML do próprio usuário; importado/colado recebe outra a cada importação. */
  activation: string;
  elements: AuroraElement[];
}

export function activationStamp(a: unknown): string {
  const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
  return o ? `${String(o.state)}:${String(o.source)}:${Number(o.at) || 0}` : 'local';
}

/** Resumo da configuração que a autorização `network` cobre. */
export function netConfigDigest(ctx: NetContext): string {
  return digest(JSON.stringify(['h2', ctx.elementId, ctx.boardId, ctx.activation, ctx.html.length, digest(ctx.html), [...directInputEdges(ctx.elements, ctx.elementId)].sort()]));
}

export function networkKey(ctx: NetContext, origin: string, method = 'GET'): string {
  return digest(JSON.stringify(['net', netConfigDigest(ctx), origin, method]));
}

export function sensitiveKey(ctx: NetContext, origin: string, sources: SensitiveSource[], method = 'GET'): string {
  return digest(JSON.stringify(['sens', networkKey(ctx, origin, method), sources.map((s) => s.descriptor).sort()]));
}

/* ------------------------------------------------------------------ concessões persistentes */

export interface NetGrant {
  v: 1;
  kind: 'network' | 'sensitive';
  elementId: string;
  boardId: string;
  origin: string;
  method: 'GET';
  /** Resumo da configuração autorizada (comparado com o atual a cada consulta). */
  key: string;
  at: number;
  /** Só para a interface. */
  title: string;
  sources?: { id: string; kind: SensitiveKind; title: string }[];
}

export const MAX_NET_GRANTS = 500;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Configuração local (não confiável por princípio): descarta registros malformados. */
export function sanitizeNetGrants(raw: unknown): NetGrant[] {
  if (!Array.isArray(raw)) return [];
  const out: NetGrant[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    if (!o || o.v !== 1 || (o.kind !== 'network' && o.kind !== 'sensitive') || o.method !== 'GET') continue;
    if (typeof o.elementId !== 'string' || !ID.test(o.elementId) || typeof o.boardId !== 'string' || !ID.test(o.boardId)) continue;
    if (!isNetOrigin(o.origin) || typeof o.key !== 'string' || !/^[0-9a-f]{16}$/.test(o.key)) continue;
    const id = `${o.kind}|${o.elementId}|${o.boardId}|${o.origin}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const sources = Array.isArray(o.sources)
      ? o.sources.flatMap((s) => {
          const x = s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
          return x && typeof x.id === 'string' && ID.test(x.id) && (x.kind === 'bank' || x.kind === 'dataset' || x.kind === 'finance') ? [{ id: x.id, kind: x.kind as SensitiveKind, title: cleanTitle(x.title) }] : [];
        }).slice(0, 20)
      : undefined;
    out.push({ v: 1, kind: o.kind, elementId: o.elementId, boardId: o.boardId, origin: o.origin, method: 'GET', key: o.key, at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0, title: cleanTitle(o.title), ...(o.kind === 'sensitive' && sources ? { sources } : {}) });
  }
  return out.slice(-MAX_NET_GRANTS);
}

/* ------------------------------------------------------------------ avaliação */

export type NetDecision =
  | { state: 'allowed'; origin: string; sensitive: SensitiveSource[]; basis: string[] }
  | { state: 'prompt'; origin: string; sensitive: SensitiveSource[]; need: 'network' | 'sensitive'; networkKey: string; sensitiveKey: string }
  | { state: 'denied'; origin: string; reason: string }
  | { state: 'blocked'; origin: string; reason: string; sensitive: SensitiveSource[] };

export interface EvaluateInput {
  ctx: NetContext;
  origin: string;
  /** Fontes protegidas atuais + lembradas (execução e estado). */
  sensitive: SensitiveSource[];
  grants: NetGrant[];
  /** Chaves autorizadas “uma vez” nesta execução do bloco. */
  once: ReadonlySet<string>;
  /** Chaves negadas nesta execução (não pergunta de novo até recarregar). */
  denied: ReadonlySet<string>;
}

export function evaluateNet(i: EvaluateInput): NetDecision {
  const { ctx, origin } = i;
  const missing = i.sensitive.filter((s) => s.kind === 'missing');
  if (missing.length) {
    return { state: 'blocked', origin, sensitive: i.sensitive, reason: 'O estado salvo ou a execução atual deste bloco recebeu dados protegidos de uma fonte que não existe mais: não é possível identificar a origem dos dados para autorizar o envio. Limpe o estado do bloco e recarregue-o.' };
  }
  const nk = networkKey(ctx, origin);
  const sk = i.sensitive.length ? sensitiveKey(ctx, origin, i.sensitive) : '';
  if (i.denied.has(nk) || (sk && i.denied.has(sk))) return { state: 'denied', origin, reason: 'Acesso a este destino negado nesta execução do bloco.' };
  const has = (kind: NetGrant['kind'], key: string) => i.once.has(key) || i.grants.some((g) => g.kind === kind && g.key === key && g.elementId === ctx.elementId && g.boardId === ctx.boardId && g.origin === origin);
  const basis: string[] = [];
  if (!has('network', nk)) return { state: 'prompt', origin, sensitive: i.sensitive, need: i.sensitive.length ? 'sensitive' : 'network', networkKey: nk, sensitiveKey: sk };
  basis.push(nk);
  if (sk) {
    if (!has('sensitive', sk)) return { state: 'prompt', origin, sensitive: i.sensitive, need: 'sensitive', networkKey: nk, sensitiveKey: sk };
    basis.push(sk);
  }
  return { state: 'allowed', origin, sensitive: i.sensitive, basis };
}
