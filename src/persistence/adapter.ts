/**
 * Camada de persistência substituível.
 *
 * O editor só conhece esta interface. Hoje há IndexedDB (navegador) e memória (testes).
 * Uma futura sincronização com backend (NestJS + Prisma + PostgreSQL) implementa a mesma interface
 * ou compõe IndexedDB (cache local/offline) + API remota.
 */
import type { Asset, Board, BoardMeta, Workspace } from '../core/schema';

export interface PersistenceAdapter {
  readonly name: string;
  listWorkspaces(): Promise<Workspace[]>;
  saveWorkspace(ws: Workspace): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  listBoards(workspaceId: string): Promise<BoardMeta[]>;
  loadBoard(id: string): Promise<Board | null>;
  saveBoard(board: Board): Promise<void>;
  deleteBoard(id: string): Promise<void>;
  getAsset(id: string): Promise<Asset | null>;
  putAsset(asset: Asset): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
  /** Grava uma importação inteira de forma atômica (tudo ou nada). Opcional para adaptadores futuros. */
  commitImport?(batch: { assets: Asset[]; boards: Board[]; workspace: Workspace }): Promise<void>;
}

export function metaOf(board: Board): BoardMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { elements: _el, ...meta } = board;
  return meta;
}

export class MemoryAdapter implements PersistenceAdapter {
  readonly name = 'memory';
  workspaces = new Map<string, Workspace>();
  boards = new Map<string, Board>();
  assets = new Map<string, Asset>();
  settings = new Map<string, unknown>();

  async listWorkspaces() { return [...this.workspaces.values()].map((w) => structuredClone(w)); }
  async saveWorkspace(ws: Workspace) { this.workspaces.set(ws.id, structuredClone(ws)); }
  async deleteWorkspace(id: string) {
    this.workspaces.delete(id);
    for (const [bid, b] of this.boards) if (b.workspaceId === id) this.boards.delete(bid);
  }
  async listBoards(workspaceId: string) {
    return [...this.boards.values()].filter((b) => b.workspaceId === workspaceId).map((b) => metaOf(structuredClone(b)));
  }
  async loadBoard(id: string) { const b = this.boards.get(id); return b ? structuredClone(b) : null; }
  async saveBoard(board: Board) { this.boards.set(board.id, structuredClone(board)); }
  async deleteBoard(id: string) { this.boards.delete(id); }
  async getAsset(id: string) { return this.assets.get(id) ?? null; }
  async putAsset(asset: Asset) { this.assets.set(asset.id, asset); }
  async getSetting<T>(key: string) { return this.settings.get(key) as T | undefined; }
  async setSetting<T>(key: string, value: T) { this.settings.set(key, value); }
  /** Para testes: falha simulada no meio da gravação de uma importação. */
  failCommitAfter: number | null = null;
  async commitImport(batch: { assets: Asset[]; boards: Board[]; workspace: Workspace }) {
    // Clona tudo ANTES de alterar qualquer mapa: uma falha não deixa estado parcial (como a transação do IndexedDB).
    const staged = { assets: batch.assets.map((a) => structuredClone(a)), boards: batch.boards.map((b) => structuredClone(b)), workspace: structuredClone(batch.workspace) };
    if (this.failCommitAfter !== null && staged.assets.length + staged.boards.length > this.failCommitAfter) throw new Error('Falha simulada de gravação.');
    for (const a of staged.assets) this.assets.set(a.id, a);
    for (const b of staged.boards) this.boards.set(b.id, b);
    this.workspaces.set(staged.workspace.id, staged.workspace);
  }
}
