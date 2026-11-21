/**
 * Testes AO VIVO (exigem internet): homologação real de integrações. Fora da CI e do `npm run test:e2e`.
 * O próprio teste sobe e reinicia o Vite e o servidor local (portas 5193/8807) — ver e2e/live/.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/live',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
