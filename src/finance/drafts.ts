/** Transação normalizada vinda de um arquivo ou provedor, ainda não gravada (entrada do planejador). */
import type { Currency } from '../core/finance';

export interface TransactionDraft {
  /** Linha/posição na fonte, para mensagens. */
  line: number;
  externalId?: string;
  postedDate: string;
  operationDate?: string;
  description: string;
  memo?: string;
  amountCents: number;
  currency?: Currency;
  rawType?: string;
  status: 'posted' | 'pending';
  reference?: string;
  /** Categoria sugerida pela fonte (apenas dica; vira classificação local). */
  categoryHint?: string;
  installment?: { index: number; count: number };
}

export interface InvalidRow {
  line: number;
  reason: string;
}

export interface IgnoredRow {
  line: number;
  reason: string;
}

export interface ParsedStatement {
  format: 'csv' | 'ofx';
  drafts: TransactionDraft[];
  invalid: InvalidRow[];
  ignored: IgnoredRow[];
  warnings: string[];
  /** Dados da conta informados pela fonte (OFX), se houver. */
  account?: {
    institutionCode?: string;
    institutionName?: string;
    maskedNumber?: string;
    kind: 'bank' | 'card';
    acctType?: string;
    currency?: Currency;
  };
  reportedBalance?: { cents: number; asOf: string; availableCents?: number };
  range?: { from: string; to: string };
}

export function rangeOf(drafts: { postedDate: string }[]): { from: string; to: string } | undefined {
  if (!drafts.length) return undefined;
  let from = drafts[0].postedDate, to = from;
  for (const d of drafts) {
    if (d.postedDate < from) from = d.postedDate;
    if (d.postedDate > to) to = d.postedDate;
  }
  return { from, to };
}
