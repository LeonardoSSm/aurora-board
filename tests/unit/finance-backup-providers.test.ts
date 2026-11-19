/** Ciclo F1 — backups financeiros separados/cifrados e provedor fictício (Open Finance simulado). */
import { beforeEach, describe, expect, it } from 'vitest';
import * as F from '../../src/finance/store';
import { MemoryFinanceRepository } from '../../src/finance/repository';
import { BackupError, buildFinanceBackup, decryptBackup, encryptBackup, readBackupFile, validateFinanceBackup } from '../../src/finance/backup';
import { MockBankProvider } from '../../src/finance/providers/mock';
import { connectionState, revokeConnection, startConnection, syncConnection, refreshConsentStatus } from '../../src/finance/providers/sync';
import { summarizeFlows } from '../../src/finance/reports';
import { buildExport, parseImport } from '../../src/persistence/exportImport';
import { createBoard } from '../../src/core/elements';

async function seeded() {
  F.resetFinanceForTests(new MemoryFinanceRepository());
  await F.ensureFinanceLoaded();
  const acc = await F.createAccount({ institutionName: 'Banco Fictício', name: 'Corrente', type: 'checking', number: '123456789' });
  const plan = F.prepareImport(acc.id, { drafts: [{ line: 1, postedDate: '2026-11-05', amountCents: 200000, description: 'SALARIO', status: 'posted' }, { line: 2, postedDate: '2026-11-06', amountCents: -12345, description: 'MERCADO', status: 'posted', externalId: 'X1' }], invalid: [], ignored: [], warnings: [] });
  await F.commitImportPlan(plan, { origin: 'csv', fileName: 'extrato.csv' });
  return acc;
}

