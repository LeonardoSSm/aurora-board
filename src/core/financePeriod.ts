/**
 * Month Tile (competência financeira). Os totais são SEMPRE derivados das entradas conectadas; nada é gravado.
 *
 * Regras:
 * - Entradas aceitas: valores monetários (Value Tiles, resultados de fórmula) e ocorrências do widget Finanças.
 * - Receita/despesa vêm do papel do valor, não do sinal. Neutros não entram em receitas/despesas (contados à parte).
 * - Moeda diferente da do mês: ignorado, com aviso na conexão (sem conversão implícita).
 * - Valor com competência declarada diferente do mês: ignorado, com aviso (os dados do valor não são alterados).
 *   Valor sem competência é associado ao mês conectado.
 * - Ocorrências do Finanças entram só se vencerem no mês (parcelas já distribuídas por expandEntry).
 * - Mesma chave de lançamento recebida duas vezes: conta uma vez, com aviso de duplicidade.
 * - Comprometimento = despesas ÷ receitas; com receitas = 0 é indefinido (null), nunca uma porcentagem falsa.
 */
import type { Currency, Occurrence } from './finance';
import { inPeriod } from './finance';
import { divRound, ONE, decToString } from './decimal';
import { isCurrency, PERIOD_RE, readScalar, type FinancialRole, type MoneyValue } from './scalar';
import type { TileDisplayMode } from './valueTile';

export interface FinancePeriodData {
  period: string;
  currency: Currency;
  displayMode: TileDisplayMode;
  showIncome: boolean;
  showExpenses: boolean;
  showBalance: boolean;
  showCommitment: boolean;
  showCategories: boolean;
}

export const PERIOD_SIZES: Record<TileDisplayMode, { width: number; height: number }> = {
  compact: { width: 160, height: 64 },
  normal: { width: 220, height: 150 },
  detailed: { width: 260, height: 250 },
};

export function sanitizePeriod(raw: unknown, fallbackPeriod = '2027-01'): FinancePeriodData {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const b = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    period: typeof d.period === 'string' && PERIOD_RE.test(d.period) ? d.period : fallbackPeriod,
    currency: isCurrency(d.currency) ? d.currency : 'BRL',
    displayMode: d.displayMode === 'compact' || d.displayMode === 'detailed' ? d.displayMode : 'normal',
    showIncome: b(d.showIncome, true),
    showExpenses: b(d.showExpenses, true),
    showBalance: b(d.showBalance, true),
    showCommitment: b(d.showCommitment, true),
    showCategories: b(d.showCategories, true),
  };
}

/** Ocorrências do widget Finanças transmitidas a um mês (porta `occurrences`). */
export interface OccurrenceSet {
  t: 'occurrences';
  sourceId: string;
  source: string;
  currency: Currency;
  items: Occurrence[];
}

export interface PeriodSummary {
  t: 'period';
  period: string;
  label: string;
  currency: Currency;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  neutralCents: number;
  /** Fração em texto decimal (0.504 = 50,4%) ou null quando não há receitas. */
  commitment: string | null;
  count: number;
  byCategory: { category: string; incomeCents: number; expenseCents: number }[];
}

export type PeriodIssueStatus = 'currency' | 'duplicate' | 'period' | 'incompatible';
export interface PeriodIssue { edgeId: string; status: PeriodIssueStatus; message: string }

export interface PeriodEntry { key: string; label: string; role: FinancialRole; cents: number; category: string; source: string; edgeId: string }

export interface PeriodReport { summary: PeriodSummary; entries: PeriodEntry[]; issues: PeriodIssue[] }

export interface PeriodInput { value: unknown; edgeId: string; sourceId: string; sourceTitle: string }

export function isOccurrenceSet(v: unknown): v is OccurrenceSet {
  return !!v && typeof v === 'object' && (v as OccurrenceSet).t === 'occurrences' && Array.isArray((v as OccurrenceSet).items);
}

export function computePeriod(data: FinancePeriodData, inputs: PeriodInput[], label: string): PeriodReport {
  const issues: PeriodIssue[] = [];
  const entries: PeriodEntry[] = [];
  const seen = new Set<string>();
  const add = (e: PeriodEntry) => {
    if (seen.has(e.key)) {
      issues.push({ edgeId: e.edgeId, status: 'duplicate', message: `“${e.label}” já foi contado neste mês (lançamento repetido ignorado).` });
      return;
    }
    seen.add(e.key);
    entries.push(e);
  };

  for (const inp of inputs) {
    if (isOccurrenceSet(inp.value)) {
      const set = inp.value;
      if (set.currency !== data.currency) {
        issues.push({ edgeId: inp.edgeId, status: 'currency', message: `“${set.source}” está em ${set.currency}; este mês usa ${data.currency} (sem conversão automática).` });
        continue;
      }
      for (const o of set.items) {
        if (!inPeriod(o, data.period) || !o.date) continue;
        add({ key: `${set.sourceId}:${o.entryId}:${o.index}`, label: o.count > 1 ? `${o.description} (${o.index}/${o.count})` : o.description, role: o.kind, cents: Math.abs(Math.round(o.amountCents)), category: o.category, source: set.source, edgeId: inp.edgeId });
      }
      continue;
    }
    const s = readScalar(inp.value);
    if (!s || s.t !== 'money') {
      issues.push({ edgeId: inp.edgeId, status: 'incompatible', message: `“${inp.sourceTitle}” não é um valor monetário.` });
      continue;
    }
    const m = s as MoneyValue;
    if (m.currency !== data.currency) {
      issues.push({ edgeId: inp.edgeId, status: 'currency', message: `“${inp.sourceTitle}” está em ${m.currency}; este mês usa ${data.currency} (sem conversão automática).` });
      continue;
    }
    if (m.period && m.period !== data.period) {
      issues.push({ edgeId: inp.edgeId, status: 'period', message: `“${inp.sourceTitle}” tem competência ${m.period}, diferente deste mês (${data.period}); não foi somado.` });
      continue;
    }
    add({ key: m.key ?? `${inp.sourceId}:${inp.edgeId}`, label: m.label ?? inp.sourceTitle, role: m.role ?? 'neutral', cents: m.cents, category: m.category ?? '', source: inp.sourceTitle, edgeId: inp.edgeId });
  }

  let income = 0, expense = 0, neutral = 0;
  const cats = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const e of entries) {
    if (e.role === 'neutral') { neutral += e.cents; continue; }
    const name = e.category || 'Sem categoria';
    const c = cats.get(name) ?? { incomeCents: 0, expenseCents: 0 };
    if (e.role === 'income') { income += e.cents; c.incomeCents += e.cents; } else { expense += Math.abs(e.cents); c.expenseCents += Math.abs(e.cents); }
    cats.set(name, c);
  }
  const commitment = income > 0 ? decToString(divRound(BigInt(expense) * ONE, BigInt(income))) : null;
  return {
    summary: {
      t: 'period',
      period: data.period,
      label,
      currency: data.currency,
      incomeCents: income,
      expenseCents: expense,
      balanceCents: income - expense,
      neutralCents: neutral,
      commitment,
      count: entries.length,
      byCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.expenseCents + b.incomeCents - (a.expenseCents + a.incomeCents)),
    },
    entries,
    issues,
  };
}

export function isPeriodSummary(v: unknown): v is PeriodSummary {
  return !!v && typeof v === 'object' && (v as PeriodSummary).t === 'period' && typeof (v as PeriodSummary).balanceCents === 'number';
}
