/**
 * Importação de extratos CSV (sem depender de um layout bancário único).
 *
 * - Parser RFC 4180: aspas, aspas duplicadas, quebras de linha dentro de campos, BOM, CRLF/LF/CR.
 * - Delimitador detectado (`;`, `,`, tab, `|`) ou escolhido.
 * - Cabeçalho localizado nas primeiras linhas (extratos costumam ter preâmbulo); mapeamento sugerido por
 *   sinônimos e SEMPRE editável pelo usuário (por índice de coluna).
 * - Valor numa coluna (com sinal) ou em colunas separadas de crédito/débito; separador decimal por arquivo.
 * - Limites de tamanho, linhas, colunas e caracteres por campo. Nada é executado nem buscado na rede.
 */
import type { Currency } from '../core/finance';
import { cleanText, normalizeDesc } from './model';
import { detectDateOrder, detectDecimalSeparator, parseBankAmount, parseBankDate, type DateOrder, type DecimalSep } from './parsing';
import { rangeOf, type IgnoredRow, type InvalidRow, type ParsedStatement, type TransactionDraft } from './drafts';

export const CSV_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 60,
  maxFieldChars: 4_000,
};

export class StatementError extends Error {}

export type Delimiter = ';' | ',' | '\t' | '|';
const DELIMS: Delimiter[] = [';', ',', '\t', '|'];

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parser RFC 4180. Retorna linhas (arrays de campos) com o número da linha física inicial de cada registro. */
export function parseCsv(input: string, delimiter: Delimiter, limits = CSV_LIMITS): { rows: string[][]; lines: number[] } {
  const text = stripBom(input);
  if (text.length > limits.maxBytes) throw new StatementError(`Arquivo grande demais (limite de ${limits.maxBytes / 1024 / 1024} MB).`);
  const rows: string[][] = [];
  const lines: number[] = [];
  let field = '', row: string[] = [], inQuotes = false, line = 1, rowLine = 1, i = 0, quotedField = false;
  const pushField = () => {
    if (field.length > limits.maxFieldChars) throw new StatementError(`Campo com mais de ${limits.maxFieldChars} caracteres na linha ${rowLine}.`);
    row.push(quotedField ? field : field.trim());
    field = '';
    quotedField = false;
    if (row.length > limits.maxColumns) throw new StatementError(`Mais de ${limits.maxColumns} colunas na linha ${rowLine}.`);
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      lines.push(rowLine);
      if (rows.length > limits.maxRows) throw new StatementError(`Mais de ${limits.maxRows} linhas: divida o arquivo.`);
    }
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c;
      if (field.length > limits.maxFieldChars) throw new StatementError(`Campo com mais de ${limits.maxFieldChars} caracteres na linha ${rowLine}.`);
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') { inQuotes = true; quotedField = true; field = ''; i++; continue; }
    if (c === delimiter) { pushField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      pushRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      line++;
      rowLine = line;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) throw new StatementError(`Aspas não fechadas a partir da linha ${rowLine}.`);
  if (field !== '' || row.length) pushRow();
  return { rows, lines };
}

