/**
 * D1-C — credenciais do Aurora Board Desktop (chaves de IA, credenciais do Meu Pluggy).
 *
 * - Nunca vão para o IndexedDB, quadros, backups ou o renderer: o renderer só ESCREVE (definir/remover) e lê o
 *   STATUS (configurada ou não, de onde vem). O valor fica no processo principal.
 * - Persistência só com o COFRE DO SISTEMA: `safeStorage` do Electron = DPAPI do usuário no Windows; no Linux,
 *   Secret Service (GNOME Keyring/libsecret) ou KWallet. Se o Electron cair no back-end `basic_text` (sem cofre)
 *   ou a cifra não estiver disponível, NÃO grava: o usuário é avisado e pode usar a chave só nesta sessão.
 * - Arquivo `credentials.json` no perfil do app (fora da pasta de instalação), só com blobs cifrados.
 * Prioridade: valor definido no app (cofre ou sessão) > variável de ambiente do sistema.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SECRET_NAMES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL', 'PLUGGY_CLIENT_ID', 'PLUGGY_CLIENT_SECRET', 'PLUGGY_ITEM_IDS'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
/** Não são segredos (modelos, ids de item), mas ficam no mesmo lugar para não irem a backups. */
export const NON_SECRET = new Set<SecretName>(['OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL', 'PLUGGY_ITEM_IDS']);
const MAX_VALUE = 4096;

