/**
 * Data Hub (D2-A) — leitor CSV RFC 4180 próprio (o de extratos bancários, `src/finance/csv.ts`, é de outro domínio
 * e tem regras próprias). Diferenças que importam aqui:
 * - um campo vazio ENTRE ASPAS (`""`) é um registro (nulo numa coluna só); só linha realmente em branco é ignorada
 *   — assim a exportação de um conjunto de uma coluna com nulos volta com o mesmo número de linhas;
 * - informa quais campos vieram entre aspas (o chamador decide o que fazer com isso).
 * Aspas, aspas duplicadas, quebras de linha dentro de campos, CRLF/LF/CR, BOM. Campos sem aspas são aparados.
 * Limites de linhas, colunas e caracteres por campo: excedeu, lança (nada parcial).
 */
import { DatasetError } from './model';

export interface CsvLimits { maxRows: number; maxColumns: number; maxFieldChars: number }
export interface CsvTable { rows: string[][]; lines: number[] }

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readCsv(input: string, delimiter: string, limits: CsvLimits): CsvTable {
  const text = stripBom(input);
  const rows: string[][] = [];
  const lines: number[] = [];
  let field = '', row: string[] = [], inQuotes = false, quoted = false, rowQuoted = false, line = 1, rowLine = 1, i = 0;
  const tooLong = () => new DatasetError(`Campo com mais de ${limits.maxFieldChars.toLocaleString('pt-BR')} caracteres na linha ${rowLine}.`);
  const pushField = () => {
    if (field.length > limits.maxFieldChars) throw tooLong();
    row.push(quoted ? field : field.trim());
    if (quoted) rowQuoted = true;
    field = '';
    quoted = false;
    if (row.length > limits.maxColumns) throw new DatasetError(`Mais de ${limits.maxColumns} colunas na linha ${rowLine}.`);
  };
  const pushRow = () => {
    pushField();
    // Linha em branco (um único campo vazio SEM aspas) não é registro.
    if (!(row.length === 1 && row[0] === '' && !rowQuoted)) {
      rows.push(row);
      lines.push(rowLine);
      if (rows.length > limits.maxRows) throw new DatasetError(`Mais de ${limits.maxRows.toLocaleString('pt-BR')} linhas.`);
    }
    row = [];
    rowQuoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
      field += c;
      if (field.length > limits.maxFieldChars) throw tooLong();
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') { inQuotes = true; quoted = true; field = ''; i++; continue; }
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
  if (inQuotes) throw new DatasetError(`Aspas não fechadas a partir da linha ${rowLine}.`);
  if (field !== '' || row.length || quoted) pushRow();
  return { rows, lines };
}
