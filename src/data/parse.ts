/**
 * Data Hub (D2-A) — leitura de CSV e JSON importados pelo usuário. Funções PURAS: nada é executado, buscado na
 * rede ou gravado aqui. O resultado só vira dado persistente depois da prévia e da confirmação na interface.
 *
 * CSV: UTF-8 (BOM aceito), RFC 4180 (aspas, aspas duplicadas, quebras de linha dentro de campos, CRLF/LF/CR),
 * delimitador detectado entre `,` `;` TAB e `|`, primeira linha = cabeçalho. Todas as linhas precisam ter o
 * mesmo número de campos do cabeçalho (campos vazios a mais no fim são tolerados).
 *
 * JSON (variantes aceitas):
 * 1. lista de objetos: `[{ "nome": "Ana", "idade": 30 }, ...]` — colunas na ordem em que aparecem;
 * 2. objeto `{ "columns": [...], "rows": [...] }` — `columns` com textos ou `{ label }` (é o formato que a
 *    exportação JSON gera, com `format: "aurora-dataset"`); `rows` com listas (na ordem das colunas) ou objetos.
 * Células: texto, número, sim/não ou nulo. Objetos/listas dentro de uma célula viram o texto JSON dela (aviso).
 */
import { parseCsv, StatementError, stripBom } from '../finance/csv';
import { cleanLabel, columnKeys, DATASET_FORMAT, DATASET_LIMITS, DATASET_VERSION, DatasetError, type CellValue, type ColumnType, type DatasetColumn, type DatasetContent, type DatasetKind } from './model';

export interface ParsedDataset {
  kind: DatasetKind;
  content: DatasetContent;
  warnings: string[];
  /** Delimitador usado (só CSV). */
  delimiter?: string;
}

type Limits = { -readonly [K in keyof typeof DATASET_LIMITS]: number };

const fmt = (n: number) => n.toLocaleString('pt-BR');
const DELIMS = [',', ';', '\t', '|'] as const;
const DELIM_NAMES: Record<string, string> = { ',': 'vírgula', ';': 'ponto e vírgula', '\t': 'tabulação', '|': 'barra vertical' };

/** Tipo do arquivo pelo nome (o conteúdo decide quando a extensão não ajuda). */
export function datasetKindOf(fileName: string, text: string): DatasetKind {
  if (/\.json$/i.test(fileName)) return 'json';
  if (/\.(csv|tsv|txt)$/i.test(fileName)) return 'csv';
  const head = stripBom(text).trimStart()[0];
  return head === '[' || head === '{' ? 'json' : 'csv';
}

export function checkDatasetFileSize(size: number, lim: Limits = DATASET_LIMITS): void {
  if (size > lim.maxFileBytes) throw new DatasetError(`Arquivo grande demais (${(size / 1024 / 1024).toFixed(1)} MB; limite de ${lim.maxFileBytes / 1024 / 1024} MB).`);
  if (size === 0) throw new DatasetError('Arquivo vazio.');
}

/** Ponto de entrada: valida e converte o texto do arquivo. Lança `DatasetError` com mensagem para o usuário. */
export function parseDatasetText(fileName: string, text: string, lim: Limits = DATASET_LIMITS): ParsedDataset {
  if (text.length > lim.maxFileBytes) throw new DatasetError(`Arquivo grande demais (limite de ${lim.maxFileBytes / 1024 / 1024} MB).`);
  // Binário (planilha .xlsx, imagem, executável…) não é CSV/JSON: recusa antes de tentar interpretar.
  if (text.includes('\u0000')) throw new DatasetError('O arquivo não parece texto (CSV ou JSON). Planilhas do Excel precisam ser salvas como CSV.');
  if (text.includes('�')) throw new DatasetError('O arquivo não está em UTF-8 válido. Salve-o como “CSV UTF-8”.');
  return datasetKindOf(fileName, text) === 'json' ? parseJsonDataset(text, lim) : parseCsvDataset(text, lim);
}

/* ------------------------------------------------------------------ CSV */

