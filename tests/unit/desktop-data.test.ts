/**
 * D1-C — credenciais (desktop/secrets.ts) e migração por backup (src/desktop/migration.ts).
 * Cifra simulada (reversível e marcada) — o cofre real (DPAPI/libsecret) é exercitado no app Electron.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SecretStore, vaultInfo, type VaultCrypto } from '../../desktop/secrets';
import { executeMigration, importThenOpen, MigrationError, planMigration } from '../../src/desktop/migration';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { buildExport } from '../../src/persistence/exportImport';
import { createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import { encryptBackup, type FinanceBackup } from '../../src/finance/backup';

beforeAll(() => registerBuiltinWidgets());

const fakeCrypto = (opts: { available?: boolean; backend?: string } = {}): VaultCrypto => ({
  isEncryptionAvailable: () => opts.available ?? true,
  backend: () => opts.backend ?? '',
  encrypt: (t) => Buffer.from('CIFRADO:' + Buffer.from(t).toString('hex')),
  decrypt: (b) => { const s = b.toString(); if (!s.startsWith('CIFRADO:')) throw new Error('falha'); return Buffer.from(s.slice(8), 'hex').toString(); },
});
const tmp = () => join(mkdtempSync(join(tmpdir(), 'aurora-secrets-')), 'credentials.json');
const FAKE_KEY = 'sk-proj-CHAVE-FICTICIA-123456789';

describe('cofre do sistema', () => {
  it('forte só com cifra disponível: DPAPI (Windows), Secret Service/KWallet (Linux); basic_text NÃO conta', () => {
    expect(vaultInfo('win32', fakeCrypto())).toMatchObject({ kind: 'dpapi', strong: true });
    expect(vaultInfo('linux', fakeCrypto({ backend: 'gnome_libsecret' }))).toMatchObject({ kind: 'secret-service', strong: true });
    expect(vaultInfo('linux', fakeCrypto({ backend: 'kwallet5' }))).toMatchObject({ kind: 'kwallet', strong: true });
    expect(vaultInfo('linux', fakeCrypto({ backend: 'basic_text' }))).toMatchObject({ kind: 'none', strong: false });
    expect(vaultInfo('linux', fakeCrypto({ backend: 'unknown' }))).toMatchObject({ kind: 'none', strong: false });
    expect(vaultInfo('win32', fakeCrypto({ available: false }))).toMatchObject({ kind: 'none', strong: false });
  });

  it('grava só cifrado, nunca devolve o valor, aplica ao ambiente do processo e sobrevive a reiniciar', () => {
    const file = tmp();
    const env: NodeJS.ProcessEnv = {};
    const s = new SecretStore(file, fakeCrypto(), 'win32', env);
    s.load();
    s.set('OPENAI_API_KEY', ` ${FAKE_KEY} `, 'vault');
    expect(env.OPENAI_API_KEY).toBe(FAKE_KEY);
    const disk = readFileSync(file, 'utf8');
    expect(disk).not.toContain(FAKE_KEY);
    expect(JSON.parse(disk)).toMatchObject({ v: 1, vault: 'dpapi' });
    expect(JSON.stringify(s.status())).not.toContain(FAKE_KEY);
    expect(s.status().items.find((i) => i.name === 'OPENAI_API_KEY')).toEqual({ name: 'OPENAI_API_KEY', configured: true, source: 'vault', secret: true });
    const env2: NodeJS.ProcessEnv = {};
    const again = new SecretStore(file, fakeCrypto(), 'win32', env2);
    again.load();
    expect(env2.OPENAI_API_KEY).toBe(FAKE_KEY);
    again.clear('OPENAI_API_KEY');
    expect(env2.OPENAI_API_KEY).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain('OPENAI_API_KEY');
  });

  it('sem cofre seguro: recusa gravar (sem texto puro silencioso), mas permite “só nesta sessão”', () => {
    const file = tmp();
    const env: NodeJS.ProcessEnv = {};
    const s = new SecretStore(file, fakeCrypto({ backend: 'basic_text' }), 'linux', env);
    s.load();
    expect(() => s.set('ANTHROPIC_API_KEY', FAKE_KEY, 'vault')).toThrow(/Sem cofre seguro/);
    expect(existsSync(file)).toBe(false);
    s.set('ANTHROPIC_API_KEY', FAKE_KEY, 'session');
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(s.status().items.find((i) => i.name === 'ANTHROPIC_API_KEY')?.source).toBe('session');
    expect(existsSync(file)).toBe(false);
  });

  it('variável de ambiente do sistema continua valendo; o valor do app tem prioridade e, removido, devolve a dela', () => {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'do-sistema' };
    const s = new SecretStore(tmp(), fakeCrypto(), 'win32', env);
    s.load();
    expect(s.status().items.find((i) => i.name === 'GEMINI_API_KEY')?.source).toBe('env');
    s.set('GEMINI_API_KEY', 'do-app', 'session');
    expect(env.GEMINI_API_KEY).toBe('do-app');
    s.clear('GEMINI_API_KEY');
    expect(env.GEMINI_API_KEY).toBe('do-sistema');
  });

  it('nomes fora da lista, valores vazios/gigantes/com controle e modos inválidos são recusados', () => {
    const s = new SecretStore(tmp(), fakeCrypto(), 'win32', {});
    s.load();
    expect(() => s.set('PATH', 'x', 'vault')).toThrow();
    expect(() => s.set('NODE_OPTIONS', '--require x', 'session')).toThrow();
    expect(() => s.set('OPENAI_API_KEY', '   ', 'vault')).toThrow();
    expect(() => s.set('OPENAI_API_KEY', 'a'.repeat(5000), 'vault')).toThrow();
    expect(() => s.set('OPENAI_API_KEY', 'a\nb', 'vault')).toThrow();
    expect(() => s.set('OPENAI_API_KEY', 'x', 'disco')).toThrow();
  });

  it('arquivo corrompido ou de outro usuário não derruba o app: sem chaves e com aviso', () => {
    const file = tmp();
    writeFileSync(file, '{lixo');
    const s = new SecretStore(file, fakeCrypto(), 'win32', {});
    s.load();
    expect(s.status().error).toMatch(/ilegível/);
    writeFileSync(file, JSON.stringify({ v: 1, entries: { OPENAI_API_KEY: Buffer.from('não cifrado').toString('base64') } }));
    s.load();
    expect(s.status().error).toMatch(/ilegível/);
    expect(s.status().items.every((i) => !i.configured)).toBe(true);
  });
});

/* ------------------------------------------------------------------ migração */

