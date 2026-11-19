/**
 * Decimal de ponto fixo (8 casas) sobre `bigint`.
 *
 * Por que não `number`: 0,1 + 0,2 ≠ 0,3 em ponto flutuante. Aqui todo número é um inteiro escalado por 10⁸,
 * soma e subtração são exatas, e multiplicação/divisão têm UM arredondamento explícito
 * (meio para longe do zero, o “arredondamento comercial”). Dinheiro continua em centavos inteiros
 * (ver core/finance.ts); este módulo cuida de números genéricos, porcentagens e razões.
 */

export const SCALE = 8;
export const ONE = 10n ** BigInt(SCALE);
/** Limite de |x| para números genéricos: 10¹⁵. */
export const MAX_DEC = 10n ** 15n * ONE;
/** Limite de |centavos|: 10¹⁵ (≈ 10 trilhões), abaixo de Number.MAX_SAFE_INTEGER. */
export const MAX_CENTS = 10n ** 15n;

export type Dec = bigint;

/** Divisão inteira com arredondamento meio-para-longe-do-zero. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('divisão por zero');
  const neg = a < 0n !== b < 0n;
  const aa = a < 0n ? -a : a, bb = b < 0n ? -b : b;
  const q = (aa * 2n + bb) / (bb * 2n);
  return neg ? -q : q;
}

export const mulDec = (a: Dec, b: Dec): Dec => divRound(a * b, ONE);
export const divDec = (a: Dec, b: Dec): Dec => divRound(a * ONE, b);

/** "123", "-0.5", "1234.56789" (ponto decimal, sem milhar). Mais de 8 casas são arredondadas. */
export function parseDec(input: string): Dec | null {
  const s = input.trim();
  const m = /^([+-])?(\d{1,16})(?:\.(\d{1,30}))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  const head = BigInt(m[2] + frac.slice(0, SCALE).padEnd(SCALE, '0'));
  const rest = frac.slice(SCALE);
  const rounded = rest && Number(rest[0]) >= 5 ? head + 1n : head;
  const v = m[1] === '-' ? -rounded : rounded;
  return v > MAX_DEC || v < -MAX_DEC ? null : v;
}

/** Converte um `number` (ex.: saídas antigas do fluxo de dados) pela sua representação decimal mais curta. */
export function decFromNumber(n: number): Dec | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) >= 1e15) return null;
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(SCALE);
  return parseDec(s);
}

/** Representação canônica em texto (ponto decimal, sem zeros à direita). */
export function decToString(d: Dec, maxDecimals = SCALE): string {
  const r = maxDecimals < SCALE ? roundDec(d, maxDecimals) : d;
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const int = abs / ONE, frac = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg && (int > 0n || frac) ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export function roundDec(d: Dec, decimals: number): Dec {
  const k = Math.max(0, Math.min(SCALE, Math.floor(decimals)));
  const step = 10n ** BigInt(SCALE - k);
  return divRound(d, step) * step;
}

export const decToNumber = (d: Dec): number => Number(decToString(d));

export function inDecRange(d: Dec): boolean {
  return d <= MAX_DEC && d >= -MAX_DEC;
}

/** Formata em pt-BR (separador de milhar ponto, decimal vírgula) sem passar por ponto flutuante. */
export function formatDec(d: Dec, maxDecimals = 4, minDecimals = 0): string {
  const s = decToString(roundDec(d, maxDecimals));
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const f = frac.padEnd(minDecimals, '0');
  return `${neg ? '-' : ''}${grouped}${f ? ',' + f : ''}`;
}

/**
 * Normaliza número digitado em pt-BR ou en: "1.234,56", "1234.56", "1,5", "-3", "1 234,5".
 * Retorna texto com ponto decimal (para `parseDec`) ou null.
 */
export function normalizeLocaleNumber(input: string): string | null {
  let s = String(input).trim().replace(/[\s ]/g, '');
  if (!s) return null;
  let sign = '';
  if (s.startsWith('-') || s.startsWith('+')) { sign = s[0] === '-' ? '-' : ''; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let out: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    const [intPart, fracPart] = s.split(dec);
    if (s.split(dec).length > 2 || !intPart.split(thou).slice(1).every((g) => g.length === 3)) return null;
    out = intPart.split(thou).join('') + '.' + fracPart;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length > 2) {
      if (!parts.slice(1).every((g) => g.length === 3)) return null;
      out = parts.join('');
    } else out = parts[0] + '.' + parts[1];
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2) {
      if (!parts.slice(1).every((g) => g.length === 3)) return null;
      out = parts.join('');
    } else if (parts[1].length === 3 && parts[0] !== '0' && parts[0] !== '') out = parts.join(''); // "1.500" = mil e quinhentos (pt-BR), como parseMoney
    else out = s; // "12.5", "0.125" → decimal
  } else out = s;
  if (!/^\d+(\.\d+)?$/.test(out.replace(/^\./, '0.'))) return null;
  return sign + out.replace(/^\./, '0.');
}