/** Delimitador mais consistente nas primeiras linhas (fora de aspas). */
export function detectDelimiter(text: string): Delimiter {
  const sample = stripBom(text).slice(0, 20_000);
  let best: Delimiter = ';', bestScore = -1;
  for (const d of DELIMS) {
    try {
      const { rows } = parseCsv(sample.replace(/\n[^\n]*$/, ''), d, { ...CSV_LIMITS, maxRows: 400 });
      const counts = rows.slice(0, 40).map((r) => r.length).filter((n) => n > 1);
      if (!counts.length) continue;
      const freq = new Map<number, number>();
      for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
      const [mode, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      const score = hits * 10 + mode;
      if (score > bestScore) { bestScore = score; best = d; }
    } catch { /* delimitador inviável */ }
  }
  return best;
}

export type FieldRole = 'date' | 'operationDate' | 'description' | 'amount' | 'credit' | 'debit' | 'id' | 'reference' | 'balance' | 'category' | 'type' | 'status' | 'memo';

const SYNONYMS: Record<FieldRole, string[]> = {
  date: ['data', 'date', 'data lancamento', 'data do lancamento', 'dt', 'data movimento', 'data mov', 'data contabil', 'posted date', 'transaction date', 'data da transacao', 'data transacao', 'dia'],
  operationDate: ['data operacao', 'data da operacao', 'data compra', 'data da compra'],
  description: ['descricao', 'historico', 'description', 'title', 'titulo', 'lancamento', 'estabelecimento', 'detalhes', 'detalhe', 'nome', 'descricao do lancamento', 'payee'],
  amount: ['valor', 'amount', 'valor r', 'valor rs', 'quantia', 'montante', 'valor em r', 'valor brl', 'value'],
  credit: ['credito', 'creditos', 'entrada', 'entradas', 'credit', 'receita', 'valor credito'],
  debit: ['debito', 'debitos', 'saida', 'saidas', 'debit', 'despesa', 'valor debito'],
  id: ['id', 'identificador', 'fitid', 'transaction id', 'id transacao', 'id da transacao', 'codigo transacao'],
  reference: ['documento', 'doc', 'n documento', 'numero documento', 'num documento', 'referencia', 'nr doc'],
  balance: ['saldo', 'balance', 'saldo r', 'saldo rs'],
  category: ['categoria', 'category'],
  type: ['tipo', 'type', 'natureza'],
  status: ['status', 'situacao'],
  memo: ['observacao', 'obs', 'memo', 'complemento', 'notas'],
};

export interface CsvMapping {
  headerRow: number | null;
  columns: Partial<Record<FieldRole, number>>;
  decimalSep: DecimalSep;
  dateOrder: DateOrder;
  /** Coluna de débito traz valores positivos que significam saída (padrão). */
  debitPositive: boolean;
  /** Inverte o sinal de todos os valores (ex.: fatura de cartão em que compras vêm positivas). */
  invertSign: boolean;
  currency: Currency;
}

function headerRole(cell: string): FieldRole | null {
  const n = normalizeDesc(cell).replace(/\s+/g, ' ');
  if (!n) return null;
  for (const role of Object.keys(SYNONYMS) as FieldRole[]) if (SYNONYMS[role].includes(n)) return role;
  return null;
}

/** Localiza o cabeçalho nas primeiras 30 linhas: a primeira com data + (valor ou crédito/débito) + descrição. */
export function findHeaderRow(rows: string[][]): number | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const roles = new Set(rows[i].map(headerRole).filter(Boolean));
    if (roles.has('date') && (roles.has('amount') || roles.has('credit') || roles.has('debit')) && roles.has('description')) return i;
  }
  return null;
}

/** Mapeamento sugerido (o usuário confirma ou ajusta). */
export function suggestMapping(rows: string[][]): CsvMapping {
  const headerRow = findHeaderRow(rows);
  const columns: Partial<Record<FieldRole, number>> = {};
  if (headerRow !== null) {
    rows[headerRow].forEach((cell, idx) => {
      const role = headerRole(cell);
      if (role && columns[role] === undefined) columns[role] = idx;
    });
  } else {
    // Sem cabeçalho: deduz pelo conteúdo da primeira linha útil (data, texto, valor).
    const first = rows.find((r) => r.length >= 3) ?? [];
    first.forEach((cell, idx) => {
      if (columns.date === undefined && parseBankDate(cell)) columns.date = idx;
      else if (columns.amount === undefined && /^[-+(]?\s*(R\$)?\s*[\d.,]+\)?$/.test(cell.trim()) && /\d/.test(cell)) columns.amount = idx;
      else if (columns.description === undefined && /[a-z]/i.test(cell)) columns.description = idx;
    });
  }
  const body = rows.slice(headerRow === null ? 0 : headerRow + 1);
  const amountCols = [columns.amount, columns.credit, columns.debit].filter((c): c is number => c !== undefined);
  const samples = body.slice(0, 500).flatMap((r) => amountCols.map((c) => r[c] ?? '')).filter(Boolean);
  const dateSamples = columns.date !== undefined ? body.slice(0, 500).map((r) => r[columns.date!] ?? '') : [];
  return {
    headerRow,
    columns,
    decimalSep: detectDecimalSeparator(samples) ?? ',',
    dateOrder: detectDateOrder(dateSamples),
    debitPositive: true,
    invertSign: false,
    currency: 'BRL',
  };
}

const BALANCE_LINE = /^(saldo|saldo anterior|saldo do dia|saldo final|saldo inicial|saldo disponivel|s a l d o|total)( |$)/;

function pendingFrom(text: string | undefined): boolean {
  const n = normalizeDesc(text ?? '');
  return /\b(pendente|pending|processando|agendad[oa]|nao compensad[oa]|a compensar)\b/.test(n);
}

