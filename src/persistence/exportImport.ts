/** Exportação e importação de arquivos JSON (formato atual + compatibilidade v0.2/v0.3). */
import type { Asset, AuroraElement, Board, Workspace } from '../core/schema';
import { ExportFileSchema, SCHEMA_VERSION } from '../core/schema';
import { migrateBoard } from './migrations';
import { importLegacy, isLegacyFormat } from './legacy';
import { checkGenericBudget, checkImportBudget, IMPORT_LIMITS, ImportBudgetError } from './importBudget';
import { blockActiveContent } from '../core/widgetData';
import { revokeRemoteImageConsent } from '../core/smartLinks';
import type { PersistenceAdapter } from './adapter';
import { decodeDatasetAsset, isDatasetAsset } from '../data/codec';
import { uid } from '../core/elements';

export const APP_VERSION = 'Aurora Board 1.0.0';
export const MAX_IMPORT_BYTES = IMPORT_LIMITS.maxFileBytes;
const MAX_BOARDS = IMPORT_LIMITS.maxBoards;
const MAX_ELEMENTS = IMPORT_LIMITS.maxElementsPerBoard;

export class ImportError extends Error {}

/** Checagem antes de ler o arquivo (S1-SEC-004): evita carregar na memória o que já excede o limite. */
export function checkImportFileSize(size: number): void {
  if (size > MAX_IMPORT_BYTES) throw new ImportError(`Arquivo grande demais (${(size / 1024 / 1024).toFixed(0)} MB; limite de ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`);
}

/** Formato mínimo aceito para o conteúdo de um asset. */
const DATA_URL_HEAD = /^data:[\w.+-]*(\/[\w.+-]+)?(;[\w.+-]+(=[\w.+-]+)?)*,/i;

export interface ImportResult {
  source: 'aurora' | 'legacy-v0.3';
  boards: Board[];
  assets: Asset[];
  warnings: string[];
  /** `activeContent`: widgets HTML importados DESATIVADOS (exigem ativação consciente). */
  stats: { boards: number; elements: number; activeContent: number };
}

export function assetIdsOf(elements: AuroraElement[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === 'image') ids.add(el.assetId);
    if (el.type === 'widget' && el.data && typeof el.data === 'object') {
      const docs = (el.data as { docs?: { assetId?: string }[] }).docs;
      if (Array.isArray(docs)) for (const d of docs) if (d?.assetId) ids.add(d.assetId);
      // Issue #22: imagem enviada de um atalho visual.
      const visual = (el.data as { visual?: { assetId?: unknown } }).visual;
      if (el.widgetType === 'aurora.link' && visual && typeof visual.assetId === 'string' && visual.assetId) ids.add(visual.assetId);
      // Issue #24 (Data Hub): conteúdo de um conjunto de dados importado.
      const ds = datasetAssetIdOf(el);
      if (ds) ids.add(ds);
    }
  }
  return ids;
}

/** Issue #24: id do asset de dados importados referenciado por um bloco `aurora.dataset` (ou null). */
export function datasetAssetIdOf(el: AuroraElement): string | null {
  if (el.type !== 'widget' || el.widgetType !== 'aurora.dataset' || !el.data || typeof el.data !== 'object') return null;
  const source = (el.data as { source?: { assetId?: unknown } }).source;
  return source && typeof source.assetId === 'string' && source.assetId ? source.assetId : null;
}

/** Troca a referência de dados importados de um bloco segundo o mapa (ids antigos → novos). */
function remapDatasetAsset(el: AuroraElement, remap: ReadonlyMap<string, string>): AuroraElement {
  const old = datasetAssetIdOf(el);
  const next = old ? remap.get(old) : undefined;
  if (!next || el.type !== 'widget') return el;
  const data = el.data as { source: Record<string, unknown> };
  return { ...el, data: { ...data, source: { ...data.source, assetId: next } } };
}

