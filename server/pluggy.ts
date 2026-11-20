/**
 * Meu Pluggy — uso pessoal (issue #9 / ciclo OF1). Adaptador SOMENTE LEITURA que roda no servidor local.
 *
 * - Credenciais (`PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`) e itens (`PLUGGY_ITEM_IDS`) vêm do `.env` local
 *   (ignorado pelo Git). A API Key da Pluggy (validade de 2 h) é obtida sob demanda, fica só na memória do
 *   processo e é renovada antes de expirar ou após um 401. Nada disso vai para o navegador, logs ou URLs.
 * - Único host: https://api.pluggy.ai (TLS). URLs são montadas aqui; o cursor `next` da API v2 só é aceito
 *   como query string relativa e só o parâmetro `after` é reaproveitado — nunca se segue outro host.
 * - Endpoints usados: POST /auth, GET /items/{id}, GET /accounts?itemId, GET /v2/transactions (cursor).
 *   O legado GET /transactions NÃO é usado (410 para aplicações novas; encerra em 31/12/2026).
 *   Nenhuma operação de escrita na Pluggy (nem PATCH de item: o Meu Pluggy não permite atualização forçada).
 * - Respostas validadas em tempo de execução; valores em reais (número decimal) viram centavos inteiros por
 *   texto (sem erro de ponto flutuante). Campos com dados de terceiros (paymentData, CPF/CNPJ, número de
 *   cartão, titular) são descartados aqui e nunca chegam ao navegador.
 */
import { z } from 'zod';

export const PLUGGY_BASE = 'https://api.pluggy.ai';
const PLUGGY_ORIGIN = new URL(PLUGGY_BASE).origin;

