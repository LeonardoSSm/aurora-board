/**
 * Data Hub (D2-A) — codificação do conteúdo de um conjunto de dados como asset local (PURO: sem store/IndexedDB).
 * Usado pelo cache (`store.ts`) e pela importação de backups (`persistence/exportImport.ts`), que valida os
 * datasets ANTES de gravar qualquer coisa.
 */
import type { Asset } from '../core/schema';
import { uid } from '../core/elements';
import { DATASET_LIMITS, DATASET_MIME, DatasetError, validateContent, type DatasetContent } from './model';

const PREFIX = `data:${DATASET_MIME};base64,`;

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Conteúdo → asset (não grava). Lança se o JSON normalizado passar do limite. */
export function encodeDatasetAsset(content: DatasetContent, name: string, id = uid('ds_')): Asset {
  const json = JSON.stringify(validateContent(content));
  if (json.length > DATASET_LIMITS.maxStoredChars) throw new DatasetError(`Conjunto de dados grande demais para guardar (${(json.length / 1024 / 1024).toFixed(1)} MB; limite de ${DATASET_LIMITS.maxStoredChars / 1024 / 1024} MB).`);
  const dataURL = PREFIX + toBase64(json);
  return { id, mimeType: DATASET_MIME, dataURL, name: name.slice(0, 200), size: json.length, createdAt: Date.now() };
}

/** Asset → conteúdo validado. Lança `DatasetError` para qualquer coisa que não seja um dataset íntegro. */
export function decodeDatasetAsset(asset: Pick<Asset, 'mimeType' | 'dataURL'>): DatasetContent {
  if (asset.mimeType !== DATASET_MIME || !asset.dataURL.startsWith(PREFIX)) throw new DatasetError('O arquivo guardado não é um conjunto de dados.');
  const b64 = asset.dataURL.slice(PREFIX.length);
  if (b64.length > Math.ceil((DATASET_LIMITS.maxStoredChars * 4) / 3) + 8) throw new DatasetError('Conjunto de dados guardado grande demais.');
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64(b64));
  } catch {
    throw new DatasetError('Conjunto de dados guardado está corrompido.');
  }
  return validateContent(raw);
}

/** Asset com o tipo de conjunto de dados (pelo cabeçalho; o conteúdo é validado por `decodeDatasetAsset`). */
export function isDatasetAsset(a: Pick<Asset, 'mimeType' | 'dataURL'>): boolean {
  return a.mimeType === DATASET_MIME || a.dataURL.startsWith(PREFIX);
}
