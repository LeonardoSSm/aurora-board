/**
 * Data Hub (D2-A) — persistência e cache dos conjuntos de dados.
 *
 * - Conteúdo = asset IMUTÁVEL (`DATASET_MIME`, JSON normalizado em base64) no armazenamento local do app
 *   (IndexedDB `aurora-board`, área `assets`). Substituir os dados de um bloco cria um asset novo; o antigo
 *   continua valendo para cópias/duplicatas e para o desfazer (copy-on-write).
 * - Por que asset e não um banco novo: os backups de quadros já carregam assets referenciados com limites,
 *   validação, aviso de ausentes e gravação ATÔMICA (uma transação). Um banco separado não poderia ser
 *   restaurado na mesma transação dos quadros. Nenhuma mudança de esquema/migração é necessária.
 * - Leitura sempre VALIDADA (`validateContent`): o asset pode vir de um backup forjado.
 * - Cache em memória limitado por células (LRU). Não usa o cache genérico de assets (evita duas cópias do texto).
 * - Toda mudança do cache recalcula o fluxo de dados (`bumpExternalData`), sem alterar o quadro.
 */
import { getAdapter } from '../persistence/autosave';
import { bumpExternalData } from '../widgets/dataflow';
import { DATASET_LIMITS, DatasetError, validateContent, type DatasetContent } from './model';
import { decodeDatasetAsset, encodeDatasetAsset } from './codec';

export { decodeDatasetAsset, encodeDatasetAsset };

export type DatasetEntry =
  | { status: 'loading' }
  | { status: 'ready'; content: DatasetContent; cells: number }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/* ------------------------------------------------------------------ cache */

const cache = new Map<string, DatasetEntry>();
let cachedCells = 0;
const listeners = new Set<() => void>();
let version = 0;

export function datasetVersion() { return version; }
export function subscribeDatasets(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function changed() {
  version++;
  for (const l of listeners) l();
  bumpExternalData();
}

function setEntry(id: string, e: DatasetEntry) {
  const prev = cache.get(id);
  if (prev?.status === 'ready') cachedCells -= prev.cells;
  cache.delete(id); // reinsere no fim: ordem do Map = uso mais recente por último (LRU)
  cache.set(id, e);
  if (e.status === 'ready') {
    cachedCells += e.cells;
    for (const [k, v] of cache) {
      if (cachedCells <= DATASET_LIMITS.maxCachedCells) break;
      if (k === id || v.status !== 'ready') continue;
      cache.delete(k);
      cachedCells -= v.cells;
    }
  }
}

/** Estado do dataset no cache (sem disparar leitura). Marca como usado recentemente. */
export function datasetEntry(assetId: string): DatasetEntry | undefined {
  const e = cache.get(assetId);
  if (e?.status === 'ready') { cache.delete(assetId); cache.set(assetId, e); }
  return e;
}

const pending = new Map<string, Promise<void>>();

/** Garante a leitura do dataset (idempotente); o fluxo de dados é recalculado quando ela termina. */
export function requestDataset(assetId: string): Promise<void> {
  const e = cache.get(assetId);
  if (e && e.status !== 'loading') return Promise.resolve();
  const p = pending.get(assetId);
  if (p) return p;
  cache.set(assetId, { status: 'loading' });
  const job = (async () => {
    try {
      const asset = await getAdapter().getAsset(assetId);
      if (!asset) setEntry(assetId, { status: 'missing' });
      else {
        const content = decodeDatasetAsset(asset);
        setEntry(assetId, { status: 'ready', content, cells: Math.max(1, content.rows.length * content.columns.length) });
      }
    } catch (e) {
      // Mensagem genérica: nunca ecoa o conteúdo do arquivo.
      setEntry(assetId, { status: 'error', message: e instanceof DatasetError ? e.message : 'Não foi possível ler os dados guardados.' });
    } finally {
      pending.delete(assetId);
      changed();
    }
  })();
  pending.set(assetId, job);
  return job;
}

/** Grava um dataset novo (asset imutável) e já o deixa no cache. Retorna o id do asset. */
export async function saveDataset(content: DatasetContent, name: string): Promise<string> {
  const asset = encodeDatasetAsset(content, name);
  await getAdapter().putAsset(asset);
  const stored = validateContent(content);
  setEntry(asset.id, { status: 'ready', content: stored, cells: Math.max(1, stored.rows.length * stored.columns.length) });
  changed();
  return asset.id;
}

/** Apaga o asset do armazenamento local e do cache (o chamador confere antes que nada mais o referencia). */
export async function deleteDatasetAsset(assetId: string): Promise<void> {
  const a = getAdapter();
  if (!a.deleteAsset) throw new DatasetError('Este armazenamento não permite apagar arquivos.');
  await a.deleteAsset(assetId);
  setEntry(assetId, { status: 'missing' });
  changed();
}

/** Lê o conteúdo para exportação (carrega se preciso). */
export async function loadDatasetContent(assetId: string): Promise<DatasetContent> {
  await requestDataset(assetId);
  const e = cache.get(assetId);
  if (e?.status === 'ready') return e.content;
  throw new DatasetError(e?.status === 'error' ? e.message : 'Os dados deste bloco não estão disponíveis neste dispositivo.');
}

/** Testes: zera o cache. */
export function resetDatasetCacheForTests() {
  cache.clear();
  pending.clear();
  cachedCells = 0;
  version = 0;
}