export const PLUGGY_LIMITS = {
  /** Itens aceitos em PLUGGY_ITEM_IDS (o Meu Pluggy permite 5 conexões; folga para renovações). */
  maxItems: 10,
  timeoutMs: 20_000,
  /** Corpo máximo de uma resposta da Pluggy. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Páginas de /v2/transactions por pedido (500 por página → até 100 mil movimentações). */
  maxPages: 200,
  maxTransactions: 100_000,
  /** Intervalo máximo de datas por pedido. */
  maxRangeDays: 3 * 366,
  /** Chamadas de saída por minuto (a Pluggy limita ~360/min por endpoint e IP). */
  outboundPerMinute: 120,
  /** A API Key vale 2 h; renovamos com folga. */
  apiKeyTtlMs: 100 * 60_000,
  /** Cache curto da lista de contas (para validar accountId sem nova chamada). */
  accountsCacheMs: 5 * 60_000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ configuração */

export interface PluggyConfig { clientId: string; clientSecret: string; itemIds: string[] }

/** Lê o `.env`. Problemas descrevem O QUE falta, nunca o valor. */
export function readPluggyConfig(env: Record<string, string | undefined> = process.env): { config: PluggyConfig | null; problems: string[]; present: boolean } {
  const id = (env.PLUGGY_CLIENT_ID ?? '').trim();
  const secret = (env.PLUGGY_CLIENT_SECRET ?? '').trim();
  const rawItems = (env.PLUGGY_ITEM_IDS ?? '').trim();
  const present = !!(id || secret || rawItems);
  const problems: string[] = [];
  if (!present) return { config: null, problems: ['Meu Pluggy não configurado: defina PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITEM_IDS no .env do servidor local.'], present };
  if (!id) problems.push('PLUGGY_CLIENT_ID ausente.');
  else if (!isUuid(id)) problems.push('PLUGGY_CLIENT_ID não tem o formato esperado (UUID).');
  if (!secret) problems.push('PLUGGY_CLIENT_SECRET ausente.');
  else if (secret.length > 512 || /\s/.test(secret)) problems.push('PLUGGY_CLIENT_SECRET com formato inesperado.');
  const parts = rawItems.split(/[\s,;]+/).filter(Boolean);
  const items = [...new Set(parts.map((p) => p.toLowerCase()))];
  if (!items.length) problems.push('PLUGGY_ITEM_IDS vazio: copie os itemIds em Dashboard → Aplicações → Demo → Itens conectados.');
  const bad = items.filter((i) => !isUuid(i)).length;
  if (bad) problems.push(`${bad} item(ns) em PLUGGY_ITEM_IDS fora do formato UUID.`);
  if (items.length > PLUGGY_LIMITS.maxItems) problems.push(`No máximo ${PLUGGY_LIMITS.maxItems} itens em PLUGGY_ITEM_IDS.`);
  if (problems.length) return { config: null, problems, present };
  return { config: { clientId: id, clientSecret: secret, itemIds: items }, problems: [], present };
}

/* ------------------------------------------------------------------ erros */

export type PluggyErrorCode =
  | 'not_configured' // .env incompleto
  | 'auth_failed' // credenciais recusadas (401 no /auth)
  | 'forbidden' // 403 (recurso não liberado para a aplicação)
  | 'not_found' // item/conta inexistente (ex.: itemId mudou na renovação)
  | 'invalid' // parâmetros recusados (400)
  | 'deprecated' // 410 (endpoint legado)
  | 'rate_limited' // 429
  | 'unavailable' // 5xx, rede, tempo esgotado
  | 'bad_response' // resposta fora do formato documentado
  | 'too_large' // teto de páginas/registros/tamanho
  | 'cancelled';

const HTTP_BY_CODE: Record<PluggyErrorCode, number> = {
  not_configured: 503, auth_failed: 502, forbidden: 502, not_found: 404, invalid: 400, deprecated: 502,
  rate_limited: 429, unavailable: 503, bad_response: 502, too_large: 413, cancelled: 499,
};

export class PluggyError extends Error {
  readonly status: number;
  constructor(public code: PluggyErrorCode, message: string, public retryAfter?: number, public upstream?: string) {
    super(message);
    this.name = 'PluggyError';
    this.status = HTTP_BY_CODE[code];
  }
}

/* ------------------------------------------------------------------ transporte */

export interface PluggyResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type PluggyFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' }) => Promise<PluggyResponse>;

const defaultFetch: PluggyFetch = (url, init) => fetch(url, init);

export interface PluggyClientDeps {
  fetch?: PluggyFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<typeof PLUGGY_LIMITS>;
}

/** Código de erro da Pluggy (só letras maiúsculas/sublinhado; nada de mensagem livre). */
function upstreamCode(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { codeDescription?: unknown; code?: unknown };
    const c = typeof j.codeDescription === 'string' ? j.codeDescription : typeof j.code === 'string' ? j.code : '';
    return /^[A-Z][A-Z0-9_]{1,60}$/.test(c) ? c : undefined;
  } catch { return undefined; }
}

/* ------------------------------------------------------------------ esquemas (validação em tempo de execução) */

const money = z.number().finite();
const ItemSchema = z.object({
  id: z.string(),
  status: z.string().max(60),
  executionStatus: z.string().max(60).nullish(),
  connector: z.object({ id: z.number().nullish(), name: z.string().max(120).nullish() }).nullish(),
  error: z.object({ code: z.string().max(80).nullish() }).nullish(),
  lastUpdatedAt: z.string().max(40).nullish(),
  nextAutoSyncAt: z.string().max(40).nullish(),
  consentExpiresAt: z.string().max(40).nullish(),
  statusDetail: z.unknown().optional(),
});
const AccountSchema = z.object({
  id: z.string(),
  type: z.string().max(30),
  subtype: z.string().max(40).nullish(),
  number: z.string().max(80).nullish(),
  name: z.string().max(300).nullish(),
  marketingName: z.string().max(300).nullish(),
  balance: money.nullish(),
  currencyCode: z.string().max(5).nullish(),
  itemId: z.string().nullish(),
  bankData: z.object({ transferNumber: z.string().max(80).nullish(), closingBalance: money.nullish() }).nullish(),
  creditData: z.object({
    creditLimit: money.nullish(),
    availableCreditLimit: money.nullish(),
    balanceCloseDate: z.string().max(40).nullish(),
    balanceDueDate: z.string().max(40).nullish(),
    brand: z.string().max(40).nullish(),
  }).nullish(),
});
const AccountsPageSchema = z.object({ results: z.array(z.unknown()), totalPages: z.number().int().nullish(), page: z.number().int().nullish() });
const TransactionSchema = z.object({
  id: z.string(),
  accountId: z.string().nullish(),
  description: z.string().max(2000).nullish(),
  descriptionRaw: z.string().max(2000).nullish(),
  currencyCode: z.string().max(5).nullish(),
  amount: money,
  amountInAccountCurrency: money.nullish(),
  date: z.string().max(40),
  category: z.string().max(200).nullish(),
  status: z.string().max(20).nullish(),
  type: z.string().max(20).nullish(),
  operationType: z.string().max(60).nullish(),
  creditCardMetadata: z.object({
    installmentNumber: z.number().nullish(),
    totalInstallments: z.number().nullish(),
    purchaseDate: z.string().max(40).nullish(),
  }).nullish(),
});
const TransactionsPageSchema = z.object({ results: z.array(z.unknown()), next: z.string().max(4096).nullish() });

