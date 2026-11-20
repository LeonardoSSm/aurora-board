/**
 * Data Hub (issue #24, D2-A) — modelo de um conjunto de dados tabular importado (CSV/JSON).
 *
 * O conteúdo fica num ASSET imutável do armazenamento local (IndexedDB `aurora-board`, área `assets`) com tipo
 * próprio (`DATASET_MIME`). O bloco `aurora.dataset` guarda só a referência e metadados (nome, contagens, origem)
 * e opções de exibição. Nada disso passa por `aurora.setState`, pelas saídas efêmeras do HTML Data Bridge, pelo
 * razão financeiro nem pelos prompts de IA.
 *
 * Linhas são ARRAYS (ordem das colunas), não objetos: nomes de campo vindos do arquivo nunca viram chaves de
 * objeto internas (sem `__proto__`/`constructor` como propriedade) e o armazenamento fica compacto.
 */

export const DATASET_MIME = 'application/vnd.aurora.dataset+json';
export const DATASET_FORMAT = 'aurora-dataset';
export const DATASET_VERSION = 1;

export type CellValue = string | number | boolean | null;
/** `mixed`: só em JSON, quando a coluna tem tipos diferentes (os valores são mantidos como vieram). */
export type ColumnType = 'number' | 'text' | 'boolean' | 'date' | 'mixed' | 'empty';
export const COLUMN_TYPES: readonly ColumnType[] = ['number', 'text', 'boolean', 'date', 'mixed', 'empty'];
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = { number: 'Número', text: 'Texto', boolean: 'Sim/não', date: 'Data', mixed: 'Misto', empty: 'Vazia' };

export interface DatasetColumn {
  /** Nome estável usado nas saídas (`rows`): único, seguro como chave de objeto (ver `columnKey`). */
  key: string;
  /** Nome original do cabeçalho (limpo de caracteres de controle), exibido e exportado. */
  label: string;
  type: ColumnType;
}

export interface DatasetContent {
  format: typeof DATASET_FORMAT;
  version: typeof DATASET_VERSION;
  columns: DatasetColumn[];
  rows: CellValue[][];
}

export type DatasetKind = 'csv' | 'json';

export const DATASET_LIMITS = {
  /** Tamanho do arquivo importado (conferido por `File.size`, antes de ler). */
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 100,
  maxCells: 1_000_000,
  maxCellChars: 10_000,
  maxLabelChars: 120,
  /** JSON: profundidade e nós da estrutura bruta, conferidos ANTES de converter (anti-bomba). */
  maxJsonDepth: 32,
  maxJsonNodes: 3_000_000,
  /** JSON normalizado guardado no asset, em BYTES UTF-8 (24 MB; em base64 fica abaixo do limite de 36 MB dos backups). */
  maxStoredBytes: 24 * 1024 * 1024,
  /** Datasets mantidos em memória ao mesmo tempo (células somadas); os menos usados saem do cache. */
  maxCachedCells: 3_000_000,
} as const;

/**
 * Chaves que não podem ser usadas diretamente nas saídas `rows` (objetos):
 * - `__proto__`, `constructor`, `prototype`: poluição de protótipo / descartadas pelo JSON simples do Bridge;
 * - `key`, `members`: o HTML Data Bridge remove essas chaves internas de valores do fluxo de dados;
 * - começando com `$`: chaves internas do fluxo de dados (também removidas).
 * Recebem o sufixo `_` (o rótulo original continua visível e é o que vai para a exportação).
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'key', 'members']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Rótulo de coluna/nome exibido: sem caracteres de controle nem de direção, espaços normalizados, limitado. */
export function cleanLabel(s: unknown, max: number = DATASET_LIMITS.maxLabelChars): string {
  return String(s ?? '').replace(CONTROL, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Chaves estáveis e únicas para as colunas (a partir dos rótulos). */
export function columnKeys(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, i) => {
    let base = label || `coluna_${i + 1}`;
    if (RESERVED_KEYS.has(base) || base.startsWith('$')) base = `${base.replace(/^\$+/, '') || 'coluna'}_`;
    if (RESERVED_KEYS.has(base)) base = `${base}_`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return key;
  });
}

export class DatasetError extends Error {}

const isCell = (v: unknown): v is CellValue => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/**
 * Validação ESTRITA de um conteúdo vindo do armazenamento ou de um backup (não confiável): formato, versão,
 * limites, colunas únicas e seguras, linhas do tamanho do cabeçalho e células primitivas.
 */
export function validateContent(raw: unknown): DatasetContent {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || o.format !== DATASET_FORMAT) throw new DatasetError('Conteúdo não é um conjunto de dados do Aurora Board.');
  if (o.version !== DATASET_VERSION) throw new DatasetError(`Versão do conjunto de dados não suportada (${String(o.version).slice(0, 10)}).`);
  if (!Array.isArray(o.columns) || !o.columns.length) throw new DatasetError('Conjunto de dados sem colunas.');
  if (o.columns.length > DATASET_LIMITS.maxColumns) throw new DatasetError(`Mais de ${DATASET_LIMITS.maxColumns} colunas.`);
  if (!Array.isArray(o.rows)) throw new DatasetError('Conjunto de dados sem linhas.');
  if (o.rows.length > DATASET_LIMITS.maxRows) throw new DatasetError(`Mais de ${DATASET_LIMITS.maxRows.toLocaleString('pt-BR')} linhas.`);
  if (o.rows.length * o.columns.length > DATASET_LIMITS.maxCells) throw new DatasetError(`Mais de ${DATASET_LIMITS.maxCells.toLocaleString('pt-BR')} células.`);
  const labels: string[] = [];
  const types: ColumnType[] = [];
  for (const c of o.columns) {
    const col = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
    labels.push(cleanLabel(col.label));
    types.push(COLUMN_TYPES.includes(col.type as ColumnType) ? (col.type as ColumnType) : 'mixed');
  }
  // As chaves são SEMPRE recalculadas a partir dos rótulos: um arquivo não escolhe chaves perigosas.
  const keys = columnKeys(labels);
  const columns: DatasetColumn[] = labels.map((label, i) => ({ key: keys[i], label: label || keys[i], type: types[i] }));
  const width = columns.length;
  const rows: CellValue[][] = new Array(o.rows.length);
  for (let r = 0; r < o.rows.length; r++) {
    const row = o.rows[r];
    if (!Array.isArray(row) || row.length !== width) throw new DatasetError(`Linha ${r + 1} com estrutura inválida.`);
    for (let c = 0; c < width; c++) {
      const v = row[c];
      if (!isCell(v)) throw new DatasetError(`Linha ${r + 1}: valor inválido na coluna “${columns[c].label}”.`);
      if (typeof v === 'string' && v.length > DATASET_LIMITS.maxCellChars) throw new DatasetError(`Linha ${r + 1}: texto com mais de ${DATASET_LIMITS.maxCellChars} caracteres.`);
    }
    rows[r] = row.slice() as CellValue[];
  }
  return { format: DATASET_FORMAT, version: DATASET_VERSION, columns, rows };
}

/** Metadados do conjunto guardados no bloco (sem nenhum valor das células). */
export interface DatasetSource {
  assetId: string;
  name: string;
  kind: DatasetKind;
  rows: number;
  columns: number;
  bytes: number;
  importedAt: number;
}
