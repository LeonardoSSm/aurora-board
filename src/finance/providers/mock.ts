/**
 * Provedor FICTÍCIO (ambiente de testes). Implementa o mesmo contrato dos provedores futuros, com dados
 * inventados: duas instituições, duas contas correntes, um cartão, transações, saldos, consentimento simulado,
 * expiração, revogação, atualização, falhas, entrega duplicada e transação pendente que é liquidada.
 *
 * Nada aqui acessa a rede ou uma instituição real. A interface mostra “DADOS FICTÍCIOS — AMBIENTE DE TESTES”.
 * O estado do consentimento vive só na memória da aba: depois de recarregar, o consentimento fictício aparece
 * como expirado (é preciso “reconectar”), o que também exercita esse caminho.
 */
import type { ConsentStatus } from '../model';
import { ProviderError, type BankDataProvider, type ConsentStart, type ProviderAccount, type ProviderErrorCode, type ProviderInstitution, type ProviderTransaction } from './types';

interface MockConsent { status: ConsentStatus; institutionId: string; expiresAt: number; settled: boolean }

const INSTITUTIONS: ProviderInstitution[] = [
  { id: 'alfa', name: 'Banco Fictício Alfa', code: '901' },
  { id: 'beta', name: 'Banco Fictício Beta', code: '902' },
];

