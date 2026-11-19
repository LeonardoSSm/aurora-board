/**
 * Homologação local do frontend PÚBLICO (ciclo S1): build de produção padrão (estático, sem /api, sem
 * window.__aurora) servido por `vite preview` com os mesmos cabeçalhos da hospedagem (hosting/headers.ts).
 *
 *   npm run test:static                          → CSP aplicada (enforce)
 *   AURORA_CSP_MODE=report-only npm run test:static → fase 1: CSP só reporta (lista violações)
 */
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = 4174;

export default defineConfig({
  testDir: './e2e/static',
  timeout: 90_000,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['github']] : [['list']],
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 900 }, acceptDownloads: true, trace: 'off', reducedMotion: 'reduce' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { AURORA_CSP_MODE: process.env.AURORA_CSP_MODE ?? 'enforce' },
  },
});
