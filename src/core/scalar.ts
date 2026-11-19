/**
 * Valores tipados transmitidos pelo fluxo de dados (Value Tiles, meses, fórmulas, gráficos).
 *
 * - money: centavos inteiros + moeda; o papel (receita/despesa/neutro) é independente do sinal.
 * - number: decimal exato em texto canônico ("1234.5").
 * - percent: fração em texto canônico ("0.15" = 15%).
 * Saídas antigas do tipo `number` (JS number) continuam aceitas via `readScalar`.
 */
import type { Currency } from './finance';
import { formatMoney } from './finance';
import { decFromNumber, decToString, formatDec, MAX_CENTS, parseDec, type Dec } from './decimal';

export type FinancialRole = 'income' | 'expense' | 'neutral';

export interface MoneyValue {
  t: 'money';
  cents: number;
  currency: Currency;
  role?: FinancialRole;
  /** Chave estável do lançamento (evita contar duas vezes). */
  key?: string;
  label?: string;
  /** Competência declarada (AAAA-MM), se houver. */
  period?: string;
  category?: string;
}
export interface NumberValue { t: 'number'; v: string }
export interface PercentValue { t: 'percent'; v: string }
export type Scalar = MoneyValue | NumberValue | PercentValue;

export const CURRENCIES: Currency[] = ['BRL', 'USD', 'EUR'];
export const isCurrency = (c: unknown): c is Currency => c === 'BRL' || c === 'USD' || c === 'EUR';

export function moneyValue(cents: number, currency: Currency, meta: Omit<MoneyValue, 't' | 'cents' | 'currency'> = {}): MoneyValue {
  return { t: 'money', cents, currency, ...meta };
}
export const numberValue = (d: Dec): NumberValue => ({ t: 'number', v: decToString(d) });
export const percentValue = (fraction: Dec): PercentValue => ({ t: 'percent', v: decToString(fraction) });

export function isSafeCents(c: unknown): c is number {
  return typeof c === 'number' && Number.isSafeInteger(c) && Math.abs(c) <= Number(MAX_CENTS);
}

/** Lê qualquer valor numérico do fluxo (novo ou legado). Inválido/NaN/infinito → null. */
export function readScalar(x: unknown): Scalar | null {
  if (typeof x === 'number') {
    const d = decFromNumber(x);
    return d === null ? null : numberValue(d);
  }
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.t === 'money') return isSafeCents(o.cents) && isCurrency(o.currency) ? (o as unknown as MoneyValue) : null;
  if ((o.t === 'number' || o.t === 'percent') && typeof o.v === 'string' && parseDec(o.v) !== null) return o as unknown as Scalar;
  return null;
}

export function scalarDec(s: NumberValue | PercentValue): Dec {
  return parseDec(s.v) ?? 0n;
}

export function formatScalar(s: Scalar, opts: { decimals?: number } = {}): string {
  if (s.t === 'money') return formatMoney(s.cents, s.currency);
  if (s.t === 'percent') return `${formatDec(scalarDec(s) * 100n, opts.decimals ?? 2)}%`;
  return formatDec(scalarDec(s), opts.decimals ?? 4);
}

export const ROLE_LABEL: Record<FinancialRole, string> = { income: 'Receita', expense: 'Despesa', neutral: 'Neutro' };
export const KIND_LABEL: Record<Scalar['t'], string> = { money: 'Dinheiro', number: 'Número', percent: 'Porcentagem' };

/** Nome de variável estável a partir de um título: "Saldo de Janeiro" → "saldo_de_janeiro". */
export function slugVariable(title: string): string {
  let s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/g, '');
  if (!s) s = 'valor';
  if (/^\d/.test(s)) s = `v_${s}`;
  return s;
}

/** Normaliza para comparação (sem acentos, minúsculas). */
export const normalizeName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodLabel(period: string, style: 'long' | 'short' = 'long'): string {
  if (!PERIOD_RE.test(period)) return period || 'Sem período';
  const [y, m] = period.split('-').map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: style === 'long' ? 'long' : 'short', timeZone: 'UTC' }).replace('.', '');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function currentPeriod(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