/* ------------------------------------------------------------------ normalização (pura, testável) */

/** Reais (número decimal da API) → centavos inteiros, via texto. null se não for um valor seguro. */
export function toCents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= 1e11) return null;
  const s = Math.abs(v).toFixed(2);
  const [i, f] = s.split('.');
  const cents = Number(i) * 100 + Number(f);
  return v < 0 ? -cents : cents;
}

/**
 * Data civil (AAAA-MM-DD) de um campo de data da Pluggy (ISO 8601 em UTC).
 * Meia-noite UTC exata é tratada como data sem hora (é como os bancos informam datas de lançamento); com
 * hora, converte para o horário de Brasília (UTC−3, sem horário de verão desde 2019).
 */
export function toCivilDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (DATE_RE.test(s)) return validCivil(s);
  const m = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/.exec(s);
  if (m) return validCivil(m[1]);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return validCivil(new Date(t - 3 * 3_600_000).toISOString().slice(0, 10));
}
function validCivil(d: string): string | null {
  const [y, m, day] = d.split('-').map(Number);
  if (y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day ? d : null;
}

// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Bancos conhecidos pelo código COMPE (o conector MeuPluggy agrega contas de vários bancos num item). */
const COMPE: Record<string, string> = {
  '001': 'Banco do Brasil', '033': 'Santander', '077': 'Banco Inter', '104': 'Caixa', '208': 'BTG Pactual', '212': 'Banco Original',
  '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6 Bank', '341': 'Itaú', '380': 'PicPay', '756': 'Sicoob', '748': 'Sicredi',
};
const NAME_HINTS: [RegExp, string][] = [
  [/\bnu ?bank\b|\bnu pagamentos\b|\bultravioleta\b/i, 'Nubank'], [/\binter\b/i, 'Banco Inter'], [/\bita[uú]\b/i, 'Itaú'], [/\bbradesco\b/i, 'Bradesco'],
  [/\bsantander\b/i, 'Santander'], [/\bcaixa\b/i, 'Caixa'], [/\bbanco do brasil\b/i, 'Banco do Brasil'], [/\bc6\b/i, 'C6 Bank'], [/\bpicpay\b/i, 'PicPay'], [/\bmercado ?pago\b/i, 'Mercado Pago'],
];

export function institutionOf(acc: { bankData?: { transferNumber?: string | null } | null; name?: string | null; marketingName?: string | null }, fallback: string): string {
  const compe = /^(\d{3})\//.exec(acc.bankData?.transferNumber ?? '')?.[1];
  if (compe && COMPE[compe]) return COMPE[compe];
  const text = `${acc.marketingName ?? ''} ${acc.name ?? ''}`;
  for (const [re, n] of NAME_HINTS) if (re.test(text)) return n;
  return fallback;
}

export type PluggyAccountType = 'checking' | 'savings' | 'credit_card' | 'other';
export interface PluggyAccountDTO {
  id: string;
  itemId: string;
  name: string;
  type: PluggyAccountType;
  currency: 'BRL' | 'USD' | 'EUR';
  /** Só os 4 últimos dígitos/caracteres (nunca o número completo). */
  numberTail?: string;
  institutionName: string;
  /** Saldo do ponto de vista da conta (num cartão, fatura em aberto = negativo). */
  balance?: { cents: number; asOf: string; availableCents?: number };
  card?: { limitCents?: number; availableLimitCents?: number; closingDay?: number; dueDay?: number };
}

const CURRENCIES = new Set(['BRL', 'USD', 'EUR']);
const dayOf = (v: unknown) => { const d = toCivilDate(v); return d ? Number(d.slice(8, 10)) : undefined; };
const nonNeg = (v: unknown) => { const c = toCents(v); return c !== null && c >= 0 ? c : undefined; };

/** Conta da Pluggy → DTO mínimo. null quando fora do escopo (moeda não suportada, formato inválido). */
export function normalizeAccount(raw: unknown, itemId: string, fallbackInstitution: string, today: string): PluggyAccountDTO | null {
  const p = AccountSchema.safeParse(raw);
  if (!p.success || !isUuid(p.data.id)) return null;
  const a = p.data;
  const currency = (a.currencyCode ?? 'BRL').toUpperCase();
  if (!CURRENCIES.has(currency)) return null;
  const isCard = a.type === 'CREDIT' || a.subtype === 'CREDIT_CARD';
  const type: PluggyAccountType = isCard ? 'credit_card' : a.subtype === 'SAVINGS_ACCOUNT' ? 'savings' : a.type === 'BANK' ? 'checking' : 'other';
  const tail = String(a.number ?? '').replace(/[^0-9a-z]/gi, '').slice(-4) || undefined;
  const bal = toCents(a.balance);
  const dto: PluggyAccountDTO = {
    id: a.id.toLowerCase(),
    itemId,
    name: clean(a.marketingName || a.name, 80) || (isCard ? 'Cartão de crédito' : 'Conta'),
    type,
    currency: currency as PluggyAccountDTO['currency'],
    numberTail: tail,
    institutionName: institutionOf(a, fallbackInstitution),
    // Cartão: a Pluggy informa a fatura em aberto como valor POSITIVO devido; no razão a dívida é negativa.
    balance: bal === null ? undefined : { cents: isCard ? -bal : bal, asOf: today },
  };
  if (isCard) {
    const c = a.creditData;
    dto.card = { limitCents: nonNeg(c?.creditLimit), availableLimitCents: nonNeg(c?.availableCreditLimit), closingDay: dayOf(c?.balanceCloseDate), dueDay: dayOf(c?.balanceDueDate) };
  }
  return dto;
}

export interface PluggyTransactionDTO {
  id: string;
  accountId: string;
  postedDate: string;
  operationDate?: string;
  description: string;
  /** Centavos com sinal do ponto de vista da conta (crédito +, débito −). */
  amountCents: number;
  status: 'posted' | 'pending';
  category?: string;
  type?: string;
  installment?: { index: number; count: number };
}

/**
 * Movimentação da Pluggy → DTO mínimo, com o sinal do razão.
 * - Cartão (documentado): valor positivo = compra (aumenta a dívida) → no razão é NEGATIVO; negativo = pagamento/estorno.
 * - Conta: DEBIT = saída, CREDIT = entrada. Se o sinal do valor contradiz `type`, prevalece `type` (alguns
 *   conectores mandam valor absoluto).
 * - Moeda diferente da conta: usa `amountInAccountCurrency` quando existir; senão a movimentação é recusada.
 */
export function normalizeTransaction(raw: unknown, account: Pick<PluggyAccountDTO, 'id' | 'type' | 'currency'>): PluggyTransactionDTO | null {
  const p = TransactionSchema.safeParse(raw);
  if (!p.success || !/^[\w-]{1,100}$/.test(p.data.id)) return null;
  const t = p.data;
  const sameCurrency = !t.currencyCode || t.currencyCode.toUpperCase() === account.currency;
  const value = sameCurrency ? t.amount : t.amountInAccountCurrency;
  let cents = toCents(value);
  if (cents === null || cents === 0) return null;
  if (account.type === 'credit_card') cents = -cents;
  else if (t.type === 'DEBIT' && cents > 0) cents = -cents;
  else if (t.type === 'CREDIT' && cents < 0) cents = -cents;
  const postedDate = toCivilDate(t.date);
  if (!postedDate) return null;
  const purchase = toCivilDate(t.creditCardMetadata?.purchaseDate);
  const idx = t.creditCardMetadata?.installmentNumber, cnt = t.creditCardMetadata?.totalInstallments;
  const installment = Number.isInteger(idx) && Number.isInteger(cnt) && (idx as number) >= 1 && (cnt as number) >= 2 && (cnt as number) <= 999 && (idx as number) <= (cnt as number) ? { index: idx as number, count: cnt as number } : undefined;
  return {
    id: t.id,
    accountId: account.id,
    postedDate,
    operationDate: purchase && purchase !== postedDate ? purchase : undefined,
    description: clean(t.description || t.descriptionRaw, 200) || '(sem descrição)',
    amountCents: cents,
    status: t.status === 'PENDING' ? 'pending' : 'posted',
    category: t.category ? clean(t.category, 60) : undefined,
    type: clean(t.operationType || t.type, 40) || undefined,
    installment,
  };
}

export type PluggyConsentStatus = 'active' | 'awaiting' | 'expired' | 'revoked' | 'error';
export interface PluggyItemDTO {
  itemId: string;
  connectorName: string;
  /** Status bruto da Pluggy (UPDATED, UPDATING, OUTDATED, LOGIN_ERROR, WAITING_USER_INPUT…). */
  status: string;
  consentStatus: PluggyConsentStatus;
  consentExpiresAt?: string;
  lastUpdatedAt?: string;
  nextAutoSyncAt?: string;
  /** Explicação para o usuário (sem dados sensíveis). */
  message?: string;
}

const isoOrUndef = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);