function detectDelimiter(text: string, lim: Limits): string {
  const sample = text.slice(0, 64 * 1024);
  // Corta a última linha da amostra (pode estar incompleta) quando o texto é maior que ela.
  const cut = text.length > sample.length ? sample.slice(0, Math.max(sample.lastIndexOf('\n'), 1)) : sample;
  let best = ',', bestScore = -1;
  for (const d of DELIMS) {
    try {
      const { rows } = parseCsv(cut, d as never, { maxBytes: lim.maxFileBytes, maxRows: 200, maxColumns: lim.maxColumns, maxFieldChars: lim.maxCellChars });
      if (!rows.length) continue;
      const width = rows[0].length;
      if (width < 2) continue;
      const consistent = rows.filter((r) => r.length === width).length;
      // Consistência com o cabeçalho pesa mais que a largura.
      const score = (consistent / rows.length) * 1000 + width;
      if (score > bestScore) { bestScore = score; best = d; }
    } catch { /* delimitador inviável para a amostra */ }
  }
  return best;
}

const NUM_DOT = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const NUM_BR = /^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Zeros à esquerda (CEP, códigos) e inteiros longos demais continuam texto: nada de perder dígitos. */
function keepsAsText(s: string): boolean {
  const unsigned = s.replace(/^[+-]/, '');
  if (/^0\d/.test(unsigned)) return true;
  const digits = unsigned.replace(/[^\d]/g, '');
  return /^\d+$/.test(unsigned) && digits.length > 15;
}

function parseNumber(s: string, br: boolean): number | null {
  if (keepsAsText(s)) return null;
  if (!br) return NUM_DOT.test(s) ? Number(s) : null;
  if (!NUM_BR.test(s)) return null;
  return Number(s.replace(/\./g, '').replace(',', '.'));
}

/** Tipo de uma coluna CSV a partir dos textos não vazios; converte os valores quando o tipo é número/sim-não. */
function typeCsvColumn(values: string[]): { type: ColumnType; convert: (s: string) => CellValue } {
  const filled = values.filter((v) => v !== '');
  if (!filled.length) return { type: 'empty', convert: () => null };
  const lower = filled.map((v) => v.toLowerCase());
  if (lower.every((v) => v === 'true' || v === 'false')) return { type: 'boolean', convert: (s) => (s === '' ? null : s.toLowerCase() === 'true') };
  for (const br of [false, true]) {
    if (filled.every((v) => { const n = parseNumber(v, br); return n !== null && Number.isFinite(n); })) {
      // Formato brasileiro só quando há vírgula decimal em algum valor (evita ler "1.234" como mil e poucos à toa).
      if (br && !filled.some((v) => v.includes(','))) continue;
      return { type: 'number', convert: (s) => (s === '' ? null : parseNumber(s, br)) };
    }
  }
  if (filled.every((v) => ISO_DATE.test(v))) return { type: 'date', convert: (s) => (s === '' ? null : s) };
  return { type: 'text', convert: (s) => (s === '' ? null : s) };
}