export interface VaultCrypto {
  isEncryptionAvailable(): boolean;
  /** Linux: back-end escolhido pelo Chromium (`basic_text` = sem cofre). Outros sistemas: ''. */
  backend(): string;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export type VaultKind = 'dpapi' | 'secret-service' | 'kwallet' | 'keychain' | 'none';
export interface VaultInfo { kind: VaultKind; strong: boolean; detail: string }

/** O cofre disponível protege de verdade? (Nada de “criptografia” com chave fixa conhecida.) */
export function vaultInfo(platform: string, c: VaultCrypto): VaultInfo {
  let available = false;
  try { available = c.isEncryptionAvailable(); } catch { available = false; }
  if (!available) return { kind: 'none', strong: false, detail: 'Cifra do sistema indisponível.' };
  if (platform === 'win32') return { kind: 'dpapi', strong: true, detail: 'Windows (DPAPI do usuário).' };
  if (platform === 'darwin') return { kind: 'keychain', strong: true, detail: 'Chaves do macOS.' };
  const b = (() => { try { return c.backend(); } catch { return 'unknown'; } })();
  if (b === 'gnome_libsecret') return { kind: 'secret-service', strong: true, detail: 'Secret Service (GNOME Keyring/libsecret).' };
  if (/^kwallet\d*$/.test(b)) return { kind: 'kwallet', strong: true, detail: 'KWallet.' };
  return { kind: 'none', strong: false, detail: b === 'basic_text' ? 'Nenhum cofre do sistema encontrado (Secret Service/KWallet): o Electron usaria uma chave fixa, que não protege.' : `Cofre desconhecido (${b}).` };
}

export type SecretSource = 'vault' | 'session' | 'env' | 'none';
export interface SecretStatus { name: SecretName; configured: boolean; source: SecretSource; secret: boolean }
export interface StoreStatus { vault: VaultInfo; items: SecretStatus[]; error?: string }

export class SecretError extends Error {}

export function isSecretName(n: unknown): n is SecretName {
  return typeof n === 'string' && (SECRET_NAMES as readonly string[]).includes(n);
}

export function cleanSecretValue(v: unknown): string {
  if (typeof v !== 'string') throw new SecretError('Valor inválido.');
  const t = v.trim();
  if (!t || t.length > MAX_VALUE) throw new SecretError(`Valor vazio ou com mais de ${MAX_VALUE} caracteres.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new SecretError('O valor contém caracteres de controle.');
  return t;
}

export class SecretStore {
  private vault = new Map<SecretName, string>();
  private session = new Map<SecretName, string>();
  private loadError = '';
  /** Valores das variáveis de ambiente ANTES do app (para restaurar ao remover a chave do app). */
  private readonly original: Partial<Record<SecretName, string>>;

  constructor(private file: string, private crypto: VaultCrypto, private platform: string, private env: NodeJS.ProcessEnv = process.env) {
    this.original = Object.fromEntries(SECRET_NAMES.filter((n) => (env[n] ?? '').trim()).map((n) => [n, env[n] as string]));
  }

  info(): VaultInfo { return vaultInfo(this.platform, this.crypto); }

  /** Lê o arquivo cifrado. Arquivo corrompido/ilegível não derruba o app: fica sem chaves e avisa. */
  load() {
    this.vault.clear();
    this.loadError = '';
    if (!existsSync(this.file)) { this.apply(); return; }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: unknown; entries?: Record<string, unknown> };
      if (raw.v !== 1 || !raw.entries || typeof raw.entries !== 'object') throw new Error('formato');
      if (!this.info().strong) throw new Error('cofre indisponível');
      for (const [k, v] of Object.entries(raw.entries)) {
        if (!isSecretName(k) || typeof v !== 'string') continue;
        this.vault.set(k, this.crypto.decrypt(Buffer.from(v, 'base64')));
      }
    } catch (e) {
      this.vault.clear();
      this.loadError = (e as Error).message === 'cofre indisponível'
        ? 'Há credenciais gravadas, mas o cofre do sistema não está disponível agora: configure-as de novo ou abra a sessão do cofre (Linux).'
        : 'O arquivo de credenciais está ilegível (corrompido ou de outro usuário do sistema): configure as chaves de novo.';
    }
    this.apply();
  }

  status(): StoreStatus {
    const items = SECRET_NAMES.map((name) => {
      const source: SecretSource = this.session.has(name) ? 'session' : this.vault.has(name) ? 'vault' : this.original[name] ? 'env' : 'none';
      return { name, configured: source !== 'none', source, secret: !NON_SECRET.has(name) };
    });
    return { vault: this.info(), items, ...(this.loadError ? { error: this.loadError } : {}) };
  }

  /** Define o valor: `vault` grava cifrado (só com cofre forte); `session` só na memória até fechar o app. */
  set(name: unknown, value: unknown, mode: unknown) {
    if (!isSecretName(name)) throw new SecretError('Credencial desconhecida.');
    const v = cleanSecretValue(value);
    if (mode === 'vault') {
      if (!this.info().strong) throw new SecretError('Sem cofre seguro do sistema: a chave não foi gravada. Use “só nesta sessão” ou configure o Secret Service/KWallet.');
      this.vault.set(name, v);
      this.session.delete(name);
      this.persist();
    } else if (mode === 'session') {
      this.session.set(name, v);
    } else {
      throw new SecretError('Modo inválido.');
    }
    this.apply();
  }

  clear(name: unknown) {
    if (!isSecretName(name)) throw new SecretError('Credencial desconhecida.');
    const had = this.vault.delete(name);
    this.session.delete(name);
    if (had) this.persist();
    this.apply();
  }

  /** Valor efetivo vai para o ambiente DO PROCESSO PRINCIPAL (lido pelos provedores e pelo Meu Pluggy). */
  private apply() {
    for (const n of SECRET_NAMES) {
      const v = this.session.get(n) ?? this.vault.get(n) ?? this.original[n];
      if (v) this.env[n] = v; else delete this.env[n];
    }
  }

  private persist() {
    const entries: Record<string, string> = {};
    for (const [k, v] of this.vault) entries[k] = this.crypto.encrypt(v).toString('base64');
    mkdirSync(dirname(this.file), { recursive: true });
    // Escrita atômica: arquivo temporário + rename (nunca um arquivo pela metade).
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, vault: this.info().kind, entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
