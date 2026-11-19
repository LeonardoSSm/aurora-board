/**
 * Benchmark de desempenho (não faz parte do `npm run test:e2e`).
 * Roda contra o BUILD DE PRODUÇÃO (vite preview), em Chromium, com GC exposto para medir memória.
 *   npm run perf            → resultados em perf-results/<rótulo>.json e tabela no console
 *   PERF_LABEL=depois npm run perf
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/perf',
  testMatch: '**/*.perf.ts',
  timeout: 15 * 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] },
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 180_000,
    // Benchmarks leem o estado por window.__aurora: este build local (não publicado) liga os ganchos
    // explicitamente. O build público padrão não os tem (S1-SEC-009).
    env: { VITE_AURORA_TEST_HOOKS: '1', VITE_AURORA_LOCAL_API: '1' },
  },
});
