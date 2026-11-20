/**
 * Meu Pluggy (uso pessoal) no NAVEGADOR — issue #9. Fala só com o servidor local (`/api/pluggy/*`), que
 * guarda as credenciais e conversa com a Pluggy. Aqui não existe client secret, API Key nem URL da Pluggy.
 *
 * Mapeamento para o contrato `BankDataProvider` (somente leitura):
 * - “instituição” = item configurado em PLUGGY_ITEM_IDS (o conector MeuPluggy pode agregar vários bancos);
 * - `consentRef` = itemId (identificador opaco, não é segredo);
 * - o consentimento é dado pelo titular no portal meu.pluggy.ai, nunca aqui: `startConsent` só registra
 *   localmente um item que já existe; `refresh` não força atualização (o Meu Pluggy sincroniza ~a cada 24 h);
 *   revogar é feito no portal (o Aurora não chama nenhuma operação de escrita na Pluggy).
 */
import { LOCAL_API_ENABLED } from '../../config/runtime';
import { apiFetch } from '../../integrations/apiFetch';
import type { ConsentStatus } from '../model';
import { ProviderError, type BankDataProvider, type ConsentStart, type ProviderAccount, type ProviderInstitution, type ProviderTransaction } from './types';

export const PLUGGY_PROVIDER_ID = 'pluggy-personal';
export const MEU_PLUGGY_URL = 'https://meu.pluggy.ai/';
export const PLUGGY_DASHBOARD_URL = 'https://dashboard.pluggy.ai/';

export interface PluggyItemStatus {
  itemId: string;
  connectorName: string;
  status: string;
  consentStatus: ConsentStatus;
  consentExpiresAt?: string;
  lastUpdatedAt?: string;
  nextAutoSyncAt?: string;
  message?: string;
}

export type PluggyStatus =
  | { configured: false; problems: string[] }
  | { configured: true; items: PluggyItemStatus[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const optIso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v.slice(0, 40) : undefined);
const STATUSES: ConsentStatus[] = ['awaiting', 'active', 'expired', 'revoked', 'error'];

/** Erro HTTP do servidor local → erro do contrato (mensagens do servidor já vêm sem segredos). */
function toProviderError(status: number, body: { error?: unknown; code?: unknown } | null, retryAfter: string | null): ProviderError {
  const code = typeof body?.code === 'string' ? body.code : '';
  const msg = str(body?.error, 300) || `Erro ${status} no servidor local.`;
  if (code === 'not_configured') return new ProviderError('unavailable', msg);
  if (code === 'local_only' || code === 'pairing_required') return new ProviderError('invalid', msg);
  if (code === 'not_found' || status === 404) return new ProviderError('not_found', msg);
  if (status === 429) return new ProviderError('temporary', retryAfter ? `${msg} Tente de novo em ${retryAfter} s.` : msg);
  if (code === 'auth_failed' || code === 'forbidden' || code === 'deprecated') return new ProviderError('unavailable', msg);
  if (status >= 500) return new ProviderError('temporary', msg);
  return new ProviderError('invalid', msg);
}

async function getJSON(path: string): Promise<unknown> {
  if (!LOCAL_API_ENABLED) throw new ProviderError('unavailable', 'O Meu Pluggy depende do servidor local e não está disponível nesta versão pública.');
  let res: Response;
  try {
    res = await apiFetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ProviderError('temporary', 'Servidor local do Aurora indisponível (ele roda junto com `npm run dev`).');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* corpo não JSON */ }
  if (!res.ok) throw toProviderError(res.status, body as { error?: unknown; code?: unknown } | null, res.headers.get('retry-after'));
  return body;
}

export async function fetchPluggyStatus(): Promise<PluggyStatus> {
  const b = (await getJSON('/api/pluggy/status')) as { configured?: unknown; problems?: unknown; items?: unknown } | null;
  if (!b || b.configured !== true) {
    const problems = Array.isArray(b?.problems) ? b.problems.map((p) => str(p, 300)).filter(Boolean).slice(0, 10) : [];
    return { configured: false, problems: problems.length ? problems : ['Meu Pluggy não configurado no servidor local.'] };
  }
  const items: PluggyItemStatus[] = (Array.isArray(b.items) ? b.items : []).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.itemId !== 'string' || !UUID_RE.test(o.itemId)) return [];
    const cs = STATUSES.includes(o.consentStatus as ConsentStatus) ? (o.consentStatus as ConsentStatus) : 'error';
    return [{ itemId: o.itemId, connectorName: str(o.connectorName, 80) || 'Meu Pluggy', status: str(o.status, 40), consentStatus: cs, consentExpiresAt: optIso(o.consentExpiresAt), lastUpdatedAt: optIso(o.lastUpdatedAt), nextAutoSyncAt: optIso(o.nextAutoSyncAt), message: str(o.message, 300) || undefined }];
  });
  return { configured: true, items };
}

const ACCOUNT_TYPES = new Set(['checking', 'savings', 'credit_card', 'other']);
const CURRENCIES = new Set(['BRL', 'USD', 'EUR']);
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);

export class PluggyPersonalProvider implements BankDataProvider {
  readonly id = PLUGGY_PROVIDER_ID;
  readonly name = 'Meu Pluggy';
  readonly environment = 'production' as const;
  readonly readOnly = true as const;
  private statusCache: { at: number; value: PluggyStatus } | null = null;