const board = (name: string, html = false) => ({
  id: `b_${name}`, workspaceId: 'w-web', name, description: '', camera: { x: 0, y: 0, zoom: 1 }, createdAt: 1, updatedAt: 1, schemaVersion: 1,
  elements: [createWidget(WIDGET.notes, '1.0.0', 'Nota', 0, 0, 200, 100, { text: 'oi' }), ...(html ? [createWidget(WIDGET.sandbox, '1.0.0', 'HTML', 0, 0, 200, 100, { html: '<b>x</b>', state: null })] : [])],
});
// Backup financeiro mínimo e VÁLIDO (passa por validateFinanceBackup); o conteúdo bancário é coberto em finance-*.test.ts.
const finance = (): FinanceBackup => ({ format: 'aurora-finance', schemaVersion: 1, exportedAt: 1, sensitive: true, institutions: [], accounts: [], transactions: [], imports: [], categories: [], rules: [] });

describe('migração por backup', () => {
  it('backup de quadros: plano com contagens; HTML chega desativado; nada é gravado no plano', async () => {
    const text = buildExport([board('A', true), board('B')] as never, []);
    const plan = await planMigration(text, undefined, 'w-desk');
    expect(plan).toMatchObject({ kind: 'boards', encrypted: false, finance: null, counts: { boards: 2, accounts: 0, activeContent: 1 } });
  });

  it('backup pessoal cifrado: exige a senha certa; com ela, quadros + finanças', async () => {
    const personal = JSON.stringify({ format: 'aurora-personal-backup', version: 1, exportedAt: 1, sensitive: true, boards: JSON.parse(buildExport([board('A')] as never, [])), finance: finance() });
    const enc = JSON.stringify(await encryptBackup(personal, 'senha-forte-123', 'personal'));
    await expect(planMigration(enc, 'errada', 'w')).rejects.toBeInstanceOf(MigrationError);
    await expect(planMigration(enc, undefined, 'w')).rejects.toBeInstanceOf(MigrationError);
    const plan = await planMigration(enc, 'senha-forte-123', 'w');
    expect(plan).toMatchObject({ kind: 'personal', encrypted: true, counts: { boards: 1, accounts: 0, transactions: 0 } });
    expect(plan.finance?.format).toBe('aurora-finance');
  }, 60_000);

  it('arquivo inválido ou quadros fora do esquema: recusado antes de gravar qualquer coisa', async () => {
    await expect(planMigration('{', undefined, 'w')).rejects.toThrow(/JSON/);
    await expect(planMigration(JSON.stringify({ qualquer: 1 }), undefined, 'w')).rejects.toBeInstanceOf(MigrationError);
    const badPersonal = JSON.stringify({ format: 'aurora-personal-backup', version: 1, exportedAt: 1, sensitive: true, boards: { format: 'aurora-board', boards: 'x' }, finance: finance() });
    await expect(planMigration(badPersonal, undefined, 'w')).rejects.toBeInstanceOf(MigrationError);
  });

  it('execução: finanças antes dos quadros; falha nos quadros não perde as finanças e repetir é seguro', async () => {
    const personal = JSON.stringify({ format: 'aurora-personal-backup', version: 1, exportedAt: 1, sensitive: true, boards: JSON.parse(buildExport([board('A')] as never, [])), finance: finance() });
    const plan = await planMigration(personal, undefined, 'w');
    const order: string[] = [];
    let failBoards = true;
    const deps = {
      restoreFinance: async () => { order.push('finance'); return order.filter((x) => x === 'finance').length === 1 ? { added: 2, skipped: 0 } : { added: 0, skipped: 2 }; },
      importBoards: async () => { order.push('boards'); if (failBoards) throw new Error('disco cheio'); return { boardIds: ['b1'] }; },
    };
    const first = await executeMigration(plan, deps);
    expect(first).toMatchObject({ finance: { added: 2 }, boardIds: [], failed: { step: 'boards', message: 'disco cheio' } });
    failBoards = false;
    const second = await executeMigration(plan, deps);
    expect(second).toEqual({ finance: { added: 0, skipped: 2 }, boardIds: ['b1'] });
    expect(order).toEqual(['finance', 'boards', 'finance', 'boards']);
    // Falha nas finanças: os quadros nem são tentados.
    const third = await executeMigration(plan, { ...deps, restoreFinance: async () => { throw new Error('cota'); } });
    expect(third).toMatchObject({ failed: { step: 'finance' }, boardIds: [] });
  });

  it('falha ao ABRIR depois de gravar não vira “nada gravado” (Codex, PR #40)', async () => {
    // Gravou e a abertura falhou: os ids voltam e o erro de abertura vem separado.
    const committed = await importThenOpen(async () => ['b_novo'], async () => { throw new Error('cota cheia ao gravar lastBoard'); });
    expect(committed).toEqual({ boardIds: ['b_novo'], openError: 'cota cheia ao gravar lastBoard' });
    // A gravação falhou: rejeita (o assistente diz que nada foi gravado) e a abertura nem é tentada.
    let opened = false;
    await expect(importThenOpen(async () => { throw new Error('disco cheio'); }, async () => { opened = true; })).rejects.toThrow('disco cheio');
    expect(opened).toBe(false);
    // No assistente: sem `failed`, com os quadros gravados e o aviso de abertura.
    const boardsOnly = { finance: null, boards: { source: 'aurora', boards: [], assets: [], warnings: [], stats: { boards: 1, elements: 0, activeContent: 0 } } };
    const out = await executeMigration(boardsOnly as never, {
      restoreFinance: async () => ({ added: 0, skipped: 0 }),
      importBoards: () => importThenOpen(async () => ['b_novo'], async () => { throw new Error('falhou ao abrir'); }),
    });
    expect(out.failed).toBeUndefined();
    expect(out).toMatchObject({ boardIds: ['b_novo'], openError: 'falhou ao abrir' });
  });
});

