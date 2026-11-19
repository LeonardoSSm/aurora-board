/** Ciclo F1 — deduplicação, conciliação, saldos, persistência atômica e o exemplo contábil obrigatório. */
import { beforeEach, describe, expect, it } from 'vitest';
import { dedupeKeys, planImport } from '../../src/finance/importPlan';
import type { TransactionDraft } from '../../src/finance/drafts';
import { parseCsvStatement } from '../../src/finance/csv';
import { IndexedDBFinanceRepository, MemoryFinanceRepository, type FinanceRepository } from '../../src/finance/repository';
import * as F from '../../src/finance/store';
import { accountBalance, billMonth, cardSummary, consolidate, recurring, summarizeFlows } from '../../src/finance/reports';

const d = (line: number, postedDate: string, amountCents: number, description: string, extra: Partial<TransactionDraft> = {}): TransactionDraft => ({ line, postedDate, amountCents, description, status: 'posted', ...extra });

async function fresh<R extends FinanceRepository = MemoryFinanceRepository>(repo: R = new MemoryFinanceRepository() as unknown as R): Promise<R> {
  F.resetFinanceForTests(repo);
  await F.ensureFinanceLoaded();
  return repo;
}

async function importDrafts(accountId: string, drafts: TransactionDraft[], fileName = 'extrato.csv') {
  const plan = F.prepareImport(accountId, { drafts, invalid: [], ignored: [], warnings: [] });
  return { plan, result: await F.commitImportPlan(plan, { origin: 'csv', fileName }) };
}

describe('chaves de deduplicação', () => {
  it('ID da fonte vence; sem ID, impressão digital com ocorrência', () => {
    const keys = dedupeKeys([d(1, '2026-11-01', -1000, 'Café'), d(2, '2026-11-01', -1000, 'Café'), d(3, '2026-11-01', -1000, 'Café', { externalId: 'X' })]);
    expect(keys).toEqual(['fp:2026-11-01|-1000|cafe#1', 'fp:2026-11-01|-1000|cafe#2', 'ext:X']);
  });
});

