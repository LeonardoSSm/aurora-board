/**
 * Parsing estrito de valores e datas de extratos bancários.
 *
 * Diferente de `parseMoney` (entrada digitada, com heurísticas), aqui o separador decimal é decidido por
 * ARQUIVO (detectado nas amostras ou escolhido pelo usuário) e qualquer ambiguidade é recusada:
 * nunca `parseFloat`, nunca adivinhar centavos.
 */
import { MAX_CENTS, isValidDate } from './model';

export type DecimalSep = ',' | '.';

/**
 * "1.234,56", "-1.234,56", "(1.234,56)", "R$ 1.234,56", "1234,5", "1234" (sep ','), "1,234.56" (sep '.').
 * Também aceita sinal no fim ("123,45-") e marcadores "D"/"C" ("123,45 D" = débito).
 * Retorna centavos inteiros com sinal, ou null.
 */
export function parseBankAmount(input: string, decimalSep: DecimalSep): number | null {
  let s = String(input ?? '').trim();
  if (!s || s.length > 40) return null;
  let negative = false;
  // Marcadores de débito/crédito usados por alguns bancos.
  const dc = /\s*([DC])$/i.exec(s);
  if (dc) { negative = dc[1].toUpperCase() === 'D'; s = s.slice(0, dc.index).trim(); }
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^(R\$|US\$|\$|€|BRL|USD|EUR)\s*/i, '').replace(/\s*(R\$|BRL|USD|EUR)$/i, '').trim();
  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) s = s.slice(1).trim();
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/^(R\$|US\$|\$|€)\s*/i, '');
  s = s.replace(/[\s ]/g, '');
  if (!s) return null;
  const thou = decimalSep === ',' ? '.' : ',';
  if (!/^[\d.,]+$/.test(s)) return null;
  const parts = s.split(decimalSep);
  if (parts.length > 2) return null;
  const [intRaw, frac = ''] = parts;
  if (parts.length === 2 && !/^\d{1,2}$/.test(frac)) return null; // mais de 2 casas ou vazio: recusa
  if (intRaw.includes(decimalSep)) return null;
  let int = intRaw;
  if (int.includes(thou)) {
    const groups = int.split(thou);
    if (!groups[0] || groups[0].length > 3 || !groups.slice(1).every((g) => g.length === 3)) return null;
    int = groups.join('');
  }
  if (!/^\d+$/.test(int || '0')) return null;
  const intN = BigInt(int || '0');
  const cents = intN * 100n + BigInt((frac + '00').slice(0, 2));
  if (cents > BigInt(MAX_CENTS)) return null;
  const n = Number(cents);
  return negative ? (n === 0 ? 0 : -n) : n;
}

/**
 * Detecta o separador decimal pelas amostras. Regras: última vírgula/ponto seguida de 1–2 dígitos no fim
 * indica o decimal; grupos de exatamente 3 dígitos são ambíguos ("1.234" pode ser mil ou 1,234).
 * Retorna null se as amostras não decidirem (a interface pede ao usuário).
 */
export function detectDecimalSeparator(samples: string[]): DecimalSep | null {
  let comma = 0, dot = 0;
  for (const raw of samples) {
    const s = String(raw ?? '').replace(/[^\d.,]/g, '');
    const m = /([.,])(\d{1,2})$/.exec(s);
    if (m) { if (m[1] === ',') comma++; else dot++; continue; }
    // "1.234,5" e "1,234.5" já cobertos; "1.234.567" = milhar com ponto → decimal provavelmente vírgula.
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) comma++;
    else if (/^\d{1,3}(,\d{3}){2,}$/.test(s)) dot++;
  }
  if (comma && !dot) return ',';
  if (dot && !comma) return '.';
  if (comma > dot * 4) return ',';
  if (dot > comma * 4) return '.';
  return null;
}

export type DateOrder = 'dmy' | 'ymd' | 'mdy';

/**
 * Datas de extrato sem fuso: "31/12/2026", "31-12-2026", "31.12.26", "2026-12-31", "20261231",
 * "2026-12-31T10:00:00" (a hora é ignorada; a data civil é preservada). Retorna AAAA-MM-DD válido ou null.
 */
export function parseBankDate(input: string, order: DateOrder = 'dmy'): string | null {
  const s = String(input ?? '').trim();
  if (!s || s.length > 40) return null;
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6}(?:\.\d+)?)?(?:\[.*\])?$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(s))) {
    const a = +r[1], b = +r[2];
    let yy = +r[3];
    if (r[3].length === 2) yy += yy >= 70 ? 1900 : 2000;
    if (order === 'mdy') { m = a; d = b; } else { d = a; m = b; }
    y = yy;
  } else if ((r = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else return null;
  const out = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidDate(out) ? out : null;
}

/** Ordem de data mais provável: se algum primeiro campo > 12 → dmy; se algum segundo > 12 → mdy; senão dmy (padrão BR). */
export function detectDateOrder(samples: string[]): DateOrder {
  let dmy = false, mdy = false;
  for (const s of samples) {
    const r = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(String(s ?? '').trim());
    if (!r) continue;
    if (+r[1] > 12) dmy = true;
    if (+r[2] > 12) mdy = true;
  }
  if (mdy && !dmy) return 'mdy';
  return 'dmy';
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Diferença em dias entre duas datas AAAA-MM-DD (b − a), sem fuso. */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}
