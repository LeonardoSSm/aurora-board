import 'fake-indexeddb/auto';

/** localStorage em memória para o ambiente Node (com hook para simular falha de quota). */
class MemoryStorage {
  private map = new Map<string, string>();
  failWrites: false | 'quota' = false;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) {
    if (this.failWrites === 'quota') {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map.set(k, String(v));
  }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
}

/** window/document mínimos (eventos de ciclo de vida da página usados pelo autosave). */
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true, writable: true });
}
if (typeof globalThis.document === 'undefined') {
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { visibilityState: 'visible' }), configurable: true, writable: true });
}
