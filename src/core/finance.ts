/**
 * Regras financeiras do Aurora Board.
 *
 * Regras definidas (documentadas e testadas em tests/unit/finance.test.ts):
 * 1. Valores são armazenados em CENTAVOS inteiros (sem erro de ponto flutuante).
 * 2. `amountCents` é sempre positivo; o sinal vem de `kind` (income = receita, expense = despesa).
 * 3. Parcelamento "split": o valor total é dividido em N parcelas; centavos restantes vão para as primeiras.
 *    Parcelamento "repeat": o valor informado é de cada parcela (total = valor × N).
 *    Parcelas vencem mensalmente a partir da data do lançamento (dia ajustado ao fim do mês).
 * 4. Período: "all" considera todas as parcelas; "AAAA-MM" considera somente parcelas com vencimento no mês.
 *    Lançamentos sem data entram apenas no período "all".
 * 5. Saldo previsto = entradas recebidas por conexão + receitas − despesas.
 *    Saldo realizado = entradas por conexão + receitas pagas − despesas pagas.
 * 6. Entradas por conexão (fluxo de dados) com moeda diferente NÃO são somadas: geram aviso (sem conversão implícita).
 */

export type Currency = 'BRL' | 'USD' | 'EUR';
export type MoneyFormat = 'currency' | 'compact' | 'plain';

export interface FinanceEntry {
  id: string;
  description: string;
  amountCents: number;
  kind: 'income' | 'expense';
  category: string;
  date: string;
  paid: boolean;
  installments: number;
  installmentMode: 'split' | 'repeat';
}

export interface FinanceData {
  currency: Currency;
  entries: FinanceEntry[];
  period: string;
  format: MoneyFormat;
  includeInputs: boolean;
}

export interface FinanceSummary {
  currency: Currency;
  source: string;
  incomeCents: number;
  expenseCents: number;
  inputCents: number;
  balanceCents: number;
  realizedCents: number;
  pendingCents: number;
}

export interface Occurrence {
  entryId: string;
  description: string;
  kind: 'income' | 'expense';
  category: string;
  date: string;
  paid: boolean;
  index: number;
  count: number;
  amountCents: number;
}

export interface FinanceReport {
  summary: FinanceSummary;
  occurrences: Occurrence[];
  byCategory: { category: string; incomeCents: number; expenseCents: number }[];
  inputs: { source: string; cents: number }[];
  warnings: string[];
}

export function emptyFinance(currency: Currency = 'BRL'): FinanceData {
  return { currency, entries: [], period: 'all', format: 'currency', includeInputs: true };
}