/** Assets de dados importados (Data Hub) usados por estes elementos — os backups pedem decisão explícita sobre eles. */
export function datasetAssetIdsOf(elements: AuroraElement[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) { const id = datasetAssetIdOf(el); if (id) ids.add(id); }
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
  // Ciclo F1: backups financeiros têm formato e caminho próprios; o backup pessoal completo traz os quadros
  // em `boards` (a parte financeira NÃO é importada por aqui).
  let personalNote: string | null = null;
  const top = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (top?.format === 'aurora-finance' || top?.format === 'aurora-finance-encrypted') {
    throw new ImportError('Este é um backup financeiro: restaure em Minhas contas → Privacidade e backups.');
  }
  if (top?.format === 'aurora-personal-backup') {
    data = top.boards;
    personalNote = 'Backup pessoal completo: só os quadros foram lidos aqui. Restaure as finanças em Minhas contas → Privacidade e backups.';
  }
  // Orçamento de complexidade ANTES da validação/migração completas (S1-SEC-004/005).
  try {
    if (isLegacyFormat(data)) checkGenericBudget(data);
    else checkImportBudget(data);
  } catch (e) {
    if (e instanceof ImportBudgetError) throw new ImportError(`Importação recusada por segurança: ${e.message}`);
    throw e;
  }
  if (isLegacyFormat(data)) {
    const r = importLegacy(data, workspaceId);
    if (!r.boards.length) throw new ImportError('Arquivo v0.2/v0.3 sem quadros.');
    // S1-SEC-020: o legado passa pelo orçamento genérico; depois da conversão, os mesmos tetos de elementos.
    let total = 0;
    for (const b of r.boards) {
      if (b.elements.length > MAX_ELEMENTS) throw new ImportError(`Importação recusada por segurança: quadro "${b.name}" excede ${MAX_ELEMENTS} elementos.`);
      total += b.elements.length;
    }
    if (total > IMPORT_LIMITS.maxTotalElements) throw new ImportError(`Importação recusada por segurança: mais de ${IMPORT_LIMITS.maxTotalElements} elementos no total.`);
    const activeContent = r.boards.reduce((n, b) => n + blockActiveContent(b.elements as never, 'import'), 0);
    for (const b of r.boards) revokeRemoteImageConsent(b.elements as never);
    return { source: 'legacy-v0.3', boards: r.boards, assets: r.assets, warnings: r.warnings, stats: { boards: r.stats.boards, elements: r.stats.elements + r.stats.connections + r.stats.strokes, activeContent } };
  }
  const parsed = ExportFileSchema.safeParse(data);
  if (!parsed.success) {
    const d = data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && d.type === 'excalidraw') throw new ImportError('Arquivos do Excalidraw ainda não são suportados na importação.');
    throw new ImportError('Formato não reconhecido. Esperado: backup do Aurora Board (1.x) ou dados do protótipo v0.2/v0.3.');
  }
  const file = parsed.data;
  if (file.boards.length > MAX_BOARDS) throw new ImportError(`Arquivo com ${file.boards.length} quadros excede o limite de ${MAX_BOARDS}.`);
  const warnings: string[] = personalNote ? [personalNote] : [];
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
  // Valida os assets: data URL malformado é descartado com aviso (o elemento continua e mostra "arquivo
  // indisponível"); ids repetidos mantêm a primeira cópia. Assets sem referência conhecida são preservados
  // (podem pertencer a widgets de versões futuras).
  const assets: Asset[] = [];
  const seenAssets = new Set<string>();
  for (const a of file.assets) {
    if (seenAssets.has(a.id)) { warnings.push(`Arquivo/imagem ${a.id} repetido no backup: mantida a primeira cópia.`); continue; }
    seenAssets.add(a.id);
    if (!DATA_URL_HEAD.test(a.dataURL)) { warnings.push(`Arquivo "${a.name.slice(0, 60)}" (${a.id}) com conteúdo inválido descartado.`); continue; }
    // Issue #24: dados importados (Data Hub) são validados por inteiro ANTES de gravar (estrutura, tipos, limites).
    if (isDatasetAsset(a)) {
      try { decodeDatasetAsset(a); } catch (e) { warnings.push(`Dados importados "${a.name.slice(0, 60)}" (${a.id}) inválidos descartados: ${(e as Error).message}`); continue; }
    }
    assets.push(a);
  }
  const available = new Set(assets.map((a) => a.id));
  for (const b of boards) {
    for (const id of assetIdsOf(b.elements)) if (!available.has(id)) warnings.push(`Quadro "${b.name}": arquivo/imagem ${id} ausente no backup.`);
  }
  // Conteúdo ativo importado começa desativado, sobrescrevendo qualquer marcação vinda do arquivo (S1-SEC-003).
  const activeContent = boards.reduce((n, b) => n + blockActiveContent(b.elements as never, 'import'), 0);
  // Issue #22: opt-in de imagem remota de atalhos não atravessa backups (o arquivo não pode se declarar autorizado).
  for (const b of boards) revokeRemoteImageConsent(b.elements as never);
  return { source: 'aurora', boards, assets, warnings, stats: { boards: boards.length, elements, activeContent } };
}