export function normalizeItem(raw: unknown, itemId: string, now: number): PluggyItemDTO {
  const p = ItemSchema.safeParse(raw);
  if (!p.success) return { itemId, connectorName: 'Meu Pluggy', status: 'UNKNOWN', consentStatus: 'error', message: 'Resposta inesperada da Pluggy para este item.' };
  const it = p.data;
  const codes = `${it.executionStatus ?? ''} ${it.error?.code ?? ''}`;
  const exp = isoOrUndef(it.consentExpiresAt);
  const base = { itemId, connectorName: clean(it.connector?.name, 80) || 'Meu Pluggy', status: clean(it.status, 40), consentExpiresAt: exp, lastUpdatedAt: isoOrUndef(it.lastUpdatedAt), nextAutoSyncAt: isoOrUndef(it.nextAutoSyncAt) };
  if (/USER_AUTHORIZATION_EXPIRED/.test(codes) || (exp && Date.parse(exp) <= now)) return { ...base, consentStatus: 'expired', message: 'Autorização expirada: renove em meu.pluggy.ai (o itemId pode mudar; atualize PLUGGY_ITEM_IDS).' };
  if (/USER_AUTHORIZATION_REVOKED|USER_AUTHORIZATION_NOT_GRANTED/.test(codes)) return { ...base, consentStatus: 'revoked', message: 'Autorização revogada ou não concedida no Meu Pluggy.' };
  if (it.status === 'WAITING_USER_INPUT' || it.status === 'WAITING_USER_ACTION' || /USER_AUTHORIZATION_PENDING/.test(codes)) return { ...base, consentStatus: 'awaiting', message: 'Aguardando você concluir a autorização no Meu Pluggy.' };
  if (it.status === 'LOGIN_ERROR') return { ...base, consentStatus: 'error', message: 'A conexão precisa ser refeita no Meu Pluggy.' };
  if (it.status === 'OUTDATED') return { ...base, consentStatus: 'active', message: 'A última atualização automática falhou; os dados disponíveis podem estar desatualizados.' };
  return { ...base, consentStatus: 'active' };
}