/** Converte as linhas mapeadas em rascunhos. Linhas inválidas não interrompem: são listadas. */
export function normalizeCsvRows(rows: string[][], lines: number[], mapping: CsvMapping): Pick<ParsedStatement, 'drafts' | 'invalid' | 'ignored' | 'warnings' | 'range'> {
  const drafts: TransactionDraft[] = [];
  const invalid: InvalidRow[] = [];
  const ignored: IgnoredRow[] = [];
  const warnings: string[] = [];
  const c = mapping.columns;
  if (c.date === undefined) throw new StatementError('Escolha a coluna de data.');
  if (c.description === undefined) throw new StatementError('Escolha a coluna de descrição.');
  if (c.amount === undefined && c.credit === undefined && c.debit === undefined) throw new StatementError('Escolha a coluna de valor (ou as colunas de crédito e débito).');
  const start = mapping.headerRow === null ? 0 : mapping.headerRow + 1;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const line = lines[i] ?? i + 1;
    const get = (k: FieldRole) => (c[k] !== undefined ? (r[c[k]!] ?? '').trim() : '');
    if (r.every((x) => !x.trim())) continue;
    const desc = cleanText(get('description'));
    const dateText = get('date');
    if (!dateText && BALANCE_LINE.test(normalizeDesc(desc))) { ignored.push({ line, reason: 'Linha de saldo (não é movimentação).' }); continue; }
    if (BALANCE_LINE.test(normalizeDesc(desc)) && !get('id')) { ignored.push({ line, reason: 'Linha de saldo (não é movimentação).' }); continue; }
    const date = parseBankDate(dateText, mapping.dateOrder);
    if (!date) { invalid.push({ line, reason: `Data inválida: “${cleanText(dateText, 30)}”.` }); continue; }
    let cents: number | null = null;
    if (c.amount !== undefined && get('amount')) {
      cents = parseBankAmount(get('amount'), mapping.decimalSep);
      if (cents === null) { invalid.push({ line, reason: `Valor inválido: “${cleanText(get('amount'), 30)}”.` }); continue; }
    } else {
      const cr = get('credit'), db = get('debit');
      const crc = cr ? parseBankAmount(cr, mapping.decimalSep) : 0;
      const dbc = db ? parseBankAmount(db, mapping.decimalSep) : 0;
      if (crc === null || dbc === null) { invalid.push({ line, reason: `Valor inválido: “${cleanText(cr || db, 30)}”.` }); continue; }
      if (!cr && !db) { invalid.push({ line, reason: 'Linha sem valor.' }); continue; }
      const debitSigned = mapping.debitPositive ? -Math.abs(dbc) : dbc;
      cents = Math.abs(crc) + debitSigned;
    }
    if (mapping.invertSign) cents = -cents;
    if (cents === 0) { ignored.push({ line, reason: 'Valor zero.' }); continue; }
    if (!desc) { invalid.push({ line, reason: 'Descrição vazia.' }); continue; }
    const opDate = c.operationDate !== undefined ? parseBankDate(get('operationDate'), mapping.dateOrder) : null;
    const inst = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(desc);
    drafts.push({
      line,
      externalId: get('id') ? cleanText(get('id'), 120) : undefined,
      postedDate: date,
      operationDate: opDate && opDate !== date ? opDate : undefined,
      description: desc,
      memo: get('memo') ? cleanText(get('memo')) : undefined,
      amountCents: cents,
      currency: mapping.currency,
      rawType: get('type') ? cleanText(get('type'), 40) : undefined,
      status: pendingFrom(get('status')) ? 'pending' : 'posted',
      reference: get('reference') ? cleanText(get('reference'), 60) : undefined,
      categoryHint: get('category') ? cleanText(get('category'), 60) : undefined,
      installment: inst && +inst[1] >= 1 && +inst[2] >= 2 && +inst[1] <= +inst[2] && +inst[2] <= 120 ? { index: +inst[1], count: +inst[2] } : undefined,
    });
  }
  if (!drafts.length && !invalid.length) warnings.push('Nenhuma movimentação encontrada no arquivo.');
  return { drafts, invalid, ignored, warnings, range: rangeOf(drafts) };
}

export function parseCsvStatement(text: string, opts: { delimiter?: Delimiter; mapping?: CsvMapping } = {}): ParsedStatement & { mapping: CsvMapping; delimiter: Delimiter; header: string[] | null; preview: string[][] } {
  if (!text.trim()) throw new StatementError('Arquivo vazio.');
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const { rows, lines } = parseCsv(text, delimiter);
  if (!rows.length) throw new StatementError('Arquivo vazio.');
  const mapping = opts.mapping ?? suggestMapping(rows);
  const header = mapping.headerRow !== null ? rows[mapping.headerRow] : null;
  const preview = rows.slice(mapping.headerRow === null ? 0 : mapping.headerRow + 1, (mapping.headerRow ?? -1) + 6);
  const n = normalizeCsvRows(rows, lines, mapping);
  return { format: 'csv', ...n, mapping, delimiter, header, preview };
}

/* ------------------------------------------------------------------ */
/* Exportação CSV segura                                               */
/* ------------------------------------------------------------------ */

/** Neutraliza injeção de fórmulas (=, +, -, @, tab, CR) ao abrir o CSV numa planilha. */
export function csvSafeCell(value: string | number): string {
  let s = String(value ?? '');
  // Números puros ("-123,45") continuam números; qualquer outro texto iniciado por gatilho vira texto.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(?:[.,]\d+)?$/.test(s)) s = `'${s}`;
  if (/[";\n\r,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: (string | number)[][], delimiter: Delimiter = ';'): string {
  return '﻿' + rows.map((r) => r.map(csvSafeCell).join(delimiter)).join('\r\n');
}