/** Converte texto digitado em centavos. Aceita "1.234,56", "1234.56", "-125,50", "R$ 10". */
export function parseMoney(input: string): number | null {
  let s = String(input).trim().replace(/[R$€US\s]/g, '');
  if (!s) return null;
  const negative = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  s = s.replace(/[-()+]/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    normalized = s.split(thouSep).join('').replace(decSep, '.');
  } else if (lastComma >= 0) {
    normalized = s.split('.').join('').replace(/,(?=[^,]*$)/, '.').replace(/,/g, '');
  } else if (lastDot >= 0) {
    // "1.234" ou "1.234.567" => separador de milhar (padrão pt-BR); "12.5" / "0.125" => decimal.
    const parts = s.split('.');
    if (parts.length > 2) {
      if (!parts.slice(1).every((p) => p.length === 3)) return null;
      normalized = parts.join('');
    } else if (parts[1].length === 3 && parts[0] !== '0' && parts[0] !== '') normalized = parts.join('');
    else normalized = s;
  } else normalized = s;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [int, frac = ''] = normalized.split('.');
  const cents = Number(int) * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

const LOCALES: Record<Currency, string> = { BRL: 'pt-BR', USD: 'en-US', EUR: 'de-DE' };

export function formatMoney(cents: number, currency: Currency = 'BRL', format: MoneyFormat = 'currency'): string {
  const value = cents / 100;
  if (format === 'plain') return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  if (format === 'compact')
    return new Intl.NumberFormat(LOCALES[currency], { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat(LOCALES[currency], { style: 'currency', currency }).format(value);
}

function addMonths(date: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]) - 1 + months, d = Number(m[3]);
  const year = y + Math.floor(mo / 12), month = ((mo % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function expandEntry(entry: FinanceEntry): Occurrence[] {
  const n = Math.max(1, Math.floor(entry.installments || 1));
  const amount = Math.abs(Math.round(entry.amountCents));
  const out: Occurrence[] = [];
  const base = entry.installmentMode === 'repeat' ? amount : Math.floor(amount / n);
  const remainder = entry.installmentMode === 'repeat' ? 0 : amount - base * n;
  for (let i = 0; i < n; i++) {
    out.push({
      entryId: entry.id,
      description: entry.description,
      kind: entry.kind,
      category: entry.category || 'Sem categoria',
      date: entry.date ? addMonths(entry.date, i) : '',
      // Parcelamento: apenas a primeira parcela herda o status "pago" do lançamento.
      paid: n === 1 ? entry.paid : entry.paid && i === 0,
      index: i + 1,
      count: n,
      amountCents: base + (i < remainder ? 1 : 0),
    });
  }
  return out;
}

export function inPeriod(o: Occurrence, period: string): boolean {
  if (!period || period === 'all') return true;
  return !!o.date && o.date.startsWith(period);
}

export function computeFinance(data: FinanceData, inputs: FinanceSummary[] = [], source = ''): FinanceReport {
  const warnings: string[] = [];
  const occurrences = data.entries.flatMap(expandEntry).filter((o) => inPeriod(o, data.period));
  let income = 0, expense = 0, paidIncome = 0, paidExpense = 0;
  const cats = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const o of occurrences) {
    const c = cats.get(o.category) ?? { incomeCents: 0, expenseCents: 0 };
    if (o.kind === 'income') { income += o.amountCents; c.incomeCents += o.amountCents; if (o.paid) paidIncome += o.amountCents; }
    else { expense += o.amountCents; c.expenseCents += o.amountCents; if (o.paid) paidExpense += o.amountCents; }
    cats.set(o.category, c);
  }
  let inputCents = 0;
  const acceptedInputs: { source: string; cents: number }[] = [];
  if (data.includeInputs) {
    for (const inp of inputs) {
      if (inp.currency !== data.currency) {
        warnings.push(`Entrada de "${inp.source}" em ${inp.currency} ignorada: este bloco usa ${data.currency}.`);
        continue;
      }
      inputCents += inp.balanceCents;
      acceptedInputs.push({ source: inp.source, cents: inp.balanceCents });
    }
  }
  const balance = inputCents + income - expense;
  const realized = inputCents + paidIncome - paidExpense;
  return {
    summary: {
      currency: data.currency,
      source,
      incomeCents: income,
      expenseCents: expense,
      inputCents,
      balanceCents: balance,
      realizedCents: realized,
      pendingCents: balance - realized,
    },
    occurrences,
    byCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.expenseCents + b.incomeCents - (a.expenseCents + a.incomeCents)),
    inputs: acceptedInputs,
    warnings,
  };
}

/** Saneia dados vindos de importação ou versões anteriores. */
export function sanitizeFinance(raw: unknown): FinanceData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<FinanceData>;
  const currency: Currency = d.currency === 'USD' || d.currency === 'EUR' ? d.currency : 'BRL';
  const entries = Array.isArray(d.entries)
    ? d.entries
        .filter((e): e is FinanceEntry => !!e && typeof e === 'object')
        .map((e) => ({
          id: String(e.id ?? Math.random().toString(36).slice(2)),
          description: String(e.description ?? ''),
          amountCents: Math.abs(Math.round(Number(e.amountCents) || 0)),
          kind: e.kind === 'income' ? ('income' as const) : ('expense' as const),
          category: String(e.category ?? ''),
          date: typeof e.date === 'string' ? e.date : '',
          paid: !!e.paid,
          installments: Math.max(1, Math.min(360, Math.floor(Number(e.installments) || 1))),
          installmentMode: e.installmentMode === 'repeat' ? ('repeat' as const) : ('split' as const),
        }))
    : [];
  return {
    currency,
    entries,
    period: typeof d.period === 'string' ? d.period : 'all',
    format: d.format === 'compact' || d.format === 'plain' ? d.format : 'currency',
    includeInputs: d.includeInputs !== false,
  };
}