describe('importação idempotente', () => {
  beforeEach(async () => { await fresh(); });

  it('mesmo arquivo duas vezes não duplica; duas compras iguais legítimas entram', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    const drafts = [d(1, '2026-11-01', -1000, 'Café'), d(2, '2026-11-01', -1000, 'Café'), d(3, '2026-11-02', 200000, 'Salário')];
    const first = await importDrafts(acc.id, drafts);
    expect(first.result.added).toBe(3);
    const again = F.prepareImport(acc.id, { drafts, invalid: [], ignored: [], warnings: [] });
    expect(again.totals).toMatchObject({ newCount: 0, duplicateCount: 3 });
    const r = await F.commitImportPlan(again, { origin: 'csv' });
    expect(r.added).toBe(0);
    expect(F.getFinance().transactions).toHaveLength(3);
    expect(r.session.counts).toMatchObject({ read: 3, accepted: 0, duplicate: 3 });
  });

  it('arquivos com período sobreposto: só o que é novo entra', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -1000, 'A'), d(2, '2026-11-02', -2000, 'B')]);
    const { result } = await importDrafts(acc.id, [d(1, '2026-11-02', -2000, 'B'), d(2, '2026-11-03', -3000, 'C')]);
    expect(result.added).toBe(1);
    expect(F.getFinance().transactions.map((t) => t.description).sort()).toEqual(['A', 'B', 'C']);
  });

  it('valor + data iguais com descrição diferente NÃO são descartados (só alerta)', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -5000, 'Padaria')]);
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -5000, 'Farmácia')], invalid: [], ignored: [], warnings: [] });
    expect(plan.items[0]).toMatchObject({ status: 'new', include: true });
    expect(plan.items[0].warning).toMatch(/Mesmo valor/);
  });

  it('mesmo período por OFX (com ID) e depois CSV (sem ID): vai para revisão desmarcado', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -5000, 'Padaria', { externalId: 'F1' })]);
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -5000, 'PADARIA')], invalid: [], ignored: [], warnings: [] });
    expect(plan.items[0]).toMatchObject({ status: 'possible-duplicate', include: false });
  });

  it('mesmo ID com dados diferentes vira conflito (não sobrescreve)', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -5000, 'Padaria', { externalId: 'F1' })]);
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -6000, 'Padaria', { externalId: 'F1' })], invalid: [], ignored: [], warnings: [] });
    expect(plan.items[0].status).toBe('conflict');
    const r = await F.commitImportPlan(plan, { origin: 'ofx' });
    expect(r.session.counts.conflict).toBe(1);
    expect(F.getFinance().transactions[0].amountCents).toBe(-5000);
  });

  it('pendente que vira contabilizada é atualizada, sem duplicar; reimportar o definitivo não duplica', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -5000, 'Loja', { status: 'pending', externalId: 'P1' })]);
    const posted = [d(1, '2026-11-02', -5000, 'Loja', { externalId: 'T1' })];
    const { plan, result } = await importDrafts(acc.id, posted);
    expect(plan.items[0].status).toBe('pending-update');
    expect(result.updated).toBe(1);
    expect(F.getFinance().transactions).toHaveLength(1);
    expect(F.getFinance().transactions[0]).toMatchObject({ status: 'posted', postedDate: '2026-11-02' });
    const again = F.prepareImport(acc.id, { drafts: posted, invalid: [], ignored: [], warnings: [] });
    expect(again.items[0].status).toBe('duplicate');
  });

  it('lançamento manual nunca é tocado por importações', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    const manual = await F.addManualTransaction(acc.id, { date: '2026-11-01', description: 'Padaria', amountCents: -5000 });
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -5000, 'Padaria')], invalid: [], ignored: [], warnings: [] });
    expect(plan.items[0].status).toBe('new'); // não é marcado como duplicata do manual
    await F.commitImportPlan(plan, { origin: 'csv' });
    expect(F.getFinance().transactions.find((t) => t.id === manual.id)).toEqual(manual);
  });

  it('moeda diferente da conta é recusada na linha', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -5000, 'X', { currency: 'USD' })], invalid: [], ignored: [], warnings: [] });
    expect(plan.items).toHaveLength(0);
    expect(plan.invalid[0].reason).toMatch(/Moeda/);
  });

  it('reverter importação remove só o que ela criou e restaura pendentes atualizadas', async () => {
    const acc = await F.createAccount({ institutionName: 'Banco A', name: 'Corrente', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -5000, 'Loja', { status: 'pending', externalId: 'P1' }), d(2, '2026-11-01', -1, 'Outro')]);
    const { result } = await importDrafts(acc.id, [d(1, '2026-11-02', -5000, 'Loja', { externalId: 'T1' }), d(2, '2026-11-05', -700, 'Nova')]);
    const r = await F.revertImport(result.session.id);
    expect(r).toEqual({ removed: 1, restored: 1 });
    const txs = F.getFinance().transactions;
    expect(txs).toHaveLength(2);
    expect(txs.find((t) => t.description === 'Loja')).toMatchObject({ status: 'pending', postedDate: '2026-11-01', externalId: 'P1' });
    expect(F.getFinance().imports.find((i) => i.id === result.session.id)?.status).toBe('reverted');
  });
});

