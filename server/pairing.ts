/**
 * Pareamento de dispositivos da rede local com o servidor do Aurora Board.
 *
 * Por que existe: a API local usa as SUAS chaves de IA e não tem login. Por padrão só atende este computador
 * (S1-SEC-013). Para usar a IA a partir de outro computador SEU na mesma rede, ele precisa ser pareado:
 *
 *  1. Neste computador, “Parear dispositivo” gera um código de uso único (8 caracteres, válido por 10 min).
 *  2. No outro computador, digita-se o código; o servidor devolve um token aleatório (256 bits) UMA vez.
 *  3. Cada chamada do outro computador leva `Authorization: Bearer <token>`; o servidor guarda só o SHA-256.
 *  4. Dispositivos podem ser revogados a qualquer momento (só a partir deste computador).
 *
 * Proteções: código expira e é invalidado após 5 tentativas erradas; após 20 falhas em 10 min o pareamento
 * remoto fica bloqueado por 10 min (contra adivinhação); comparação em tempo constante; gerenciar
 * dispositivos e gerar códigos só a partir deste computador. Não há limite de uso extra por dispositivo
 * (os limites gerais do S1 continuam valendo para o servidor inteiro).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PairedDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  lastAddress?: string;
}

export type PublicDevice = Omit<PairedDevice, 'tokenHash'>;

export const PAIRING_RULES = { codeTtlMs: 10 * 60_000, maxCodeAttempts: 5, lockoutFailures: 20, lockoutWindowMs: 10 * 60_000, maxDevices: 20 };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export class PairingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PairingStoreOptions {
  /** Arquivo JSON dos dispositivos (só hashes). Sem caminho: só memória (testes). */
  file?: string;
  now?: () => number;
}

export class PairingStore {
  private devices: PairedDevice[] = [];
  private code: { hash: string; expiresAt: number; attempts: number } | null = null;
  private failures: number[] = [];
  private now: () => number;

  constructor(private opts: PairingStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.file) {
      try {
        const raw = JSON.parse(readFileSync(opts.file, 'utf8')) as { devices?: unknown };
        if (Array.isArray(raw.devices)) {
          this.devices = raw.devices.filter((d): d is PairedDevice => !!d && typeof d === 'object' && typeof (d as PairedDevice).id === 'string' && /^[0-9a-f]{64}$/.test(String((d as PairedDevice).tokenHash)));
        }
      } catch { /* sem arquivo ainda */ }
    }
  }

  private persist() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.file);
  }

  /** Gera um novo código (invalida o anterior). Só a partir deste computador. */
  createCode(): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = this.now() + PAIRING_RULES.codeTtlMs;
    this.code = { hash: sha256(code), expiresAt, attempts: 0 };
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  cancelCode() { this.code = null; }

  private lockedOut(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < PAIRING_RULES.lockoutWindowMs);
    return this.failures.length >= PAIRING_RULES.lockoutFailures;
  }

  /** Troca um código válido por um token (devolvido só aqui, uma vez). */
  claim(rawCode: unknown, rawName: unknown, address?: string): { token: string; device: PublicDevice } {
    if (this.lockedOut()) throw new PairingError(429, 'Muitas tentativas de pareamento. Aguarde 10 minutos.');
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    const c = this.code;
    const fail = (msg: string): never => {
      this.failures.push(this.now());
      if (c) { c.attempts++; if (c.attempts >= PAIRING_RULES.maxCodeAttempts) this.code = null; }
      throw new PairingError(401, msg);
    };
    if (!c || this.now() > c.expiresAt) { this.code = null; fail('Código inválido ou expirado. Gere um novo no computador principal.'); }
    if (code.length !== 8 || !sameHex(sha256(code), c!.hash)) fail('Código incorreto.');
    if (this.devices.length >= PAIRING_RULES.maxDevices) throw new PairingError(409, `Limite de ${PAIRING_RULES.maxDevices} dispositivos pareados. Revogue algum antes.`);
    this.code = null; // uso único
    const token = randomBytes(32).toString('base64url');
    const name = (typeof rawName === 'string' ? rawName : '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60) || 'Dispositivo';
    const t = this.now();
    const device: PairedDevice = { id: randomBytes(8).toString('hex'), name, tokenHash: sha256(token), createdAt: t, lastSeenAt: t, lastAddress: address };
    this.devices.push(device);
    this.persist();
    return { token, device: publicDevice(device) };
  }

  /** Dispositivo dono do token, ou null. Atualiza “visto por último” (gravado no máximo a cada minuto). */
  verify(authorization: string | undefined, address?: string): PublicDevice | null {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization ?? '');
    if (!m) return null;
    const h = sha256(m[1]);
    const d = this.devices.find((x) => sameHex(x.tokenHash, h));
    if (!d) return null;
    const t = this.now();
    const stale = t - d.lastSeenAt > 60_000;
    d.lastSeenAt = t;
    d.lastAddress = address ?? d.lastAddress;
    if (stale) { try { this.persist(); } catch { /* visto por último é informativo */ } }
    return publicDevice(d);
  }

  list(): PublicDevice[] { return this.devices.map(publicDevice); }

  revoke(id: unknown): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.persist();
    return true;
  }

  pendingCode(): { expiresAt: number } | null {
    return this.code && this.now() <= this.code.expiresAt ? { expiresAt: this.code.expiresAt } : null;
  }
}

function publicDevice(d: PairedDevice): PublicDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, lastAddress: d.lastAddress };
}

/**
 * Host aceito para chamadas remotas pareadas: IP privado literal (10/8, 172.16/12, 192.168/16, 100.64/10,
 * IPv6 local) ou nome `.local`/`.lan`. Um domínio público apontando para cá (DNS rebinding) não passa.
 */
export function isAllowedLanHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (/^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^(fe80|fd[0-9a-f]{2}|fc[0-9a-f]{2}):/.test(h)) return true;
  return /^[a-z0-9-]{1,63}\.(local|lan)$/.test(h);
}

/** Origem aceita para chamadas remotas: ausente ou a MESMA do host (a página servida pelo próprio Aurora). */
export function isSameOriginForHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!host && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
