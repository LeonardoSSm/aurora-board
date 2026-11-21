/**
 * Build do Aurora Board Desktop (D1) → pasta de aplicativo `desktop-app/` (o que o electron-builder empacota):
 *   desktop-app/package.json   manifesto mínimo (SEM dependências: tudo já vai embutido nos bundles)
 *   desktop-app/main.cjs       processo principal (esbuild; inclui hosting/ e server/ necessários)
 *   desktop-app/preload.cjs    preload isolado (só requer 'electron')
 *   desktop-app/renderer/      frontend (o MESMO código da web) com VITE_AURORA_DESKTOP=1
 * Uso: `npm run build:desktop` · `--test-hooks` gera um build de TESTE com window.__aurora (nunca distribuído).
 */
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const root = resolve(import.meta.dirname, '..', '..');
const out = resolve(root, 'desktop-app');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

process.env.VITE_AURORA_DESKTOP = '1';
if (args.has('--test-hooks')) process.env.VITE_AURORA_TEST_HOOKS = '1';
await viteBuild({ root, logLevel: 'warn', build: { outDir: resolve(out, 'renderer'), emptyOutDir: true } });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, legalComments: 'none', logLevel: 'warning', external: ['electron'] };
await esbuild({ ...common, entryPoints: [resolve(root, 'desktop/main.ts')], outfile: resolve(out, 'main.cjs') });
await esbuild({ ...common, entryPoints: [resolve(root, 'desktop/preload.ts')], outfile: resolve(out, 'preload.cjs') });

writeFileSync(resolve(out, 'package.json'), JSON.stringify({
  name: 'aurora-board-desktop',
  productName: 'Aurora Board',
  version: pkg.version,
  description: 'Aurora Board — workspace visual infinito (aplicativo desktop)',
  author: 'Aurora Board',
  license: 'UNLICENSED',
  main: 'main.cjs',
  ...(args.has('--test-hooks') ? { auroraTestBuild: true } : {}),
}, null, 2) + '\n');
console.log(`[desktop] pronto em desktop-app/${args.has('--test-hooks') ? ' (BUILD DE TESTE com ganchos)' : ''}`);