/* ------------------------------------------------------------------ cliente HTTP */

export class PluggyClient {
  private apiKey: { value: string; expiresAt: number } | null = null;
  private authInFlight: Promise<string> | null = null;
  private hits: number[] = [];
  private accountsCache = new Map<string, { at: number; list: PluggyAccountDTO[] }>();
  private readonly fetchImpl: PluggyFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly limits: typeof PLUGGY_LIMITS;

  constructor(private config: PluggyConfig, deps: PluggyClientDeps = {}) {
    this.fetchImpl = deps.fetch ?? defaultFetch;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limits = { ...PLUGGY_LIMITS, ...deps.limits };
  }

  get itemIds(): string[] { return [...this.config.itemIds]; }
  isConfiguredItem(itemId: unknown): itemId is string { return typeof itemId === 'string' && this.config.itemIds.includes(itemId.toLowerCase()); }

  private today(): string { return toCivilDate(new Date(this.now()).toISOString()) ?? new Date(this.now()).toISOString().slice(0, 10); }

  private takeQuota() {
    const t = this.now();
    while (this.hits.length && t - this.hits[0] >= 60_000) this.hits.shift();
    if (this.hits.length >= this.limits.outboundPerMinute) throw new PluggyError('rate_limited', 'Limite local de chamadas à Pluggy por minuto atingido. Aguarde um pouco.', Math.max(1, Math.ceil((60_000 - (t - this.hits[0])) / 1000)));
    this.hits.push(t);
  }