describe('backup financeiro', () => {
  it('ida e volta: exportar, apagar tudo, restaurar; restaurar de novo não duplica', async () => {
    await seeded();
    const backup = buildFinanceBackup(F.getFinance());
    expect(backup).toMatchObject({ format: 'aurora-finance', sensitive: true });
    expect(JSON.stringify(backup)).not.toContain('123456789');
    const text = JSON.stringify(backup);
    await F.wipeFinanceData();
    expect(F.getFinance().transactions).toHaveLength(0);
    const { finance } = await readBackupFile(text);
    expect(await F.restoreFinanceBackup(finance)).toMatchObject({ added: 2 });
    expect(F.getFinance().transactions.map((t) => t.amountCents).sort((a, b) => a - b)).toEqual([-12345, 200000]);
    expect(await F.restoreFinanceBackup(finance)).toMatchObject({ added: 0 });
    expect(F.getFinance().transactions).toHaveLength(2);
  });
  it('backup de contas selecionadas inclui só elas', async () => {
    const a = await seeded();
    const b = await F.createAccount({ institutionName: 'Outro', name: 'Outra', type: 'savings' });
    const bk = buildFinanceBackup(F.getFinance(), [b.id]);
    expect(bk.accounts.map((x) => x.id)).toEqual([b.id]);
    expect(bk.transactions).toHaveLength(0);
    expect(bk.accounts.some((x) => x.id === a.id)).toBe(false);
  });
  it('validação recusa dados manipulados (valores, datas, ids, moeda, versão futura)', async () => {
    await seeded();
    const base = buildFinanceBackup(F.getFinance());
    const tamper = (fn: (b: any) => void) => { const b = structuredClone(base) as any; fn(b); return () => validateFinanceBackup(b); };
    expect(tamper((b) => (b.transactions[0].amountCents = 1.5))).toThrow(BackupError);
    expect(tamper((b) => (b.transactions[0].amountCents = 1e20))).toThrow(BackupError);
    expect(tamper((b) => (b.transactions[0].postedDate = '2026-02-31'))).toThrow(BackupError);
    expect(tamper((b) => (b.transactions[0].id = '<img src=x onerror=alert(1)>'))).toThrow(BackupError);
    expect(tamper((b) => (b.transactions[0].currency = 'USD'))).toThrow(BackupError);
    expect(tamper((b) => (b.transactions[0].accountId = 'acc_naoexiste'))).toThrow(BackupError);
    expect(tamper((b) => (b.schemaVersion = 99))).toThrow(/mais nova/);
    expect(tamper((b) => (b.transactions = 'x'))).toThrow(BackupError);
    // Número completo vindo do arquivo é reduzido à forma mascarada.
    const masked = validateFinanceBackup({ ...structuredClone(base), accounts: base.accounts.map((a) => ({ ...a, maskedNumber: '000123456789' })) });
    expect(masked.accounts[0].maskedNumber).toBe('•••• 6789');
  });
  it('cifra AES-GCM com PBKDF2: senha errada, arquivo alterado e senha fraca', async () => {
    await seeded();
    const plain = JSON.stringify(buildFinanceBackup(F.getFinance()));
    const enc = await encryptBackup(plain, 'senha-forte-de-teste', 'finance', 100_000);
    expect(JSON.stringify(enc)).not.toContain('SALARIO');
    expect(enc).toMatchObject({ kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 100_000 }, cipher: { name: 'AES-GCM' } });
    expect((await decryptBackup(enc, 'senha-forte-de-teste')).plaintext).toBe(plain);
    await expect(decryptBackup(enc, 'senha-errada-123')).rejects.toThrow(/Senha incorreta/);
    const altered = { ...enc, data: enc.data.slice(0, -4) + (enc.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(decryptBackup(altered, 'senha-forte-de-teste')).rejects.toThrow(/Senha incorreta ou arquivo corrompido/);
    await expect(encryptBackup(plain, 'curta', 'finance')).rejects.toThrow(/10 caracteres/);
    await expect(decryptBackup({ ...enc, kdf: { ...enc.kdf, iterations: 10 } }, 'x')).rejects.toThrow(/fora do padrão/);
    await expect(readBackupFile(JSON.stringify(enc))).rejects.toThrow(/informe a senha/);
    expect((await readBackupFile(JSON.stringify(enc), 'senha-forte-de-teste')).encrypted).toBe(true);
  });
  it('iterações padrão (600 mil) funcionam', async () => {
    const enc = await encryptBackup('{"x":1}', 'senha-forte-de-teste', 'finance');
    expect(enc.kdf.iterations).toBe(600_000);
    expect((await decryptBackup(enc, 'senha-forte-de-teste')).plaintext).toBe('{"x":1}');
  });
});

describe('isolamento entre backup visual e financeiro', () => {
  it('backup visual dos quadros não contém dados financeiros; importação visual recusa backup financeiro', async () => {
    await seeded();
    const board = createBoard('ws', 'Quadro', '');
    const visual = buildExport([board], []);
    expect(visual).not.toContain('SALARIO');
    expect(visual).not.toContain('aurora-finance');
    const fin = JSON.stringify(buildFinanceBackup(F.getFinance()));
    expect(() => parseImport(fin, 'ws')).toThrow(/backup financeiro/);
    // Backup pessoal completo: a importação visual lê só os quadros e avisa.
    const personal = JSON.stringify({ format: 'aurora-personal-backup', version: 1, exportedAt: 0, sensitive: true, boards: JSON.parse(visual), finance: JSON.parse(fin) });
    const r = parseImport(personal, 'ws');
    expect(r.boards).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/só os quadros/);
    const both = await readBackupFile(personal);
    expect(both.finance.transactions).toHaveLength(2);
  });
});

