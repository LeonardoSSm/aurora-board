/**
 * Data Hub (D2-A) — exportação de um conjunto de dados para CSV ou JSON (download disparado pela interface).
 *
 * CSV seguro para planilhas (“CSV/formula injection”): um TEXTO cujo primeiro caractere significativo — depois
 * de espaços e caracteres de controle — seja `=`, `+`, `-`, `@` (ou as variantes de largura total) ou que
 * comece com TAB/CR recebe um apóstrofo na frente e vai entre aspas. Assim Excel, LibreOffice e Google
 * Planilhas mostram o texto em vez de executar uma fórmula. Números de verdade (coluna numérica) saem como
 * números (`-5` continua número). Aspas, separadores e quebras de linha são escapados (RFC 4180); Unicode é
 * preservado; o arquivo começa com BOM UTF-8 para o Excel reconhecer a codificação.
 */
import { DATASET_FORMAT, DATASET_VERSION, type CellValue, type DatasetContent } from './model';

// eslint-disable-next-line no-control-regex
const LEADING_NOISE = /^[\s\u0000-\u001f\u007f-\u009f ​-‏‪-‮⁠-⁩﻿]*/;
const FORMULA_START = new Set(['=', '+', '-', '@', '＝', '＋', '－', '＠']);

/** O texto seria interpretado como fórmula por uma planilha? */
export function isFormulaLike(s: string): boolean {
  if (!s) return false;
  if (s[0] === '\t' || s[0] === '\r') return true;
  const rest = s.replace(LEADING_NOISE, '');
  return rest.length > 0 && FORMULA_START.has(rest[0]);
}

/** Texto neutralizado para planilhas (apóstrofo na frente quando parece fórmula). */
export function neutralizeFormula(s: string): string {
  return isFormulaLike(s) ? `'${s}` : s;
}

function csvField(v: CellValue, delimiter: string): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = neutralizeFormula(v);
  const needsQuotes = s !== v || s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s) || s !== s.trim();
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

export function datasetToCSV(content: DatasetContent, delimiter = ','): string {
  const lines = [content.columns.map((c) => csvField(c.label, delimiter)).join(delimiter)];
  for (const row of content.rows) lines.push(row.map((v) => csvField(v, delimiter)).join(delimiter));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * JSON reimportável (`{ format, version, name, columns, rows }`, linhas como listas na ordem das colunas).
 * As células são escritas como estão: o JSON não é aberto por planilhas como fórmula.
 */
export function datasetToJSON(content: DatasetContent, name: string): string {
  return JSON.stringify({
    format: DATASET_FORMAT,
    version: DATASET_VERSION,
    name,
    exportedAt: new Date().toISOString(),
    columns: content.columns.map((c) => ({ label: c.label, type: c.type })),
    rows: content.rows,
  }, null, 1);
}