function shiftMonth(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const day = (period: string, d: number) => `${period}-${String(d).padStart(2, '0')}`;

export class MockBankProvider implements BankDataProvider {
  readonly id = 'mock';
  readonly name = 'Provedor fictício (testes)';
  readonly environment = 'mock' as const;
  readonly readOnly = true as const;
  private consents = new Map<string, MockConsent>();
  private failures: ProviderErrorCode[] = [];
  private seq = 0;

  /** `today` (AAAA-MM-DD) fixa as datas geradas (testes reproduzíveis). */
  constructor(private today: string = new Date().toISOString().slice(0, 10), private consentDays = 90) {}

  /* ---------- controles do ambiente de testes (não existem num provedor real) ---------- */
  approve(consentRef: string) { const c = this.mustGet(consentRef); if (c.status === 'awaiting') c.status = 'active'; }
  expire(consentRef: string) { const c = this.mustGet(consentRef); if (c.status === 'active') c.status = 'expired'; }
  /** A próxima chamada de dados falha com este código (falha temporária, provedor fora do ar…). */
  failNext(code: ProviderErrorCode) { this.failures.push(code); }

  private mustGet(ref: string): MockConsent {
    const c = this.consents.get(ref);
    if (!c) throw new ProviderError('not_found', 'Consentimento fictício não encontrado (a sessão de testes foi encerrada).');
    return c;
  }
  private async gate(ref: string): Promise<MockConsent> {
    await Promise.resolve();
    const f = this.failures.shift();
    if (f === 'temporary') throw new ProviderError('temporary', 'Falha temporária simulada. Tente novamente.');
    if (f === 'unavailable') throw new ProviderError('unavailable', 'Provedor fictício indisponível (simulado).');
    const c = this.consents.get(ref);
    if (!c) throw new ProviderError('consent_expired', 'Consentimento fictício expirado: a sessão de testes foi encerrada. Reconecte.');
    if (c.status === 'active' && Date.parse(this.today) > c.expiresAt) c.status = 'expired';
    if (c.status === 'revoked') throw new ProviderError('consent_revoked', 'Consentimento revogado.');
    if (c.status === 'expired') throw new ProviderError('consent_expired', 'Consentimento expirado. Reconecte para renovar.');
    if (c.status !== 'active') throw new ProviderError('invalid', 'Consentimento ainda não aprovado.');
    return c;
  }

  async listInstitutions() { return INSTITUTIONS.map((i) => ({ ...i })); }

  async startConsent(institutionId: string): Promise<ConsentStart> {
    if (!INSTITUTIONS.some((i) => i.id === institutionId)) throw new ProviderError('not_found', 'Instituição fictícia desconhecida.');
    const consentRef = `mock_consent_${++this.seq}_${institutionId}`;
    const expiresAt = Date.parse(this.today) + this.consentDays * 86_400_000;
    this.consents.set(consentRef, { status: 'awaiting', institutionId, expiresAt, settled: false });
    return { consentRef, status: 'awaiting', expiresAt };
  }

  async getConsentStatus(consentRef: string) {
    const c = this.consents.get(consentRef);
    if (!c) return { status: 'expired' as ConsentStatus };
    return { status: c.status, expiresAt: c.expiresAt, institutionId: c.institutionId };
  }

  async listAccounts(consentRef: string): Promise<ProviderAccount[]> {
    const c = await this.gate(consentRef);
    const bal = await this.balancesFor(c);
    return this.accountsOf(c.institutionId).map((a) => ({ ...a, balance: bal[a.id] }));
  }

  private accountsOf(inst: string): ProviderAccount[] {
    if (inst === 'alfa') return [{ id: 'alfa-cc', institutionId: 'alfa', name: 'Conta corrente Alfa', type: 'checking', currency: 'BRL', number: '00012345-6' }];
    return [
      { id: 'beta-cc', institutionId: 'beta', name: 'Conta digital Beta', type: 'checking', currency: 'BRL', number: '99887766-5' },
      { id: 'beta-card', institutionId: 'beta', name: 'Cartão Beta', type: 'credit_card', currency: 'BRL', number: '5555666677778888', card: { limitCents: 800000, availableLimitCents: 650000, closingDay: 25, dueDay: 5 } },
    ];
  }

  private async balancesFor(c: MockConsent) {
    const out: Record<string, { cents: number; asOf: string; availableCents?: number }> = {};
    for (const a of this.accountsOf(c.institutionId)) {
      const sum = this.generate(a.id, c.settled).filter((t) => t.status === 'posted').reduce((n, t) => n + t.amountCents, 0);
      // Saldo fictício coerente com as movimentações (âncora inicial inventada para as contas correntes).
      const opening = a.type === 'credit_card' ? 0 : a.id === 'alfa-cc' ? 500000 : 100000;
      out[a.id] = { cents: opening + sum, asOf: this.today };
    }
    return out;
  }

  async getBalances(consentRef: string) {
    return this.balancesFor(await this.gate(consentRef));
  }

  async listTransactions(consentRef: string, accountId: string, range: { from: string; to: string }): Promise<ProviderTransaction[]> {
    const c = await this.gate(consentRef);
    if (!this.accountsOf(c.institutionId).some((a) => a.id === accountId)) throw new ProviderError('not_found', 'Conta fictícia fora deste consentimento.');
    const list = this.generate(accountId, c.settled).filter((t) => t.postedDate >= range.from && t.postedDate <= range.to);
    // Entrega duplicada simulada (mesmo id duas vezes), como acontece em paginação real.
    const dup = list.find((t) => t.description.includes('NETFLIX'));
    return dup ? [...list, { ...dup }] : list;
  }

  async refresh(consentRef: string) {
    const c = await this.gate(consentRef);
    c.settled = true; // a compra pendente foi liquidada na “instituição”
  }

  async revokeConsent(consentRef: string) {
    const c = this.consents.get(consentRef);
    if (c) c.status = 'revoked';
  }

  /** Movimentações fictícias dos últimos 3 meses até `today`. */
  generate(accountId: string, settled: boolean): ProviderTransaction[] {
    const cur = this.today.slice(0, 7);
    const months = [shiftMonth(cur, -2), shiftMonth(cur, -1), cur];
    const out: ProviderTransaction[] = [];
    const add = (p: string, d: number, id: string, description: string, amountCents: number, extra: Partial<ProviderTransaction> = {}) => {
      const date = day(p, d);
      if (date > this.today) return;
      out.push({ id: `${id}-${p}`, accountId, postedDate: date, description, amountCents, status: 'posted', ...extra });
    };
    months.forEach((p, i) => {
      if (accountId === 'alfa-cc') {
        add(p, 5, 'sal', 'SALARIO EMPRESA FICTICIA LTDA', 500000, { category: 'Salário' });
        add(p, 10, 'alug', 'ALUGUEL APTO FICTICIO', -180000);
        add(p, 12, 'ted', 'TED ENVIADA BANCO BETA MESMA TITULARIDADE', -100000);
        add(p, 15, 'tar', 'TARIFA PACOTE SERVICOS', -2990);
        if (i > 0) add(p, 20, 'fat', 'PAGAMENTO FATURA CARTAO BETA', -42970);
      } else if (accountId === 'beta-cc') {
        add(p, 12, 'tedr', 'TED RECEBIDA BANCO ALFA MESMA TITULARIDADE', 100000);
        add(p, 14, 'merc', 'SUPERMERCADO FICTICIO', -35000);
        add(p, 16, 'uber', 'UBER *VIAGEM', -4250);
      } else if (accountId === 'beta-card') {
        add(p, 3, 'ifood', 'IFOOD *PEDIDO', -8990);
        add(p, 8, 'nflx', 'NETFLIX.COM', -3990);
        add(p, 11, 'loja', 'LOJA FICTICIA ELETRO 1/3', -30000, { installment: { index: 1, count: 3 } });
        if (i > 0) add(p, 20, 'pgto', 'PAGAMENTO RECEBIDO', 42970);
        if (i === 2) add(p, 13, 'est', 'ESTORNO LOJA FICTICIA', 5000);
      }
    });
    if (accountId === 'beta-card') {
      // Compra pendente no dia anterior a `today`; depois de `refresh` vem liquidada com o MESMO id.
      const [y, m, d] = this.today.split('-').map(Number);
      const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
      out.push({ id: 'pend-1', accountId, postedDate: prev, description: 'COMPRA LOJA FICTICIA ONLINE', amountCents: -12000, status: settled ? 'posted' : 'pending' });
    }
    return out;
  }
}