describe('provedor fictício (contrato BankDataProvider)', () => {
  let mock: MockBankProvider;
  beforeEach(async () => {
    F.resetFinanceForTests(new MemoryFinanceRepository());
    await F.ensureFinanceLoaded();
    mock = new MockBankProvider('2026-11-19');
  });
  const range = { from: '2026-08-01', to: '2026-11-19' };

  it('conectar → aprovar → sincronizar → atualizar pendente → revogar', async () => {
    const alfa = await startConnection(mock, 'alfa');
    expect(connectionState(alfa)).toBe('awaiting_consent');
    let r = await syncConnection(mock, alfa.id, range);
    expect(r.errors.join(' ')).toMatch(/não aprovado/);
    mock.approve(alfa.consentRef);
    expect((await refreshConsentStatus(mock, alfa.id)).status).toBe('active');
    r = await syncConnection(mock, alfa.id, range);
    expect(r.accounts).toBe(1);
    expect(r.added).toBeGreaterThan(5);
    const beta = await startConnection(mock, 'beta');
    mock.approve(beta.consentRef);
    await refreshConsentStatus(mock, beta.id);
    r = await syncConnection(mock, beta.id, range);
    expect(r.accounts).toBe(2);
    expect(r.duplicates).toBeGreaterThan(0); // entrega duplicada do provedor não entra duas vezes
    const s = F.getFinance();
    expect(s.accounts.every((a) => !/\d{5,}/.test(a.maskedNumber))).toBe(true);
    expect(s.accounts.find((a) => a.type === 'credit_card')?.card).toMatchObject({ limitCents: 800000, closingDay: 25 });
    // Transferências e pagamentos de fatura pareados entre as instituições.
    expect(s.transactions.filter((t) => t.local.kind === 'transfer' && t.local.linkId).length).toBe(6);
    expect(s.transactions.filter((t) => t.local.kind === 'card_payment' && t.local.linkId).length).toBe(2); // só outubro: o de 20/11 ainda não ocorreu
    const pending = s.transactions.find((t) => t.externalId === 'pend-1')!;
    expect(pending.status).toBe('pending');
    const n = s.transactions.length;
    r = await syncConnection(mock, beta.id, range, { refresh: true });
    expect(r.updated).toBe(1);
    expect(F.getFinance().transactions).toHaveLength(n);
    expect(F.getFinance().transactions.find((t) => t.id === pending.id)?.status).toBe('posted');
    // Consumo de novembro: transferências e pagamento de fatura fora; estorno reduz.
    const nov = summarizeFlows(F.getFinance().transactions, F.getFinance().accounts, { from: '2026-11-01', to: '2026-11-30' });
    expect(nov.incomeCents).toBe(500000);
    expect(nov.netExpenseCents).toBe(180000 + 35000 + 4250 + 8990 + 3990 + 30000 + 12000 - 5000);
    expect(nov.feeCents).toBe(2990);
    await revokeConnection(mock, beta.id);
    const revoked = F.getFinance().consents.find((c) => c.id === beta.id)!;
    expect(connectionState(revoked)).toBe('consent_revoked');
    expect(revoked.revokedAt).toBeTypeOf('number');
    r = await syncConnection(mock, beta.id, range);
    expect(r.errors.join(' ')).toMatch(/revogado/);
    // Revogar não apaga dados locais.
    expect(F.getFinance().transactions).toHaveLength(n);
  });

  it('expiração, falha temporária e provedor indisponível viram estado (sem apagar nada)', async () => {
    const c = await startConnection(mock, 'alfa');
    mock.approve(c.consentRef);
    await refreshConsentStatus(mock, c.id);
    await syncConnection(mock, c.id, range);
    const n = F.getFinance().transactions.length;
    mock.failNext('temporary');
    await syncConnection(mock, c.id, range);
    expect(connectionState(F.getFinance().consents[0])).toBe('temporary_failure');
    mock.failNext('unavailable');
    await syncConnection(mock, c.id, range);
    expect(connectionState(F.getFinance().consents[0])).toBe('provider_unavailable');
    await syncConnection(mock, c.id, range);
    expect(connectionState(F.getFinance().consents[0])).toBe('up_to_date');
    mock.expire(c.consentRef);
    await syncConnection(mock, c.id, range);
    expect(connectionState(F.getFinance().consents[0])).toBe('consent_expired');
    expect(F.getFinance().transactions).toHaveLength(n);
  });

  it('o registro de consentimento não guarda segredos', async () => {
    const c = await startConnection(mock, 'alfa');
    expect(Object.keys(c).sort()).toEqual(['consentRef', 'environment', 'expiresAt', 'id', 'institutionId', 'providerId', 'scopes', 'status']);
    expect(c.scopes.join(' ')).not.toMatch(/payment|pix|transfer/i);
    expect(c.environment).toBe('mock');
  });
});