  /** Estado dos itens (cache curto para não repetir chamadas numa mesma sincronização). */
  async status(maxAgeMs = 30_000): Promise<PluggyStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < maxAgeMs) return this.statusCache.value;
    const value = await fetchPluggyStatus();
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  private async item(itemId: string): Promise<PluggyItemStatus> {
    const st = await this.status();
    if (!st.configured) throw new ProviderError('unavailable', st.problems[0]);
    const it = st.items.find((i) => i.itemId === itemId.toLowerCase());
    if (!it) throw new ProviderError('consent_expired', 'Este item não está mais em PLUGGY_ITEM_IDS (renovado com outro itemId?). Atualize o .env e adicione o item novo.');
    return it;
  }

  /** Antes de ler: com autorização expirada a Pluggy devolve listas VAZIAS, não erro — então conferimos. */
  private async gate(itemId: string): Promise<void> {
    const it = await this.item(itemId);
    if (it.consentStatus === 'expired') throw new ProviderError('consent_expired', it.message ?? 'Autorização expirada no Meu Pluggy.');
    if (it.consentStatus === 'revoked') throw new ProviderError('consent_revoked', it.message ?? 'Autorização revogada no Meu Pluggy.');
    if (it.consentStatus === 'awaiting') throw new ProviderError('invalid', it.message ?? 'Autorização pendente no Meu Pluggy.');
  }

  async listInstitutions(): Promise<ProviderInstitution[]> {
    const st = await this.status(0);
    return st.configured ? st.items.map((i) => ({ id: i.itemId, name: i.connectorName })) : [];
  }

  async startConsent(itemId: string): Promise<ConsentStart> {
    await this.item(itemId);
    return { consentRef: itemId.toLowerCase(), status: 'awaiting' };
  }

  async getConsentStatus(consentRef: string) {
    this.statusCache = null;
    try {
      const it = await this.item(consentRef);
      return { status: it.consentStatus, expiresAt: it.consentExpiresAt ? Date.parse(it.consentExpiresAt) : undefined, institutionId: it.itemId };
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'consent_expired') return { status: 'expired' as ConsentStatus };
      throw e;
    }
  }

  async listAccounts(consentRef: string): Promise<ProviderAccount[]> {
    this.statusCache = null;
    await this.gate(consentRef);
    const b = (await getJSON(`/api/pluggy/accounts?itemId=${encodeURIComponent(consentRef)}`)) as { accounts?: unknown } | null;
    return (Array.isArray(b?.accounts) ? b.accounts : []).flatMap((r): ProviderAccount[] => {
      const o = (r ?? {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || !UUID_RE.test(o.id) || !ACCOUNT_TYPES.has(o.type as string) || !CURRENCIES.has(o.currency as string)) return [];
      const bal = (o.balance ?? null) as { cents?: unknown; asOf?: unknown } | null;
      const card = (o.card ?? null) as Record<string, unknown> | null;
      return [{
        id: o.id,
        institutionId: consentRef,
        name: str(o.name, 80) || 'Conta',
        type: o.type as ProviderAccount['type'],
        currency: o.currency as ProviderAccount['currency'],
        number: str(o.numberTail, 4) || undefined,
        institutionName: str(o.institutionName, 80) || undefined,
        balance: bal && typeof bal.cents === 'number' && Number.isSafeInteger(bal.cents) && typeof bal.asOf === 'string' ? { cents: bal.cents, asOf: bal.asOf.slice(0, 25) } : undefined,
        card: o.type === 'credit_card' && card ? { limitCents: int(card.limitCents, 0, 1e15), availableLimitCents: int(card.availableLimitCents, 0, 1e15), closingDay: int(card.closingDay, 1, 31), dueDay: int(card.dueDay, 1, 31) } : undefined,
      }];
    });
  }

  async getBalances(consentRef: string) {
    const out: Record<string, { cents: number; asOf: string }> = {};
    for (const a of await this.listAccounts(consentRef)) if (a.balance) out[a.id] = a.balance;
    return out;
  }

  async listTransactions(consentRef: string, accountId: string, range: { from: string; to: string }): Promise<ProviderTransaction[]> {
    const q = new URLSearchParams({ itemId: consentRef, accountId, from: range.from, to: range.to });
    const b = (await getJSON(`/api/pluggy/transactions?${q}`)) as { transactions?: unknown } | null;
    // Validação final (data, valor, sinal) acontece em sync.ts, igual à dos arquivos.
    return (Array.isArray(b?.transactions) ? b.transactions : []).flatMap((r): ProviderTransaction[] => {
      const o = (r ?? {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.postedDate !== 'string' || typeof o.amountCents !== 'number') return [];
      const inst = (o.installment ?? null) as { index?: unknown; count?: unknown } | null;
      const index = int(inst?.index, 1, 999), count = int(inst?.count, 2, 999);
      return [{
        id: o.id.slice(0, 120), accountId, postedDate: o.postedDate.slice(0, 10), operationDate: typeof o.operationDate === 'string' ? o.operationDate.slice(0, 10) : undefined,
        description: str(o.description, 300), amountCents: o.amountCents, status: o.status === 'pending' ? 'pending' : 'posted',
        category: str(o.category, 60) || undefined, type: str(o.type, 40) || undefined,
        installment: index && count && index <= count ? { index, count } : undefined,
      }];
    });
  }

  /** O Meu Pluggy não permite atualização forçada: lemos o que já está disponível. */
  async refresh(): Promise<void> { /* intencionalmente vazio */ }

  async revokeConsent(): Promise<void> {
    throw new ProviderError('invalid', 'A autorização do Meu Pluggy é gerenciada em meu.pluggy.ai. Aqui você pode apenas esquecer a conexão local.');
  }
}

let instance: PluggyPersonalProvider | null = null;
export function pluggyProvider(): PluggyPersonalProvider {
  if (!instance) instance = new PluggyPersonalProvider();
  return instance;
}