describe('cofre — consistência quando gravar falha (Codex, PR #40)', () => {
  it('cifra/disco falhando: nada muda (status, ambiente e arquivo continuam coerentes); mudanças avisam', () => {
    const file = tmp();
    const env: NodeJS.ProcessEnv = {};
    let failEncrypt = false;
    const c = fakeCrypto();
    const crypto: VaultCrypto = { ...c, encrypt: (t) => { if (failEncrypt) throw new Error('cofre indisponível'); return c.encrypt(t); } };
    const s = new SecretStore(file, crypto, 'win32', env);
    let changes = 0;
    s.onChange = () => { changes++; };
    s.load();
    s.set('PLUGGY_CLIENT_SECRET', 'segredo-antigo', 'vault');
    expect(changes).toBe(1);
    const before = readFileSync(file, 'utf8');
    failEncrypt = true;
    expect(() => s.set('PLUGGY_CLIENT_SECRET', 'segredo-novo', 'vault')).toThrow();
    expect(env.PLUGGY_CLIENT_SECRET).toBe('segredo-antigo');
    expect(s.status().items.find((i) => i.name === 'PLUGGY_CLIENT_SECRET')?.source).toBe('vault');
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Uma atualização de OUTRA chave depois não ativa a substituição que falhou.
    failEncrypt = false;
    s.set('OPENAI_API_KEY', FAKE_KEY, 'session');
    expect(env.PLUGGY_CLIENT_SECRET).toBe('segredo-antigo');
    // Remover com falha de gravação (o arquivo regravado ainda cifra outra chave): continua no cofre E ativa.
    s.set('GEMINI_API_KEY', 'g', 'vault');
    failEncrypt = true;
    expect(() => s.clear('PLUGGY_CLIENT_SECRET')).toThrow();
    expect(env.PLUGGY_CLIENT_SECRET).toBe('segredo-antigo');
    expect(s.status().items.find((i) => i.name === 'PLUGGY_CLIENT_SECRET')?.configured).toBe(true);
    failEncrypt = false;
    s.clear('PLUGGY_CLIENT_SECRET');
    expect(env.PLUGGY_CLIENT_SECRET).toBeUndefined();
    expect(changes).toBe(4); // set antigo, sessão OpenAI, sessão Gemini, remoção — falhas não avisam
  });
});