function parseCsvDataset(input: string, lim: Limits): ParsedDataset {
  const text = stripBom(input);
  if (!text.trim()) throw new DatasetError('Arquivo vazio.');
  const delimiter = detectDelimiter(text, lim);
  let rows: string[][], lines: number[];
  try {
    ({ rows, lines } = parseCsv(text, delimiter as never, { maxBytes: lim.maxFileBytes, maxRows: lim.maxRows + 1, maxColumns: lim.maxColumns, maxFieldChars: lim.maxCellChars }));
  } catch (e) {
    if (!(e instanceof StatementError)) throw e;
    // O leitor conta o cabeçalho como linha: a mensagem usa o limite de linhas DE DADOS.
    throw new DatasetError(/linhas/.test(e.message) ? `Mais de ${fmt(lim.maxRows)} linhas: divida o arquivo.` : e.message);
  }
  if (!rows.length) throw new DatasetError('Arquivo vazio.');
  const header = rows[0];
  const width = header.length;
  if (header.every((h) => h === '')) throw new DatasetError('A primeira linha (cabeçalho) está vazia.');
  const body = rows.slice(1);
  if (body.length > lim.maxRows) throw new DatasetError(`Mais de ${fmt(lim.maxRows)} linhas: divida o arquivo.`);
  if (body.length * width > lim.maxCells) throw new DatasetError(`Mais de ${fmt(lim.maxCells)} células (${fmt(body.length)} linhas × ${width} colunas).`);
  const warnings: string[] = [];
  let trimmed = 0;
  for (let r = 0; r < body.length; r++) {
    const row = body[r];
    if (row.length === width) continue;
    // Separadores sobrando no fim (comum em exportações de planilha) são tolerados; qualquer outra diferença não.
    if (row.length > width && row.slice(width).every((v) => v === '')) { body[r] = row.slice(0, width); trimmed++; continue; }
    throw new DatasetError(`Linha ${lines[r + 1]}: ${row.length} campo(s), mas o cabeçalho tem ${width} (delimitador: ${DELIM_NAMES[delimiter]}). Confira aspas e separadores.`);
  }
  if (trimmed) warnings.push(`${fmt(trimmed)} linha(s) com separadores vazios a mais no fim foram ajustadas.`);
  const labels = header.map((h, i) => cleanLabel(h) || `Coluna ${i + 1}`);
  const keys = columnKeys(labels);
  const columns: DatasetColumn[] = [];
  const converters: ((s: string) => CellValue)[] = [];
  for (let c = 0; c < width; c++) {
    const t = typeCsvColumn(body.map((r) => r[c]));
    columns.push({ key: keys[c], label: labels[c], type: t.type });
    converters.push(t.convert);
  }
  const out: CellValue[][] = body.map((r) => r.map((v, c) => converters[c](v)));
  if (!out.length) warnings.push('O arquivo só tem o cabeçalho (nenhuma linha de dados).');
  noteRenamedKeys(columns, warnings);
  return { kind: 'csv', delimiter, warnings, content: { format: DATASET_FORMAT, version: DATASET_VERSION, columns, rows: out } };
}

/* ------------------------------------------------------------------ JSON */