  /** Única saída de rede. `path` é sempre montado aqui; a origem é conferida antes de cada chamada. */
  private async raw(method: 'GET' | 'POST', path: string, query: Record<string, string> | null, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<{ status: number; text: string; retryAfter?: number }> {
    const url = new URL(path, PLUGGY_BASE);
    if (url.origin !== PLUGGY_ORIGIN || url.username || url.password) throw new PluggyError('invalid', 'Destino não permitido.');
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    this.takeQuota();
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.limits.timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url.href, { method, headers: { accept: 'application/json', ...headers }, body, signal: ctrl.signal, redirect: 'error' });
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > this.limits.maxResponseBytes) throw new PluggyError('too_large', 'Resposta da Pluggy grande demais.');
      const text = await res.text();
      if (text.length > this.limits.maxResponseBytes) throw new PluggyError('too_large', 'Resposta da Pluggy grande demais.');
      const ra = Number(res.headers.get('retry-after'));
      return { status: res.status, text, retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : undefined };
    } catch (e) {
      if (e instanceof PluggyError) throw e;
      if (signal?.aborted) throw new PluggyError('cancelled', 'Pedido cancelado.');
      if (timedOut) throw new PluggyError('unavailable', 'Tempo esgotado aguardando a Pluggy.');
      throw new PluggyError('unavailable', 'Não foi possível contatar a Pluggy (rede indisponível?).');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * API Key em memória; uma única autenticação em andamento por vez, compartilhada por quem chegar. Ela não usa o
   * sinal de nenhum chamador (tem tempo máximo próprio); cada chamador pode desistir de esperar pelo seu sinal.
   */
  private key(signal?: AbortSignal): Promise<string> {
    if (this.apiKey && this.apiKey.expiresAt > this.now()) return Promise.resolve(this.apiKey.value);
    if (!this.authInFlight) this.authInFlight = this.authenticate().finally(() => { this.authInFlight = null; });
    return abortable(this.authInFlight, signal);
  }

  private async authenticate(): Promise<string> {
    const r = await this.raw('POST', '/auth', null, { 'content-type': 'application/json' }, JSON.stringify({ clientId: this.config.clientId, clientSecret: this.config.clientSecret }));
    if (r.status === 401 || r.status === 403) throw new PluggyError('auth_failed', 'A Pluggy recusou PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET. Confira o .env (sem colar segredos no chat).', undefined, upstreamCode(r.text));
    if (r.status === 429) throw new PluggyError('rate_limited', 'A Pluggy pediu para aguardar (limite de requisições).', r.retryAfter ?? 60);
    if (r.status >= 500) throw new PluggyError('unavailable', 'Pluggy indisponível no momento.');
    if (r.status !== 200) throw new PluggyError('bad_response', `Autenticação na Pluggy falhou (HTTP ${r.status}).`, undefined, upstreamCode(r.text));
    let apiKey: unknown;
    try { apiKey = (JSON.parse(r.text) as { apiKey?: unknown }).apiKey; } catch { /* abaixo */ }
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 4096) throw new PluggyError('bad_response', 'Resposta de autenticação da Pluggy fora do formato.');
    this.apiKey = { value: apiKey, expiresAt: this.now() + this.limits.apiKeyTtlMs };
    return apiKey;
  }

  /** GET autenticado com renovação após 401 e uma nova tentativa para falhas transitórias. */
  private async get(path: string, query: Record<string, string> | null, signal?: AbortSignal): Promise<unknown> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const k = await this.key(signal);
      let r: { status: number; text: string; retryAfter?: number };
      try {
        r = await this.raw('GET', path, query, { 'x-api-key': k }, undefined, signal);
      } catch (e) {
        if (e instanceof PluggyError && e.code === 'unavailable' && attempt === 0) { await this.sleep(400); continue; }
        throw e;
      }
      if (r.status === 200) {
        try { return JSON.parse(r.text); } catch { throw new PluggyError('bad_response', 'Resposta da Pluggy não é JSON.'); }
      }
      const up = upstreamCode(r.text);
      if (r.status === 401 && !renewed) { renewed = true; this.apiKey = null; continue; }
      if (r.status === 401) throw new PluggyError('auth_failed', 'A Pluggy recusou a chave de acesso mesmo após renovar. Confira as credenciais no .env.', undefined, up);
      if (r.status === 403) throw new PluggyError('forbidden', 'A Pluggy negou acesso a este recurso para a sua aplicação.', undefined, up);
      if (r.status === 404) throw new PluggyError('not_found', 'Item ou conta não encontrado na Pluggy (a autorização pode ter sido renovada com outro itemId).', undefined, up);
      if (r.status === 410) throw new PluggyError('deprecated', 'A Pluggy encerrou este endpoint (HTTP 410).', undefined, up);
      if (r.status === 429) throw new PluggyError('rate_limited', 'A Pluggy pediu para aguardar (limite de requisições).', r.retryAfter ?? 60, up);
      if (r.status === 400) throw new PluggyError('invalid', 'A Pluggy recusou os parâmetros do pedido.', undefined, up);
      if (r.status >= 500 && attempt === 0) { await this.sleep(400); continue; }
      if (r.status >= 500) throw new PluggyError('unavailable', 'Pluggy indisponível no momento.', r.retryAfter, up);
      throw new PluggyError('bad_response', `Resposta inesperada da Pluggy (HTTP ${r.status}).`, undefined, up);
    }
  }

  async item(itemId: string, signal?: AbortSignal): Promise<PluggyItemDTO> {
    if (!this.isConfiguredItem(itemId)) throw new PluggyError('not_found', 'Item não configurado em PLUGGY_ITEM_IDS.');
    const raw = await this.get(`/items/${encodeURIComponent(itemId.toLowerCase())}`, null, signal);
    return normalizeItem(raw, itemId.toLowerCase(), this.now());
  }

  /** Estado de todos os itens configurados (falha de um item não derruba os outros). */
  async status(signal?: AbortSignal): Promise<PluggyItemDTO[]> {
    const out: PluggyItemDTO[] = [];
    for (const id of this.config.itemIds) {
      try {
        out.push(await this.item(id, signal));
      } catch (e) {
        // Problemas por item (sumiu, acesso negado, resposta estranha) ficam no item; os gerais derrubam o pedido.
        if (!(e instanceof PluggyError) || !(e.code === 'not_found' || e.code === 'forbidden' || e.code === 'bad_response')) throw e;
        out.push({ itemId: id, connectorName: 'Meu Pluggy', status: 'UNAVAILABLE', consentStatus: e.code === 'not_found' ? 'expired' : 'error', message: e.message });
      }
    }
    return out;
  }

  async accounts(itemId: string, signal?: AbortSignal): Promise<PluggyAccountDTO[]> {
    if (!this.isConfiguredItem(itemId)) throw new PluggyError('not_found', 'Item não configurado em PLUGGY_ITEM_IDS.');
    const id = itemId.toLowerCase();
    const cached = this.accountsCache.get(id);
    if (cached && this.now() - cached.at < this.limits.accountsCacheMs) return cached.list;
    const list: PluggyAccountDTO[] = [];
    const today = this.today();
    for (let page = 1; page <= 20; page++) {
      const raw = await this.get('/accounts', { itemId: id, page: String(page), pageSize: '500' }, signal);
      const p = AccountsPageSchema.safeParse(raw);
      if (!p.success) throw new PluggyError('bad_response', 'Lista de contas da Pluggy fora do formato.');
      for (const r of p.data.results) { const a = normalizeAccount(r, id, 'Meu Pluggy', today); if (a) list.push(a); }
      if (!p.data.totalPages || page >= p.data.totalPages) break;
    }
    this.accountsCache.set(id, { at: this.now(), list });
    return list;
  }

  /** Movimentações de uma conta do item, por cursor, com teto de páginas e registros. */
  async transactions(itemId: string, accountId: string, range: { from: string; to: string }, signal?: AbortSignal): Promise<{ transactions: PluggyTransactionDTO[]; invalid: number; pages: number }> {
    if (!isUuid(accountId)) throw new PluggyError('invalid', 'Conta inválida.');
    if (!toCivilDate(range.from) || !toCivilDate(range.to) || !DATE_RE.test(range.from) || !DATE_RE.test(range.to) || range.from > range.to) throw new PluggyError('invalid', 'Intervalo de datas inválido.');
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
    if (days > this.limits.maxRangeDays) throw new PluggyError('invalid', `Intervalo maior que ${this.limits.maxRangeDays} dias.`);
    const account = (await this.accounts(itemId, signal)).find((a) => a.id === accountId.toLowerCase());
    if (!account) throw new PluggyError('not_found', 'Conta não pertence a este item.');
    const out: PluggyTransactionDTO[] = [];
    let invalid = 0;
    let after: string | null = null;
    let pages = 0;
    const seenCursors = new Set<string>();
    do {
      if (pages >= this.limits.maxPages) throw new PluggyError('too_large', `Mais de ${this.limits.maxPages} páginas de movimentações; reduza o intervalo de datas.`);
      const query: Record<string, string> = { accountId: account.id, dateFrom: range.from, dateTo: range.to };
      if (after) query.after = after;
      const raw = await this.get('/v2/transactions', query, signal);
      pages++;
      const p = TransactionsPageSchema.safeParse(raw);
      if (!p.success) throw new PluggyError('bad_response', 'Página de movimentações da Pluggy fora do formato.');
      for (const r of p.data.results) {
        const t = normalizeTransaction(r, account);
        if (t) out.push(t); else invalid++;
      }
      if (out.length > this.limits.maxTransactions) throw new PluggyError('too_large', `Mais de ${this.limits.maxTransactions} movimentações; reduza o intervalo de datas.`);
      after = nextCursor(p.data.next);
      if (after) {
        if (seenCursors.has(after)) throw new PluggyError('bad_response', 'A Pluggy repetiu o cursor de paginação.');
        seenCursors.add(after);
      }
    } while (after);
    return { transactions: out, invalid, pages };
  }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new PluggyError('cancelled', 'Pedido cancelado.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PluggyError('cancelled', 'Pedido cancelado.'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * Extrai o cursor de `next`. A API devolve uma query string relativa (`?accountId=…&after=…`); qualquer coisa
 * com esquema, host ou caminho próprio é recusada — nunca seguimos um destino informado pela resposta.
 */
export function nextCursor(next: string | null | undefined): string | null {
  if (!next) return null;
  const s = next.trim();
  if (!s.startsWith('?') || /[\s#]/.test(s)) throw new PluggyError('bad_response', 'Cursor de paginação da Pluggy fora do formato.');
  const after = new URLSearchParams(s.slice(1)).get('after');
  if (!after) return null;
  if (after.length > 1024 || !/^[\w\-.~=+/:%]+$/.test(after)) throw new PluggyError('bad_response', 'Cursor de paginação da Pluggy fora do formato.');
  return after;
}
