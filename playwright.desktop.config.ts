/**
 * Testes do Aurora Board Desktop (Electron). Pré-requisito: `npm run build:desktop` (ou um pacote em
 * AURORA_DESKTOP_EXECUTABLE). Fora do `npm run test:e2e` (que testa o frontend no Vite).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-desktop',
  timeout: 90_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' },
});
