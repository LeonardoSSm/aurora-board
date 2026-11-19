/**
 * Motor de fórmulas do Aurora Board.
 *
 * Tokenizador → parser descendente recursivo (AST) → avaliador tipado. Nenhum `eval`, `new Function`
 * ou acesso a objetos globais: só os operadores e funções listados aqui existem.
 *
 * Gramática (ver docs/FORMULA_ENGINE.md):
 *   formula  := '='? expr
 *   expr     := term (('+' | '-') term)*
 *   term     := unary (('*' | '/') unary)*
 *   unary    := ('-' | '+') unary | postfix
 *   postfix  := primary '%'?
 *   primary  := número | nome '(' args? ')' | nome | '(' expr ')'
 *   args     := expr ((',' | ';') expr)*
 * Números usam ponto decimal (0.20). Argumentos separados por vírgula ou ponto e vírgula.
 *
 * Tipos: dinheiro (centavos inteiros + moeda), número e porcentagem (decimal de 8 casas).
 * Arredondamento: um único arredondamento explícito por multiplicação/divisão, meio para longe do zero.
 */
import type { Currency } from './finance';
import { divDec, divRound, inDecRange, MAX_CENTS, mulDec, ONE, parseDec, roundDec, SCALE, type Dec } from './decimal';
import { moneyValue, normalizeName, numberValue, percentValue, readScalar, scalarDec, type Scalar } from './scalar';

export const MAX_FORMULA_LENGTH = 1000;
const MAX_NODES = 400;
const MAX_DEPTH = 40;

export class FormulaError extends Error {
  constructor(public code: 'syntax' | 'unknown-variable' | 'unknown-function' | 'type' | 'currency' | 'div-zero' | 'range' | 'limit' | 'empty' | 'args', message: string, public pos?: number) {
    super(message);
  }
}

type Tok = { k: 'num'; v: string; pos: number } | { k: 'id'; v: string; pos: number } | { k: 'op'; v: string; pos: number } | { k: 'end'; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(i))!;
      let lit = m[0];
      if (lit.endsWith('.')) lit = lit.slice(0, -1);
      out.push({ k: 'num', v: lit, pos: i });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/()%,;'.includes(c)) { out.push({ k: 'op', v: c, pos: i }); i++; continue; }
    throw new FormulaError('syntax', `Caractere não permitido: “${c}”.`, i);
  }
  out.push({ k: 'end', pos: src.length });
  return out;
}

export type Node =
  | { k: 'num'; v: Dec }
  | { k: 'var'; name: string; pos: number }
  | { k: 'neg'; e: Node }
  | { k: 'pct'; e: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[]; pos: number };