/** Orçamento da estrutura bruta, sem recursão (não estoura a pilha com aninhamento profundo). */
function jsonBudget(value: unknown, lim: Limits) {
  const stack: [unknown, number][] = [[value, 1]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++nodes > lim.maxJsonNodes) throw new DatasetError(`JSON com mais de ${fmt(lim.maxJsonNodes)} itens.`);
    if (!v || typeof v !== 'object') continue;
    if (depth > lim.maxJsonDepth) throw new DatasetError(`JSON aninhado demais (mais de ${lim.maxJsonDepth} níveis).`);
    if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], depth + 1]);
    else for (const k of Object.keys(v)) stack.push([(v as Record<string, unknown>)[k], depth + 1]);
  }
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseJsonDataset(input: string, lim: Limits): ParsedDataset {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(input));
  } catch {
    throw new DatasetError('O arquivo não é um JSON válido.');
  }
  jsonBudget(data, lim);
  const warnings: string[] = [];
  let labels: string[];
  let rawRows: unknown[];
  let fromObjects: boolean;
  if (Array.isArray(data)) {
    if (data.some((r) => !isPlainObject(r))) throw new DatasetError('Lista JSON deve conter só objetos (uma linha por objeto).');
    rawRows = data;
    fromObjects = true;
    const seen = new Set<string>();
    labels = [];
    for (const r of data as Record<string, unknown>[]) {
      for (const k of Object.keys(r)) {
        if (seen.has(k)) continue;
        seen.add(k);
        labels.push(k);
        if (labels.length > lim.maxColumns) throw new DatasetError(`Mais de ${lim.maxColumns} colunas (campos diferentes nos objetos).`);
      }
    }
  } else if (isPlainObject(data) && own(data, 'columns') && own(data, 'rows')) {
    if (data.format !== undefined && data.format !== DATASET_FORMAT) throw new DatasetError('Formato JSON não reconhecido.');
    if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new DatasetError('“columns” e “rows” devem ser listas.');
    if (data.columns.length > lim.maxColumns) throw new DatasetError(`Mais de ${lim.maxColumns} colunas.`);
    labels = data.columns.map((c, i) => {
      if (typeof c === 'string') return c;
      if (isPlainObject(c) && typeof c.label === 'string') return c.label;
      throw new DatasetError(`Coluna ${i + 1} inválida: use um texto ou { "label": "…" }.`);
    });
    rawRows = data.rows;
    fromObjects = rawRows.length > 0 && isPlainObject(rawRows[0]);
  } else {
    if (isPlainObject(data) && (data.format === 'aurora-board' || data.format === 'aurora-finance' || data.format === 'aurora-personal-backup')) {
      throw new DatasetError('Este arquivo é um backup do Aurora Board, não um conjunto de dados. Use Importar → Arquivo JSON na barra superior.');
    }
    throw new DatasetError('Formato JSON não reconhecido: use uma lista de objetos ou { "columns": [...], "rows": [...] }.');
  }
  if (!labels.length) throw new DatasetError('Nenhuma coluna encontrada no JSON.');
  if (rawRows.length > lim.maxRows) throw new DatasetError(`Mais de ${fmt(lim.maxRows)} linhas: divida o arquivo.`);
  if (rawRows.length * labels.length > lim.maxCells) throw new DatasetError(`Mais de ${fmt(lim.maxCells)} células (${fmt(rawRows.length)} linhas × ${labels.length} colunas).`);
  const cleaned = labels.map((l, i) => cleanLabel(l) || `Coluna ${i + 1}`);
  const keys = columnKeys(cleaned);
  let nested = 0;
  const cell = (v: unknown, r: number, c: number): CellValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      if (v.length > lim.maxCellChars) throw new DatasetError(`Linha ${r + 1}, coluna “${cleaned[c]}”: texto com mais de ${fmt(lim.maxCellChars)} caracteres.`);
      return v;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new DatasetError(`Linha ${r + 1}, coluna “${cleaned[c]}”: número inválido.`);
      return v;
    }
    // Objeto/lista dentro da célula: guardado como o texto JSON dele (nunca interpretado como código).
    nested++;
    const s = JSON.stringify(v);
    if (s.length > lim.maxCellChars) throw new DatasetError(`Linha ${r + 1}, coluna “${cleaned[c]}”: valor com mais de ${fmt(lim.maxCellChars)} caracteres.`);
    return s;
  };
  const rows: CellValue[][] = rawRows.map((raw, r) => {
    if (fromObjects) {
      if (!isPlainObject(raw)) throw new DatasetError(`Linha ${r + 1}: esperado um objeto.`);
      return labels.map((k, c) => cell(own(raw, k) ? raw[k] : null, r, c));
    }
    if (!Array.isArray(raw)) throw new DatasetError(`Linha ${r + 1}: esperada uma lista de valores.`);
    if (raw.length !== labels.length) throw new DatasetError(`Linha ${r + 1}: ${raw.length} valor(es), mas há ${labels.length} coluna(s).`);
    return raw.map((v, c) => cell(v, r, c));
  });
  if (nested) warnings.push(`${fmt(nested)} valor(es) com objetos ou listas foram guardados como texto JSON.`);
  const columns: DatasetColumn[] = cleaned.map((label, c) => ({ key: keys[c], label, type: typeJsonColumn(rows, c) }));
  if (!rows.length) warnings.push('O arquivo não tem linhas de dados.');
  noteRenamedKeys(columns, warnings);
  return { kind: 'json', warnings, content: { format: DATASET_FORMAT, version: DATASET_VERSION, columns, rows } };
}

function typeJsonColumn(rows: CellValue[][], c: number): ColumnType {
  const kinds = new Set<string>();
  let allDates = true;
  for (const r of rows) {
    const v = r[c];
    if (v === null) continue;
    kinds.add(typeof v);
    if (typeof v !== 'string' || !ISO_DATE.test(v)) allDates = false;
  }
  if (!kinds.size) return 'empty';
  if (kinds.size > 1) return 'mixed';
  const k = [...kinds][0];
  if (k === 'number') return 'number';
  if (k === 'boolean') return 'boolean';
  return allDates ? 'date' : 'text';
}

function noteRenamedKeys(columns: DatasetColumn[], warnings: string[]) {
  const renamed = columns.filter((c) => c.key !== c.label);
  if (renamed.length) warnings.push(`Nome técnico ajustado em ${renamed.length} coluna(s) para uso seguro nas conexões (ex.: “${renamed[0].label}” → ${renamed[0].key}).`);
}