describe('exemplo contábil obrigatório (F1, etapa 6)', () => {
  it('receita 2.000; transferência 500; compra 300; pagamento 300; estorno 50 → receita 2.000, consumo líquido 250', async () => {
    await fresh();
    const a = await F.createAccount({ institutionName: 'Banco A', name: 'Conta A', type: 'checking', openingBalance: { cents: 100000, date: '2026-11-01' } });
    const b = await F.createAccount({ institutionName: 'Banco B', name: 'Conta B', type: 'checking', openingBalance: { cents: 0, date: '2026-11-01' } });
    const card = await F.createAccount({ institutionName: 'Banco B', name: 'Cartão B', type: 'credit_card', openingBalance: { cents: 0, date: '2026-11-01' }, card: { closingDay: 25, dueDay: 5, limitCents: 500000 } });
    await importDrafts(a.id, [
      d(1, '2026-11-05', 200000, 'SALARIO EMPRESA FICTICIA'),
      d(2, '2026-11-06', -50000, 'TED ENVIADA CONTA B'),
      d(3, '2026-11-20', -30000, 'PAGAMENTO FATURA CARTAO B'),
    ]);
    await importDrafts(b.id, [d(1, '2026-11-06', 50000, 'TED RECEBIDA CONTA A')]);
    await importDrafts(card.id, [
      d(1, '2026-11-10', -30000, 'LOJA FICTICIA'),
      d(2, '2026-11-20', 30000, 'PAGAMENTO RECEBIDO'),
      d(3, '2026-11-22', 5000, 'ESTORNO LOJA FICTICIA'),
    ]);
    const s = F.getFinance();
    const kinds = Object.fromEntries(s.transactions.map((t) => [t.description, t.local.kind]));
    expect(kinds).toEqual({
      'SALARIO EMPRESA FICTICIA': 'income',
      'TED ENVIADA CONTA B': 'transfer',
      'TED RECEBIDA CONTA A': 'transfer',
      'PAGAMENTO FATURA CARTAO B': 'card_payment',
      'PAGAMENTO RECEBIDO': 'card_payment',
      'LOJA FICTICIA': 'expense',
      'ESTORNO LOJA FICTICIA': 'refund',
    });
    const r = summarizeFlows(s.transactions, s.accounts, { from: '2026-11-01', to: '2026-11-30' });
    expect(r.incomeCents).toBe(200000);
    expect(r.netExpenseCents).toBe(25000);
    expect(r.expenseCents).toBe(30000);
    expect(r.refundCents).toBe(5000);
    expect(r.transferInCents).toBe(50000);
    expect(r.transferOutCents).toBe(50000);
    expect(r.cardPaymentCents).toBe(30000);
    expect(r.resultCents).toBe(175000);
    expect(r.warnings.filter((w) => /fatura sem o cartão/.test(w))).toHaveLength(0);
    // Saldos efetivos: A = 1.000 + 2.000 − 500 − 300 = 2.200; B = 500; cartão = −300 + 300 + 50 = +50 (crédito).
    expect(accountBalance(a, s.transactions).estimatedCents).toBe(220000);
    expect(accountBalance(b, s.transactions).estimatedCents).toBe(50000);
    expect(accountBalance(card, s.transactions).estimatedCents).toBe(5000);
    const c = consolidate(s.accounts, s.transactions);
    expect(c).toMatchObject({ totalCents: 275000, complete: true });
    const cs = cardSummary(card, s.transactions);
    expect(cs).toMatchObject({ purchasesCents: 30000, refundsCents: 5000, paymentsCents: 30000, debtCents: -5000, limitCents: 500000 });
    // Limite do cartão nunca entra no consolidado.
    expect(c.totalCents).not.toBe(275000 + 500000);
  });
});

