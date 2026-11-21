/**
 * Gera os ícones do Aurora Board Desktop a partir de public/favicon.svg (a mesma identidade visual do app web):
 *   desktop/build/icon.png (1024 px, Windows — o electron-builder gera o .ico) e
 *   desktop/build/icons/<N>x<N>.png (Linux: 16…512).
 * Renderiza com o Chromium do Playwright (sem dependências novas). Uso: node scripts/desktop/make-icons.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const svg = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');
const out = resolve(root, 'desktop/build');
mkdirSync(resolve(out, 'icons'), { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [1024, 512, 256, 128, 64, 48, 32, 16]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    const file = size === 1024 ? resolve(out, 'icon.png') : resolve(out, 'icons', `${size}x${size}.png`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
} finally {
  await browser.close();
}
console.log('[desktop] ícones gerados em desktop/build/');
