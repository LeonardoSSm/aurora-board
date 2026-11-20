/**
 * Data Hub (D2-A) — codificação do conteúdo de um conjunto de dados como asset local (PURO: sem store/IndexedDB).
 * Usado pelo cache (`store.ts`) e pela importação de backups (`persistence/exportImport.ts`), que valida os
 * datasets ANTES de gravar qualquer coisa.
 */
import type { Asset } from '../core/schema';
import { uid } from '../core/elements';
import { DATASET_LIMITS, DATASET_MIME, DatasetError, validateContent, type DatasetContent } from './model';

const PREFIX = `data:${DATASET_MIME};base64,`;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Base64 máximo aceito na leitura para um limite em bytes (o mesmo usado na gravação). */
const maxBase64 = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4;

/**
 * Conteúdo → asset (não grava). O limite é em BYTES UTF-8 — a mesma unidade conferida na leitura (revisão do
 * Codex, PR #27: limitar caracteres UTF-16 deixava gravar conteúdo com muito Unicode que depois não relia).
 */
export function encodeDatasetAsset(content: DatasetContent, name: string, id = uid('ds_'), maxBytes: number = DATASET_LIMITS.maxStoredBytes): Asset {
  const bytes = new TextEncoder().encode(JSON.stringify(validateContent(content)));
  if (bytes.length > maxBytes) throw new DatasetError(`Conjunto de dados grande demais para guardar (${(bytes.length / 1024 / 1024).toFixed(1)} MB; limite de ${(maxBytes / 1024 / 1024).toFixed(0)} MB).`);
  const dataURL = PREFIX + toBase64(bytes);
  return { id, mimeType: DATASET_MIME, dataURL, name: name.slice(0, 200), size: bytes.length, createdAt: Date.now() };
}

/** Asset → conteúdo validado. Lança `DatasetError` para qualquer coisa que não seja um dataset íntegro. */
export function decodeDatasetAsset(asset: Pick<Asset, 'mimeType' | 'dataURL'>, maxBytes: number = DATASET_LIMITS.maxStoredBytes): DatasetContent {
  if (asset.mimeType !== DATASET_MIME || !asset.dataURL.startsWith(PREFIX)) throw new DatasetError('O arquivo guardado não é um conjunto de dados.');
  const b64 = asset.dataURL.slice(PREFIX.length);
  // Pré-checagem barata pelo tamanho do base64; depois, o limite exato em bytes (o mesmo da gravação).
  if (b64.length > maxBase64(maxBytes)) throw new DatasetError('Conjunto de dados guardado grande demais.');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    throw new DatasetError('Conjunto de dados guardado está corrompido.');
  }
  if (bytes.length > maxBytes) throw new DatasetError('Conjunto de dados guardado grande demais.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DatasetError('Conjunto de dados guardado está corrompido.');
  }
  return validateContent(raw);
}

/** Asset com o tipo de conjunto de dados (pelo cabeçalho; o conteúdo é validado por `decodeDatasetAsset`). */
export function isDatasetAsset(a: Pick<Asset, 'mimeType' | 'dataURL'>): boolean {
  return a.mimeType === DATASET_MIME || a.dataURL.startsWith(PREFIX);
}