export function parseFormula(input: string): Node {
  const src = input.trim().replace(/^=/, '');
  if (input.length > MAX_FORMULA_LENGTH) throw new FormulaError('limit', `Fórmula longa demais (máximo ${MAX_FORMULA_LENGTH} caracteres).`);
  if (!src.trim()) throw new FormulaError('empty', 'Fórmula vazia.');
  const toks = tokenize(src);
  let p = 0, nodes = 0;
  const peek = () => toks[p];
  const node = <T extends Node>(n: T): T => {
    if (++nodes > MAX_NODES) throw new FormulaError('limit', 'Fórmula complexa demais.');
    return n;
  };
  const expectOp = (v: string) => {
    const t = peek();
    if (t.k !== 'op' || t.v !== v) throw new FormulaError('syntax', t.k === 'end' ? `Faltou “${v}” no fim da fórmula.` : `Esperava “${v}” na posição ${t.pos + 1}.`, t.pos);
    p++;
  };
  const expr = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new FormulaError('limit', 'Parênteses aninhados demais.');
    let a = term(depth);
    for (let t = peek(); t.k === 'op' && (t.v === '+' || t.v === '-'); t = peek()) { p++; a = node({ k: 'bin', op: t.v as '+' | '-', a, b: term(depth) }); }
    return a;
  };
  const term = (depth: number): Node => {
    let a = unary(depth);
    for (let t = peek(); t.k === 'op' && (t.v === '*' || t.v === '/'); t = peek()) { p++; a = node({ k: 'bin', op: t.v as '*' | '/', a, b: unary(depth) }); }
    return a;
  };
  const unary = (depth: number): Node => {
    const t = peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) {
      p++;
      if (depth > MAX_DEPTH) throw new FormulaError('limit', 'Sinais aninhados demais.');
      const e = unary(depth + 1);
      return t.v === '-' ? node({ k: 'neg', e }) : e;
    }
    return postfix(depth);
  };
  const postfix = (depth: number): Node => {
    let e = primary(depth);
    while (peek().k === 'op' && (peek() as { v: string }).v === '%') { p++; e = node({ k: 'pct', e }); }
    return e;
  };
  const primary = (depth: number): Node => {
    const t = peek();
    if (t.k === 'num') {
      p++;
      const v = parseDec(t.v);
      if (v === null) throw new FormulaError('range', `Número inválido ou fora do limite: ${t.v}.`, t.pos);
      return node({ k: 'num', v });
    }
    if (t.k === 'id') {
      p++;
      if (peek().k === 'op' && (peek() as { v: string }).v === '(') {
        p++;
        const args: Node[] = [];
        if (!(peek().k === 'op' && (peek() as { v: string }).v === ')')) {
          args.push(expr(depth + 1));
          while (peek().k === 'op' && [',', ';'].includes((peek() as { v: string }).v)) { p++; args.push(expr(depth + 1)); }
        }
        expectOp(')');
        return node({ k: 'call', fn: t.v, args, pos: t.pos });
      }
      return node({ k: 'var', name: t.v, pos: t.pos });
    }
    if (t.k === 'op' && t.v === '(') {
      p++;
      const e = expr(depth + 1);
      expectOp(')');
      return e;
    }
    if (t.k === 'end') throw new FormulaError('syntax', 'A fórmula terminou antes do esperado.', t.pos);
    throw new FormulaError('syntax', `Não esperava “${t.v}” na posição ${t.pos + 1}.`, t.pos);
  };
  const root = expr(0);
  const rest = peek();
  if (rest.k !== 'end') {
    const hint = rest.k === 'op' && rest.v === ',' ? ' Para decimais use ponto (ex.: 0.20).' : '';
    throw new FormulaError('syntax', `Sobrou “${rest.k === 'op' || rest.k === 'id' || rest.k === 'num' ? rest.v : ''}” na posição ${rest.pos + 1}.${hint}`, rest.pos);
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* Avaliação                                                           */
/* ------------------------------------------------------------------ */

type V = { t: 'money'; c: bigint; cur: Currency } | { t: 'number'; d: Dec } | { t: 'percent'; d: Dec };

export const FUNCTIONS: { name: string; aliases: string[]; signature: string; description: string }[] = [
  { name: 'SOMA', aliases: ['SUM'], signature: 'SOMA(a, b, …)', description: 'Soma os valores.' },
  { name: 'MEDIA', aliases: ['MÉDIA', 'AVERAGE'], signature: 'MEDIA(a, b, …)', description: 'Média aritmética.' },
  { name: 'MINIMO', aliases: ['MÍNIMO', 'MIN'], signature: 'MINIMO(a, b, …)', description: 'Menor valor.' },
  { name: 'MAXIMO', aliases: ['MÁXIMO', 'MAX'], signature: 'MAXIMO(a, b, …)', description: 'Maior valor.' },
  { name: 'ABS', aliases: [], signature: 'ABS(x)', description: 'Valor absoluto.' },
  { name: 'ARRED', aliases: ['ARREDONDAR', 'ROUND'], signature: 'ARRED(x, casas)', description: 'Arredonda (meio para longe do zero).' },
];
const FN_INDEX = new Map<string, string>();
for (const f of FUNCTIONS) for (const n of [f.name, ...f.aliases]) FN_INDEX.set(normalizeName(n).toUpperCase(), f.name);

const toCents = (d: Dec): bigint => divRound(d * 100n, ONE);
const KIND = { money: 'dinheiro', number: 'número', percent: 'porcentagem' } as const;

function check(v: V): V {
  if (v.t === 'money' ? v.c > MAX_CENTS || v.c < -MAX_CENTS : !inDecRange(v.d)) throw new FormulaError('range', 'Resultado fora dos limites permitidos.');
  return v;
}

function sameCurrency(a: { cur: Currency }, b: { cur: Currency }) {
  if (a.cur !== b.cur) throw new FormulaError('currency', `Moedas incompatíveis: ${a.cur} e ${b.cur} (não há conversão automática).`);
}

function add(a: V, b: V, sign: 1n | -1n): V {
  if (a.t === 'money' && b.t === 'money') { sameCurrency(a, b); return check({ t: 'money', c: a.c + sign * b.c, cur: a.cur }); }
  if (a.t === 'money' || b.t === 'money') {
    const m = (a.t === 'money' ? a : b) as Extract<V, { t: 'money' }>;
    const o = (a.t === 'money' ? b : a) as Extract<V, { t: 'number' | 'percent' }>;
    if (o.t === 'percent') throw new FormulaError('type', 'Não dá para somar porcentagem a dinheiro. Use, por exemplo, valor * 10%.');
    const oc = toCents(o.d);
    return check({ t: 'money', c: a.t === 'money' ? m.c + sign * oc : oc + sign * m.c, cur: m.cur });
  }
  const t = a.t === 'percent' && b.t === 'percent' ? 'percent' : 'number';
  return check({ t, d: a.d + sign * b.d });
}

function mul(a: V, b: V): V {
  if (a.t === 'money' && b.t === 'money') throw new FormulaError('type', 'Não dá para multiplicar dinheiro por dinheiro.');
  if (a.t === 'money' || b.t === 'money') {
    const m = (a.t === 'money' ? a : b) as Extract<V, { t: 'money' }>;
    const o = (a.t === 'money' ? b : a) as Extract<V, { t: 'number' | 'percent' }>;
    return check({ t: 'money', c: divRound(m.c * o.d, ONE), cur: m.cur });
  }
  const t = a.t === 'percent' && b.t === 'percent' ? 'percent' : 'number';
  return check({ t, d: mulDec(a.d, b.d) });
}

function div(a: V, b: V): V {
  const isZero = b.t === 'money' ? b.c === 0n : b.d === 0n;
  if (isZero) throw new FormulaError('div-zero', 'Divisão por zero.');
  if (a.t === 'money' && b.t === 'money') { sameCurrency(a, b); return check({ t: 'number', d: divRound(a.c * ONE, b.c) }); }
  if (a.t === 'money') return check({ t: 'money', c: divRound(a.c * ONE, (b as { d: Dec }).d), cur: a.cur });
  if (b.t === 'money') throw new FormulaError('type', `Não dá para dividir ${KIND[a.t]} por dinheiro.`);
  const t = a.t === 'percent' && b.t !== 'percent' ? 'percent' : 'number';
  return check({ t, d: divDec(a.d, b.d) });
}

function compare(a: V, b: V): number {
  if (a.t === 'money' && b.t === 'money') { sameCurrency(a, b); return a.c === b.c ? 0 : a.c < b.c ? -1 : 1; }
  if (a.t === 'money' || b.t === 'money') throw new FormulaError('type', 'Não dá para comparar dinheiro com número.');
  return a.d === b.d ? 0 : a.d < b.d ? -1 : 1;
}

function callFn(name: string, args: V[], pos: number): V {
  const fn = FN_INDEX.get(normalizeName(name).toUpperCase());
  if (!fn) throw new FormulaError('unknown-function', `Função desconhecida: ${name}. Disponíveis: ${FUNCTIONS.map((f) => f.name).join(', ')}.`, pos);
  const need = (n: number, max = n) => {
    if (args.length < n || args.length > max) throw new FormulaError('args', `${fn} recebe ${n === max ? n : `${n} a ${max}`} argumento(s).`, pos);
  };
  switch (fn) {
    case 'SOMA':
      if (!args.length) throw new FormulaError('args', 'SOMA precisa de pelo menos um valor.', pos);
      return args.slice(1).reduce((acc, v) => add(acc, v, 1n), args[0]);
    case 'MEDIA': {
      if (!args.length) throw new FormulaError('args', 'MEDIA precisa de pelo menos um valor.', pos);
      const s = args.slice(1).reduce((acc, v) => add(acc, v, 1n), args[0]);
      const n = BigInt(args.length);
      return s.t === 'money' ? { t: 'money', c: divRound(s.c, n), cur: s.cur } : { ...s, d: divRound(s.d, n) };
    }
    case 'MINIMO':
    case 'MAXIMO': {
      if (!args.length) throw new FormulaError('args', `${fn} precisa de pelo menos um valor.`, pos);
      return args.reduce((best, v) => ((fn === 'MINIMO' ? compare(v, best) < 0 : compare(v, best) > 0) ? v : best));
    }
    case 'ABS': {
      need(1);
      const v = args[0];
      return v.t === 'money' ? { ...v, c: v.c < 0n ? -v.c : v.c } : { ...v, d: v.d < 0n ? -v.d : v.d };
    }
    case 'ARRED': {
      need(1, 2);
      const v = args[0];
      let casas = v.t === 'money' ? 2 : 0;
      if (args[1]) {
        const c = args[1];
        if (c.t !== 'number' || c.d % ONE !== 0n || c.d < 0n || c.d > BigInt(SCALE) * ONE) throw new FormulaError('args', `ARRED: casas deve ser um inteiro de 0 a ${SCALE}.`, pos);
        casas = Number(c.d / ONE);
      }
      if (v.t === 'money') {
        if (casas >= 2) return v;
        const step = 10n ** BigInt(2 - casas);
        return { ...v, c: divRound(v.c, step) * step };
      }
      return { ...v, d: roundDec(v.d, v.t === 'percent' ? casas + 2 : casas) };
    }
  }
  throw new FormulaError('unknown-function', `Função desconhecida: ${name}.`, pos);
}

function toV(s: Scalar): V {
  if (s.t === 'money') return { t: 'money', c: BigInt(s.cents), cur: s.currency };
  return { t: s.t, d: scalarDec(s) };
}

function fromV(v: V): Scalar {
  if (v.t === 'money') return moneyValue(Number(v.c), v.cur);
  return v.t === 'percent' ? percentValue(v.d) : numberValue(v.d);
}

/** Uma variável disponível para a fórmula: nome lógico (da conexão) → valor recebido. */
export interface FormulaVariable { name: string; value: unknown; source: string; edgeId: string }

export type FormulaResult =
  | { ok: true; value: Scalar; used: string[] }
  | { ok: false; error: FormulaError; used: string[] };

export function evaluateFormula(expression: string, variables: FormulaVariable[]): FormulaResult {
  const used: string[] = [];
  try {
    const ast = parseFormula(expression);
    const vars = new Map<string, FormulaVariable>();
    for (const v of variables) vars.set(normalizeName(v.name), v);
    const ev = (n: Node): V => {
      switch (n.k) {
        case 'num': return { t: 'number', d: n.v };
        case 'var': {
          const v = vars.get(normalizeName(n.name));
          if (!v) throw new FormulaError('unknown-variable', `Variável desconhecida: “${n.name}”. Conecte um valor ou confira o nome da entrada.`, n.pos);
          const s = readScalar(v.value);
          if (!s) throw new FormulaError('unknown-variable', `“${n.name}” (de ${v.source}) não tem um valor numérico válido.`, n.pos);
          if (!used.includes(v.name)) used.push(v.name);
          return toV(s);
        }
        case 'neg': {
          const v = ev(n.e);
          return v.t === 'money' ? { ...v, c: -v.c } : { ...v, d: -v.d };
        }
        case 'pct': {
          const v = ev(n.e);
          if (v.t !== 'number') throw new FormulaError('type', `“%” só se aplica a números (não a ${KIND[v.t]}).`);
          return { t: 'percent', d: divRound(v.d, 100n) };
        }
        case 'bin': {
          const a = ev(n.a), b = ev(n.b);
          if (n.op === '+') return add(a, b, 1n);
          if (n.op === '-') return add(a, b, -1n);
          if (n.op === '*') return mul(a, b);
          return div(a, b);
        }
        case 'call': return callFn(n.fn, n.args.map(ev), n.pos);
      }
    };
    return { ok: true, value: fromV(check(ev(ast))), used };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e, used };
    if (e instanceof RangeError) return { ok: false, error: new FormulaError('div-zero', 'Divisão por zero.'), used };
    return { ok: false, error: new FormulaError('syntax', 'Fórmula inválida.'), used };
  }
}

/** Modelos prontos (inserção rápida). */
export const FORMULA_TEMPLATES: { id: string; label: string; expression: string; hint: string }[] = [
  { id: 'balance', label: 'Receitas menos despesas', expression: '=receitas - despesas', hint: 'Conecte as saídas “Receitas” e “Despesas” de um mês.' },
  { id: 'commitment', label: 'Comprometimento (%)', expression: '=despesas / receitas * 100', hint: 'Despesas sobre receitas.' },
  { id: 'sum', label: 'Soma de saldos', expression: '=SOMA(janeiro, fevereiro)', hint: 'Conecte os meses (saída Saldo) e ajuste os nomes.' },
  { id: 'diff', label: 'Diferença entre meses', expression: '=fevereiro - janeiro', hint: 'Variação de um mês para o outro.' },
  { id: 'avg', label: 'Média de valores', expression: '=MEDIA(janeiro, fevereiro, marco)', hint: 'Média dos valores conectados.' },
  { id: 'share', label: 'Percentual de um valor', expression: '=salario * 20%', hint: 'Ex.: reserva de 20% do salário.' },
];
