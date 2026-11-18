/** Exportação e importação de arquivos JSON (formato atual + compatibilidade v0.2/v0.3). */
import type { Asset, AuroraElement, Board, Workspace } from '../core/schema';
import { ExportFileSchema, SCHEMA_VERSION } from '../core/schema';
import { migrateBoard } from './migrations';
import { importLegacy, isLegacyFormat } from './legacy';

export const APP_VERSION = 'Aurora Board 1.0.0';
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const MAX_BOARDS = 500;
const MAX_ELEMENTS = 100_000;

export class ImportError extends Error {}

export interface ImportResult {
  source: 'aurora' | 'legacy-v0.3';
  boards: Board[];
  assets: Asset[];
  warnings: string[];
  stats: { boards: number; elements: number };
}

export function assetIdsOf(elements: AuroraElement[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === 'image') ids.add(el.assetId);
    if (el.type === 'widget' && el.data && typeof el.data === 'object') {
      const docs = (el.data as { docs?: { assetId?: string }[] }).docs;
      if (Array.isArray(docs)) for (const d of docs) if (d?.assetId) ids.add(d.assetId);
    }
  }
  return ids;
}

export function buildExport(boards: Board[], assets: Asset[], workspace?: Workspace): string {
  const file = {
    format: 'aurora-board' as const,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    app: APP_VERSION,
    workspace,
    boards,
    assets,
  };
  return JSON.stringify(file);
}

export function parseImport(text: string, workspaceId: string): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('Arquivo grande demais (limite de 200 MB).');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('O arquivo não é um JSON válido.');
  }
  if (isLegacyFormat(data)) {
    const r = importLegacy(data, workspaceId);
    if (!r.boards.length) throw new ImportError('Arquivo v0.2/v0.3 sem quadros.');
    return { source: 'legacy-v0.3', boards: r.boards, assets: r.assets, warnings: r.warnings, stats: { boards: r.stats.boards, elements: r.stats.elements + r.stats.connections + r.stats.strokes } };
  }
  const parsed = ExportFileSchema.safeParse(data);
  if (!parsed.success) {
    const d = data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && d.type === 'excalidraw') throw new ImportError('Arquivos do Excalidraw ainda não são suportados na importação.');
    throw new ImportError('Formato não reconhecido. Esperado: backup do Aurora Board (1.x) ou dados do protótipo v0.2/v0.3.');
  }
  const file = parsed.data;
  if (file.boards.length > MAX_BOARDS) throw new ImportError(`Arquivo com ${file.boards.length} quadros excede o limite de ${MAX_BOARDS}.`);
  const warnings: string[] = [];
  if (file.schemaVersion > SCHEMA_VERSION) warnings.push(`Arquivo gerado por versão mais nova do esquema (${file.schemaVersion}). Alguns dados podem não ser reconhecidos.`);
  const boards: Board[] = [];
  let elements = 0;
  for (const raw of file.boards) {
    const { board, warnings: w } = migrateBoard(raw, workspaceId);
    if (board.elements.length > MAX_ELEMENTS) throw new ImportError(`Quadro "${board.name}" excede ${MAX_ELEMENTS} elementos.`);
    warnings.push(...w);
    elements += board.elements.length;
    boards.push(board);
  }
  // Valida referências de assets.
  const available = new Set(file.assets.map((a) => a.id));
  for (const b of boards) {
    for (const id of assetIdsOf(b.elements)) if (!available.has(id)) warnings.push(`Quadro "${b.name}": arquivo/imagem ${id} ausente no backup.`);
  }
  return { source: 'aurora', boards, assets: file.assets, warnings, stats: { boards: boards.length, elements } };
}

export function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(name: string): string {
  return (name || 'quadro').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'quadro';
}