describe('conciliação conservadora', () => {
  beforeEach(async () => { await fresh(); });
  it('sem evidência na descrição, o par fica como sugestão (não é aplicado sozinho)', async () => {
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    const b = await F.createAccount({ institutionName: 'B', name: 'B', type: 'checking' });
    await importDrafts(a.id, [d(1, '2026-11-06', -50000, 'Pagamento João')]);
    await importDrafts(b.id, [d(1, '2026-11-06', 50000, 'Crédito Maria')]);
    expect(F.getFinance().transactions.every((t) => t.local.kind !== 'transfer')).toBe(true);
    const sug = F.pairSuggestions();
    expect(sug).toHaveLength(1);
    expect(sug[0].confident).toBe(false);
    await F.acceptPair(sug[0]);
    expect(F.getFinance().transactions.every((t) => t.local.kind === 'transfer' && t.local.linkId)).toBe(true);
    const linkId = F.getFinance().transactions[0].local.linkId!;
    await F.unlink(linkId);
    expect(F.getFinance().transactions.map((t) => t.local.kind).sort()).toEqual(['expense', 'income']);
  });
  it('candidatos ambíguos não são pareados automaticamente', async () => {
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    const b = await F.createAccount({ institutionName: 'B', name: 'B', type: 'checking' });
    const c = await F.createAccount({ institutionName: 'C', name: 'C', type: 'checking' });
    // Dois créditos iguais em contas diferentes chegam antes do débito: qual é o par? Não adivinha.
    await importDrafts(b.id, [d(1, '2026-11-06', 50000, 'TED RECEBIDA')]);
    await importDrafts(c.id, [d(1, '2026-11-06', 50000, 'TED RECEBIDA')]);
    await importDrafts(a.id, [d(1, '2026-11-06', -50000, 'TED ENVIADA')]);
    expect(F.pairSuggestions()[0]).toMatchObject({ confident: false });
    expect(F.getFinance().transactions.filter((t) => t.local.linkId)).toHaveLength(0);
  });
  it('classificação manual do usuário não é sobrescrita por regras nem pela conciliação', async () => {
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    await importDrafts(a.id, [d(1, '2026-11-06', -1990, 'NETFLIX.COM')]);
    const t = F.getFinance().transactions[0];
    expect(t.local.category).toBe('Assinaturas');
    await F.classifyTransaction(t.id, { category: 'Lazer' });
    await F.addRule({ match: 'netflix', category: 'Contas e serviços' });
    expect(await F.applyRulesNow()).toBe(0);
    expect(F.getFinance().transactions[0].local).toMatchObject({ category: 'Lazer', categorySource: 'user' });
    expect(F.getFinance().transactions[0].description).toBe('NETFLIX.COM'); // registro original intacto
  });
  it('pagamento de fatura sem o cartão importado gera aviso (sem esconder divergência)', async () => {
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    await importDrafts(a.id, [d(1, '2026-11-06', -30000, 'PAGTO FATURA CARTAO')]);
    const s = F.getFinance();
    const r = summarizeFlows(s.transactions, s.accounts);
    expect(r.netExpenseCents).toBe(0);
    expect(r.cardPaymentCents).toBe(30000);
    expect(r.warnings.join(' ')).toMatch(/sem o cartão importado/);
  });
});

describe('saldos', () => {
  it('sem âncora não há saldo (só fluxo); saldo informado + posteriores = estimado', async () => {
    await fresh();
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    await importDrafts(a.id, [d(1, '2026-11-01', 10000, 'X'), d(2, '2026-11-10', -2500, 'Y')]);
    let s = F.getFinance();
    expect(accountBalance(s.accounts[0], s.transactions)).toMatchObject({ estimatedCents: null, basis: 'none', flowCents: 7500 });
    expect(consolidate(s.accounts, s.transactions)).toMatchObject({ complete: false, missing: [a.id] });
    await F.updateAccount(a.id, { reportedBalance: { cents: 50000, asOf: '2026-11-05', origin: 'ofx' } });
    s = F.getFinance();
    expect(accountBalance(s.accounts[0], s.transactions)).toMatchObject({ estimatedCents: 47500, basis: 'estimated-from-reported' });
  });
  it('mês da fatura respeita o fechamento', () => {
    expect(billMonth('2026-11-20', 25)).toBe('2026-12');
    expect(billMonth('2026-11-26', 25)).toBe('2027-01');
  });
  it('recorrências: mesmo valor e descrição em 3 meses', async () => {
    await fresh();
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    await importDrafts(a.id, ['2026-09-05', '2026-10-05', '2026-11-05'].map((dt, i) => d(i + 1, dt, -3990, 'SPOTIFY')));
    expect(recurring(F.getFinance().transactions)).toEqual([{ description: 'SPOTIFY', amountCents: -3990, months: 3, accountId: a.id }]);
  });
});

