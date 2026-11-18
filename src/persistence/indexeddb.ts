/** Adaptador IndexedDB (persistência local principal). */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Asset, Board, BoardMeta, Workspace } from '../core/schema';
import { metaOf, type PersistenceAdapter } from './adapter';

interface AuroraDB extends DBSchema {
  workspaces: { key: string; value: Workspace };
  boardMeta: { key: string; value: BoardMeta; indexes: { byWorkspace: string } };
  boards: { key: string; value: Board };
  assets: { key: string; value: Asset };
  kv: { key: string; value: { key: string; value: unknown } };
}

export const DB_NAME = 'aurora-board';
const DB_VERSION = 1;

export class IndexedDBAdapter implements PersistenceAdapter {
  readonly name = 'indexeddb';
  private dbp: Promise<IDBPDatabase<AuroraDB>>;

  constructor(dbName = DB_NAME) {
    this.dbp = openDB<AuroraDB>(dbName, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
        const meta = db.createObjectStore('boardMeta', { keyPath: 'id' });
        meta.createIndex('byWorkspace', 'workspaceId');
        db.createObjectStore('boards', { keyPath: 'id' });
        db.createObjectStore('assets', { keyPath: 'id' });
        db.createObjectStore('kv', { keyPath: 'key' });
      },
    });
  }

  async listWorkspaces() { return (await this.dbp).getAll('workspaces'); }
  async saveWorkspace(ws: Workspace) { await (await this.dbp).put('workspaces', ws); }
  async deleteWorkspace(id: string) {
    const db = await this.dbp;
    const metas = await db.getAllFromIndex('boardMeta', 'byWorkspace', id);
    const tx = db.transaction(['workspaces', 'boardMeta', 'boards'], 'readwrite');
    await tx.objectStore('workspaces').delete(id);
    for (const m of metas) {
      await tx.objectStore('boardMeta').delete(m.id);
      await tx.objectStore('boards').delete(m.id);
    }
    await tx.done;
  }
  async listBoards(workspaceId: string) { return (await this.dbp).getAllFromIndex('boardMeta', 'byWorkspace', workspaceId); }
  async loadBoard(id: string) { return (await (await this.dbp).get('boards', id)) ?? null; }
  async saveBoard(board: Board) {
    const db = await this.dbp;
    const tx = db.transaction(['boards', 'boardMeta'], 'readwrite');
    await Promise.all([tx.objectStore('boards').put(board), tx.objectStore('boardMeta').put(metaOf(board)), tx.done]);
  }
  async deleteBoard(id: string) {
    const db = await this.dbp;
    const tx = db.transaction(['boards', 'boardMeta'], 'readwrite');
    await Promise.all([tx.objectStore('boards').delete(id), tx.objectStore('boardMeta').delete(id), tx.done]);
  }
  async getAsset(id: string) { return (await (await this.dbp).get('assets', id)) ?? null; }
  async putAsset(asset: Asset) { await (await this.dbp).put('assets', asset); }
  async getSetting<T>(key: string) { return (await (await this.dbp).get('kv', key))?.value as T | undefined; }
  async setSetting<T>(key: string, value: T) { await (await this.dbp).put('kv', { key, value }); }
}
