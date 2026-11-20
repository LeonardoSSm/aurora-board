#!/usr/bin/env node
/**
 * CI-1 (#25): confere, ANTES dos testes, que a imagem Docker do Playwright usada pela CI traz exatamente
 * os navegadores que a versão instalada do `@playwright/test` espera.
 *
 * Por quê: a CI roda os E2E dentro de `mcr.microsoft.com/playwright:vX.Y.Z-noble@sha256:…` e NÃO executa
 * `playwright install` (nem apt). Se o lockfile subir o Playwright sem atualizar a imagem, cada teste
 * falharia com "Executable doesn't exist" (lento, com novas tentativas). Aqui a falha é imediata e explica
 * o que fazer.
 *
 * Uso: node scripts/ci/check-playwright-browsers.mjs [chromium|firefox|webkit|mobile ...]
 *      (sem argumentos confere todos os navegadores instalados por padrão)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// `browsers.json` não é exportado pelo pacote: resolve pelo package.json (que é exportado).
const coreDir = dirname(require.resolve('playwright-core/package.json'));
const testVersion = require('@playwright/test/package.json').version;
const coreVersion = require('playwright-core/package.json').version;
const { browsers } = JSON.parse(readFileSync(join(coreDir, 'browsers.json'), 'utf8'));

const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (!root) {
  console.error('::error::PLAYWRIGHT_BROWSERS_PATH não definido — este passo deve rodar dentro da imagem oficial do Playwright.');
  process.exit(1);
}

/** Projeto do Playwright → navegadores (diretórios em PLAYWRIGHT_BROWSERS_PATH) de que ele precisa. */
const NEEDS = {
  chromium: ['chromium', 'chromium-headless-shell', 'ffmpeg'],
  mobile: ['chromium', 'chromium-headless-shell', 'ffmpeg'],
  firefox: ['firefox', 'ffmpeg'],
  webkit: ['webkit', 'ffmpeg'],
};
const projects = process.argv.slice(2);
const wanted = projects.length
  ? [...new Set(projects.flatMap((p) => {
      if (!NEEDS[p]) { console.error(`::error::projeto desconhecido: ${p}`); process.exit(1); }
      return NEEDS[p];
    }))]
  : browsers.filter((b) => b.installByDefault).map((b) => b.name);

const missing = [];
for (const name of wanted) {
  const entry = browsers.find((b) => b.name === name);
  if (!entry) { missing.push(`${name} (ausente em browsers.json)`); continue; }
  const dir = join(root, `${name.replace(/-/g, '_')}-${entry.revision}`);
  if (existsSync(dir)) console.log(`ok  ${name} r${entry.revision} → ${dir}`);
  else missing.push(`${name} r${entry.revision} (esperado em ${dir})`);
}

console.log(`@playwright/test ${testVersion} · playwright-core ${coreVersion}`);
if (testVersion !== coreVersion) {
  console.error(`::error::@playwright/test (${testVersion}) e playwright-core (${coreVersion}) divergem no lockfile.`);
  process.exit(1);
}
if (missing.length) {
  console.error(
    `::error::A imagem do Playwright não corresponde ao @playwright/test ${testVersion}. Faltam: ${missing.join('; ')}. ` +
      'Atualize a tag e o digest de mcr.microsoft.com/playwright em .github/workflows/ci.yml (ver docs/DEVELOPMENT.md › CI).',
  );
  process.exit(1);
}