describe('persistência IndexedDB (atômica e isolada)', () => {
  it('importação atômica: falha no meio não grava nada; recarregar preserva integridade', async () => {
    const name = `aurora-finance-test-${Math.random()}`;
    await fresh(new IndexedDBFinanceRepository(name));
    const acc = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    await importDrafts(acc.id, [d(1, '2026-11-01', -100, 'A'), d(2, '2026-11-02', -200, 'B')]);
    // Recarrega de um repositório novo (como abrir o app de novo).
    F.resetFinanceForTests(new IndexedDBFinanceRepository(name));
    await F.ensureFinanceLoaded();
    expect(F.getFinance().transactions.map((t) => t.amountCents).sort((x, y) => x - y)).toEqual([-200, -100]);
    // Forja uma duplicata no lote: a defesa do repositório aborta a transação inteira.
    const repo = F.financeRepository();
    const t0 = F.getFinance().transactions[0];
    await expect(repo.commitImport({ session: { ...F.getFinance().imports[0], id: 'imp_x' }, add: [{ ...t0, id: 'tx_new1', dedupeKey: 'fp:novo#1' }, { ...t0, id: 'tx_new2' }], update: [] })).rejects.toThrow(/duplicada/);
    const snap = await repo.load();
    expect(snap.transactions).toHaveLength(2);
    expect(snap.imports.some((i) => i.id === 'imp_x')).toBe(false);
  });
  it('erro de gravação não altera a memória (sem estado fantasma)', async () => {
    const repo = await fresh(new MemoryFinanceRepository());
    const acc = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    const plan = F.prepareImport(acc.id, { drafts: [d(1, '2026-11-01', -100, 'A')], invalid: [], ignored: [], warnings: [] });
    repo.failNextWrite = true;
    await expect(F.commitImportPlan(plan, { origin: 'csv' })).rejects.toThrow(/simulada/);
    expect(F.getFinance().transactions).toHaveLength(0);
    expect(F.getFinance().imports).toHaveLength(0);
  });
  it('excluir conta remove só os dados dela; apagar tudo zera o razão', async () => {
    await fresh(new IndexedDBFinanceRepository(`aurora-finance-test-${Math.random()}`));
    const a = await F.createAccount({ institutionName: 'A', name: 'A', type: 'checking' });
    const b = await F.createAccount({ institutionName: 'B', name: 'B', type: 'checking' });
    await importDrafts(a.id, [d(1, '2026-11-01', -100, 'A')]);
    await importDrafts(b.id, [d(1, '2026-11-01', -200, 'B')]);
    expect(await F.deleteAccountData(a.id)).toBe(1);
    expect(F.getFinance().transactions.map((t) => t.accountId)).toEqual([b.id]);
    const snap = await F.financeRepository().load();
    expect(snap.transactions).toHaveLength(1);
    expect(snap.imports.every((i) => i.accountId === b.id)).toBe(true);
    await F.wipeFinanceData();
    const after = await F.financeRepository().load();
    expect(after.transactions.length + after.accounts.length + after.imports.length).toBe(0);
    expect(after.categories.length).toBeGreaterThan(0);
  });
  it('o banco financeiro é separado do banco dos quadros', async () => {
    const { DB_NAME } = await import('../../src/persistence/indexeddb');
    const { FINANCE_DB_NAME } = await import('../../src/finance/repository');
    expect(FINANCE_DB_NAME).not.toBe(DB_NAME);
  });
});

describe('ponta a ponta com arquivo CSV', () => {
  it('CSV → prévia → confirmar → reimportar', async () => {
    await fresh();
    const acc = await F.createAccount({ institutionName: 'Banco Fictício', name: 'Corrente', type: 'checking' });
    const csv = 'Data;Descrição;Valor\n05/11/2026;SALARIO;2.000,00\n06/11/2026;MERCADO;-123,45\n06/11/2026;MERCADO;-123,45\n';
    const parsed = parseCsvStatement(csv);
    const plan = F.prepareImport(acc.id, parsed);
    expect(plan.totals).toMatchObject({ newCount: 3, inCents: 200000, outCents: 24690 });
    expect(F.getFinance().transactions).toHaveLength(0); // nada gravado antes de confirmar
    await F.commitImportPlan(plan, { origin: 'csv', fileName: 'C:\\Users\\x\\extrato<1>.csv' });
    expect(F.getFinance().imports[0].fileName).toBe('extrato_1_.csv');
    const again = F.prepareImport(acc.id, parseCsvStatement(csv));
    expect(again.totals.newCount).toBe(0);
  });
});

describe('planImport puro', () => {
  it('linha repetida com o mesmo ID dentro do arquivo', () => {
    const p = planImport({ account: { id: 'a', currency: 'BRL', type: 'checking' }, drafts: [d(1, '2026-11-01', -1, 'x', { externalId: 'Z' }), d(2, '2026-11-01', -1, 'x', { externalId: 'Z' })], existing: [] });
    expect(p.items.map((i) => i.status)).toEqual(['new', 'duplicate']);
  });
});
