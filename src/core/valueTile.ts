/** Value Tile: bloco de valor (dinheiro, número ou porcentagem) — modelo, validação e saída tipada. */
import type { Currency } from './finance';
import { formatMoney, parseMoney } from './finance';
import { MAX_CENTS, divDec, formatDec, normalizeLocaleNumber, parseDec } from './decimal';
import { isCurrency, isSafeCents, moneyValue, numberValue, percentValue, PERIOD_RE, type FinancialRole, type Scalar } from './scalar';

export type ValueType = 'money' | 'number' | 'percentage';
export type TileDisplayMode = 'compact' | 'normal' | 'detailed';

export interface ValueTileData {
  valueType: ValueType;
  currency: Currency;
  /** Dinheiro em centavos inteiros (≥ 0 para receita/despesa; o papel define o efeito). */
  amountCents: number;
  /** Número ou porcentagem em texto decimal canônico ("15" = 15 ou 15%). */
  numericValue: string;
  financialRole: FinancialRole;
  /** Competência AAAA-MM ('' = herda do mês conectado). */
  period: string;
  category: string;
  note: string;
  displayMode: TileDisplayMode;
  /** '' = cor do papel. */
  accentColor: string;
}

export const VALUE_SIZES: Record<TileDisplayMode, { width: number; height: number }> = {
  compact: { width: 132, height: 48 },
  normal: { width: 176, height: 76 },
  detailed: { width: 220, height: 128 },
};

export const ROLE_COLORS: Record<FinancialRole, string> = { income: '#5addaa', expense: '#fb8590', neutral: '#8fb4ff' };

export function createValueData(patch: Partial<ValueTileData> = {}): ValueTileData {
  return sanitizeValue({ valueType: 'money', currency: 'BRL', amountCents: 0, numericValue: '0', financialRole: 'neutral', period: '', category: '', note: '', displayMode: 'normal', accentColor: '', ...patch });
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function sanitizeValue(raw: unknown): ValueTileData {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const role = oneOf(d.financialRole, ['income', 'expense', 'neutral'] as const, 'neutral');
  let cents = isSafeCents(d.amountCents) ? d.amountCents : 0;
  if (role !== 'neutral') cents = Math.abs(cents);
  const num = typeof d.numericValue === 'string' && parseDec(d.numericValue) !== null ? d.numericValue : '0';
  return {
    valueType: oneOf(d.valueType, ['money', 'number', 'percentage'] as const, 'money'),
    currency: isCurrency(d.currency) ? d.currency : 'BRL',
    amountCents: cents,
    numericValue: num,
    financialRole: role,
    period: typeof d.period === 'string' && PERIOD_RE.test(d.period) ? d.period : '',
    category: typeof d.category === 'string' ? d.category.slice(0, 60) : '',
    note: typeof d.note === 'string' ? d.note.slice(0, 300) : '',
    displayMode: oneOf(d.displayMode, ['compact', 'normal', 'detailed'] as const, 'normal'),
    accentColor: typeof d.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(d.accentColor) ? d.accentColor.toLowerCase() : '',
  };
}

export type ParseResult = { ok: true; patch: Partial<ValueTileData> } | { ok: false; error: string };

/** Interpreta o que o usuário digitou no bloco, conforme o tipo. Nunca aceita NaN, infinito ou fora dos limites. */
export function parseValueInput(text: string, data: Pick<ValueTileData, 'valueType' | 'financialRole'>): ParseResult {
  const raw = text.trim();
  if (!raw) return { ok: false, error: 'Digite um valor.' };
  if (data.valueType === 'money') {
    const cents = parseMoney(raw);
    if (cents === null || !Number.isSafeInteger(cents)) return { ok: false, error: 'Valor inválido. Ex.: 1.500,00' };
    if (Math.abs(cents) > Number(MAX_CENTS)) return { ok: false, error: 'Valor fora do limite permitido.' };
    if (cents < 0 && data.financialRole !== 'neutral') return { ok: false, error: 'Use o tipo Despesa em vez de valor negativo.' };
    return { ok: true, patch: { amountCents: cents } };
  }
  const norm = normalizeLocaleNumber(raw.replace(/%$/, ''));
  const d = norm === null ? null : parseDec(norm);
  if (d === null) return { ok: false, error: 'Número inválido. Ex.: 125 ou 12,5' };
  return { ok: true, patch: { numericValue: norm! } };
}

/** Texto para editar (o que aparece no campo ao entrar em edição). */
export function valueEditText(d: ValueTileData): string {
  if (d.valueType === 'money') return formatMoney(d.amountCents, d.currency, 'plain');
  return formatDec(parseDec(d.numericValue) ?? 0n, 8);
}

export function valueOutput(d: ValueTileData, ctx: { key: string; label: string }): Scalar {
  if (d.valueType === 'money') return moneyValue(d.amountCents, d.currency, { role: d.financialRole, key: ctx.key, label: ctx.label, period: d.period || undefined, category: d.category || undefined });
  const v = parseDec(d.numericValue) ?? 0n;
  return d.valueType === 'percentage' ? percentValue(divDec(v, 100n * 10n ** 8n)) : numberValue(v);
}

export function formatValueTile(d: ValueTileData): string {
  if (d.valueType === 'money') return formatMoney(d.financialRole === 'expense' ? d.amountCents : d.amountCents, d.currency);
  const v = parseDec(d.numericValue) ?? 0n;
  return d.valueType === 'percentage' ? `${formatDec(v, 4)}%` : formatDec(v, 8);
}

export const VALUE_TYPE_LABEL: Record<ValueType, string> = { money: 'Dinheiro', number: 'Número', percentage: 'Porcentagem' };

/**
 * “Converter texto em valor” (ação explícita): "Salário: R$ 3.000" → { título "Salário", 3000,00 }.
 * Retorna null se não houver exatamente um número reconhecível (não adivinha).
 */
export function parseTextToValue(text: string): { label: string; data: Partial<ValueTileData> } | null {
  const t = text.trim();
  if (!t || t.length > 200) return null;
  const re = /(R\$|US\$|€)?\s*(-?\d[\d.,]*)\s*(%)?/g;
  const matches = [...t.matchAll(re)].filter((m) => /\d/.test(m[2]));
  if (matches.length !== 1) return null;
  const m = matches[0];
  const label = (t.slice(0, m.index) + t.slice(m.index! + m[0].length)).replace(/[:=\-–]+\s*$/, '').replace(/^\s*[:=\-–]+/, '').trim();
  const numText = m[2].replace(/[.,]$/, '');
  if (m[3]) {
    const n = normalizeLocaleNumber(numText);
    return n && parseDec(n) !== null ? { label, data: { valueType: 'percentage', numericValue: n } } : null;
  }
  const cents = parseMoney(numText);
  if (cents === null || Math.abs(cents) > Number(MAX_CENTS)) return null;
  const currency: Currency = m[1] === 'US$' ? 'USD' : m[1] === '€' ? 'EUR' : 'BRL';
  return { label, data: { valueType: 'money', currency, amountCents: Math.abs(cents), financialRole: cents < 0 ? 'expense' : 'neutral' } };
}
