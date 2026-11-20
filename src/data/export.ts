/**
 * Data Hub (D2-A) — exportação de um conjunto de dados para CSV ou JSON (download disparado pela interface).
 *
 * CSV seguro para planilhas (“CSV/formula injection”): um TEXTO cujo primeiro caractere significativo — depois
 * de espaços e caracteres de controle — seja `=`, `+`, `-`, `@` (ou as variantes de largura total) ou que
 * comece com TAB/CR recebe um apóstrofo na frente e vai entre aspas. Assim Excel, LibreOffice e Google
 * Planilhas mostram o texto em vez de executar uma fórmula. Números de verdade (coluna numérica) saem como
 * números (`-5` continua número). Ao reimportar no Aurora Board, o apóstrofo é removido (`restoreNeutralized`).
 * Aspas, separadores e quebras de linha são escapados (RFC 4180); Unicode é
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

/**
 * Precisa do apóstrofo? Sim quando parece fórmula — e também quando, depois de apóstrofos iniciais, pareceria
 * (`'=x` vira `''=x`). Assim a importação, que tira UM apóstrofo nesse caso, devolve exatamente o original.
 */
function needsEscape(s: string): boolean {
  let i = 0;
  while (s[i] === "'") i++;
  return isFormulaLike(i ? s.slice(i) : s);
}

/** Texto neutralizado para planilhas (apóstrofo na frente quando parece fórmula). */
export function neutralizeFormula(s: string): string {
  return needsEscape(s) ? `'${s}` : s;
}

/**
 * Inverso exato de `neutralizeFormula`, aplicado na IMPORTAÇÃO de CSV: `'=…` volta a ser `=…` (e `''=…` volta a
 * `'=…`). A ida e volta CSV fica sem perda e sem crescer — revisão do Codex, PR #27. O valor continua TEXTO no
 * app (nada é avaliado) e toda exportação CSV neutraliza de novo. Planilhas também tratam o `'` inicial como
 * marcador de texto, então a leitura coincide com a delas.
 */
export function restoreNeutralized(s: string): string {
  return s.length > 1 && s[0] === "'" && needsEscape(s.slice(1)) ? s.slice(1) : s;
}

/** Separadores que o importador reconhece: um texto com qualquer um deles vai entre aspas (a estrutura não muda). */
const ANY_DELIMITER = /[,;\t|]/;

function csvField(v: CellValue, delimiter: string, single = false): string {
  // Numa coluna só, campo vazio vira `""`: uma linha em branco seria ignorada na volta (a linha sumiria).
  if (v === null || v === '') return single ? '""' : '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = neutralizeFormula(v);
  const needsQuotes = s !== v || s.includes('"') || s.includes(delimiter) || ANY_DELIMITER.test(s) || /[\r\n]/.test(s) || s !== s.trim();
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

export function datasetToCSV(content: DatasetContent, delimiter = ','): string {
  const single = content.columns.length === 1;
  const lines = [content.columns.map((c) => csvField(c.label, delimiter, single)).join(delimiter)];
  for (const row of content.rows) lines.push(row.map((v) => csvField(v, delimiter, single)).join(delimiter));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * JSON reimportável e COMPACTO (`{ format, version, name, columns, rows }`, linhas como listas na ordem das
 * colunas): o tamanho acompanha o do conteúdo guardado e cabe no limite de importação.
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
  });
}