/**
 * Grava o resultado de uma importação SEM sobrescrever nada:
 * - quadros com id já existente recebem um id novo;
 * - assets já existentes são mantidos (o do arquivo é ignorado).
 *
 * Atômica quando o adaptador oferece `commitImport` (IndexedDB e memória): assets, quadros e workspace entram
 * numa única transação — ou tudo é gravado, ou nada (S1-SEC-006). Antes, cada quadro precisa ser clonável
 * (clone estruturado), então um quadro "envenenado" é recusado sem efeito colateral.
 * Retorna os ids dos quadros criados, o workspace atualizado e os ids dos assets gravados.
 */
export async function applyImport(
  adapter: Pick<PersistenceAdapter, 'loadBoard' | 'saveBoard' | 'getAsset' | 'putAsset' | 'saveWorkspace'> & Partial<Pick<PersistenceAdapter, 'commitImport'>>,
  result: ImportResult,
  workspace: Workspace,
  newId: () => string,
): Promise<{ boardIds: string[]; workspace: Workspace; assetIds: string[] }> {
  const assets: Asset[] = [];
  // Issue #24: um conjunto de dados do backup com o MESMO id de um asset local DIFERENTE ganha id novo, e os
  // blocos importados passam a apontar para ele — nunca exibem silenciosamente o dado local no lugar do importado.
  const remap = new Map<string, string>();
  for (const a of result.assets) {
    const existing = await adapter.getAsset(a.id);
    if (!existing) { assets.push(a); continue; }
    if (isDatasetAsset(a) && existing.dataURL !== a.dataURL) {
      const id = uid('ds_');
      remap.set(a.id, id);
      assets.push({ ...a, id });
    }
  }
  const ids: string[] = [];
  const boards: Board[] = [];
  const taken = new Set<string>();
  for (const b of result.boards) {
    let id = b.id;
    if (taken.has(id) || (await adapter.loadBoard(id))) id = newId();
    taken.add(id);
    const elements = remap.size ? b.elements.map((el) => remapDatasetAsset(el, remap)) : b.elements;
    const board: Board = { ...b, id, elements, workspaceId: workspace.id, archived: false, updatedAt: Date.now() };
    try {
      structuredClone(board);
    } catch {
      throw new ImportError(`Quadro "${b.name}" não pode ser gravado (estrutura inválida). Nenhum dado foi alterado.`);
    }
    boards.push(board);
    ids.push(id);
  }
  const updated = { ...workspace, boardOrder: [...workspace.boardOrder, ...ids], updatedAt: Date.now() };
  if (adapter.commitImport) {
    await adapter.commitImport({ assets, boards, workspace: updated });
  } else {
    for (const a of assets) await adapter.putAsset(a);
    for (const b of boards) await adapter.saveBoard(b);
    await adapter.saveWorkspace(updated);
  }
  return { boardIds: ids, workspace: updated, assetIds: assets.map((a) => a.id) };
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
