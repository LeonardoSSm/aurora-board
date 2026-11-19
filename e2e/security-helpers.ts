/**
 * Utilitários dos testes de segurança (Ciclo S1).
 * Todos os dados são fictícios e tudo acontece no próprio navegador do teste (sem servidores externos).
 */
import { expect, type Page } from '@playwright/test';

export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Carga "sentinela": se executar com acesso à origem do Aurora Board, marca o DOM do app, grava no
 * localStorage e tenta ler o IndexedDB. Os testes verificam que NADA disso acontece.
 */
export const SENTINEL_SCRIPT = `
<script>
  try { parent.document.documentElement.setAttribute('data-pwned', 'parent-dom'); } catch (e) {}
  try { top.document.documentElement.setAttribute('data-pwned', 'top-dom'); } catch (e) {}
  try { localStorage.setItem('aurora-s1-pwned', 'storage'); } catch (e) {}
  try { document.documentElement.setAttribute('data-self-origin', String(location.origin)); } catch (e) {}
  try {
    var r = indexedDB.open('aurora-board');
    r.onsuccess = function () { try { parent.document.documentElement.setAttribute('data-pwned-idb', String(r.result.objectStoreNames.length)); } catch (e) {} };
  } catch (e) {}
</script>`;

export const SENTINEL_HTML = `<!doctype html><html><body><h1>relatorio</h1>${SENTINEL_SCRIPT}</body></html>`;

export function el(partial: Record<string, unknown>) {
  return { x: 100, y: 100, width: 360, height: 380, ...partial };
}

export function backup(elements: unknown[], assets: unknown[] = [], name = 'Quadro S1') {
  return {
    format: 'aurora-board',
    schemaVersion: 3,
    exportedAt: Date.now(),
    app: 'Aurora Board 1.0.0',
    boards: [{ id: `b_s1_${Math.random().toString(36).slice(2)}`, name, elements }],
    assets,
  };
}

/** Importa um backup pela interface (mesmo caminho que o usuário usa). */
export async function importBackup(page: Page, data: unknown, fileName = 'backup.aurora.json') {
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  await (await chooser).setFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
}

export async function confirmImport(page: Page) {
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
}

/** Confere que nenhum marcador da carga sentinela apareceu na origem do app. */
export async function expectNotPwned(page: Page) {
  const r = await page.evaluate(() => ({
    dom: document.documentElement.getAttribute('data-pwned'),
    idb: document.documentElement.getAttribute('data-pwned-idb'),
    storage: localStorage.getItem('aurora-s1-pwned'),
  }));
  expect(r, 'conteúdo importado não pode alcançar DOM/armazenamento do app').toEqual({ dom: null, idb: null, storage: null });
}
