import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  // e2e/static roda contra o build público (playwright.static.config.ts), não contra o dev server.
  testIgnore: ['**/perf/**', '**/static/**', '**/live/**'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // No CI uma nova tentativa separa instabilidade (passa na 2ª) de falha real (falha nas duas).
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    trace: CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: CI ? 'retain-on-failure' : 'off',
    acceptDownloads: true,
    // Câmera sem animação por padrão: testes antigos leem a câmera logo após cada ação.
    // Os testes de câmera/checkpoints ativam o movimento com test.use({ reducedMotion: 'no-preference' }).
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: ['**/mobile.spec.ts', '**/perf/**', '**/static/**', '**/live/**'] },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } }, testIgnore: ['**/mobile.spec.ts', '**/perf/**', '**/static/**', '**/live/**'] },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }, testIgnore: ['**/mobile.spec.ts', '**/perf/**', '**/static/**', '**/live/**'] },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: ['**/mobile.spec.ts'] },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !CI,
    timeout: 120_000,
  },
});
