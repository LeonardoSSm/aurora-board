/**
 * Contrato de provedores de dados bancários (Open Finance / agregadores) — SOMENTE LEITURA.
 *
 * Fluxo: Provider → normalização (sync.ts) → planejador de importação/deduplicação → razão → consultas → canvas.
 * Widgets e relatórios nunca conhecem o provedor. Não existe operação de pagamento, Pix, transferência ou
 * qualquer escrita na instituição: o contrato simplesmente não as oferece.
 *
 * Segredos (client secret, API key, tokens de acesso) NUNCA passam por este contrato no navegador: um provedor
 * real roda atrás de um backend que guarda as credenciais; o frontend só vê identificadores opacos
 * (`consentRef`) e dados já autorizados pelo titular.
 */
import type { Currency } from '../../core/finance';
import type { AccountType, CardInfo, ConsentStatus, ProviderEnvironment } from '../model';

export type ConnectionState =
  | 'not_connected'
  | 'awaiting_consent'
  | 'connected'
  | 'syncing'
  | 'up_to_date'
  | 'consent_expired'
  | 'consent_revoked'
  | 'temporary_failure'
  | 'provider_unavailable';

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  not_connected: 'Não conectado',
  awaiting_consent: 'Aguardando consentimento',
  connected: 'Conectado',
  syncing: 'Sincronizando…',
  up_to_date: 'Atualizado',
  consent_expired: 'Consentimento expirado',
  consent_revoked: 'Consentimento revogado',
  temporary_failure: 'Falha temporária',
  provider_unavailable: 'Provedor indisponível',
};

export interface ProviderInstitution { id: string; name: string; code?: string }

export interface ProviderAccount {
  id: string;
  institutionId: string;
  name: string;
  type: AccountType;
  currency: Currency;
  /** Número como o provedor informa; a sincronização guarda só a forma mascarada. */
  number?: string;
  balance?: { cents: number; asOf: string; availableCents?: number };
  card?: CardInfo;
}

export interface ProviderTransaction {
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

export interface ConsentStart {
  consentRef: string;
  status: 'awaiting';
  /** Provedor real: URL da jornada de consentimento na instituição (aberta pelo usuário). */
  redirectUrl?: string;
  expiresAt?: number;
}

export type ProviderErrorCode = 'consent_expired' | 'consent_revoked' | 'temporary' | 'unavailable' | 'not_found' | 'invalid';

export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface BankDataProvider {
  readonly id: string;
  readonly name: string;
  readonly environment: ProviderEnvironment;
  readonly readOnly: true;
  listInstitutions(): Promise<ProviderInstitution[]>;
  startConsent(institutionId: string, scopes: string[]): Promise<ConsentStart>;
  getConsentStatus(consentRef: string): Promise<{ status: ConsentStatus; expiresAt?: number; institutionId?: string }>;
  listAccounts(consentRef: string): Promise<ProviderAccount[]>;
  getBalances(consentRef: string): Promise<Record<string, { cents: number; asOf: string; availableCents?: number }>>;
  listTransactions(consentRef: string, accountId: string, range: { from: string; to: string }): Promise<ProviderTransaction[]>;
  /** Pede ao provedor dados mais recentes (pode ser assíncrono no provedor real). */
  refresh(consentRef: string): Promise<void>;
  /** Revoga na origem. Não apaga dados locais (operação separada). */
  revokeConsent(consentRef: string): Promise<void>;
}

/** Escopos de leitura usados (nomes do Open Finance Brasil, fase 2). Nenhum escopo de pagamento existe aqui. */
export const READ_SCOPES = ['accounts', 'balances', 'transactions', 'credit-cards-accounts'];
