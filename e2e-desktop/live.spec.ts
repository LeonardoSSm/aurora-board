/**
 * Homologação AO VIVO do aplicativo desktop (exige internet): só roda com AURORA_LIVE=1 — fora da CI, que não
 * deve depender de serviços externos. Caminho completo, sem simulação: widget HTML → aurora.request() → corretor
 * do host → IPC → processo principal → api.github.com; depois fecha e reabre o app no mesmo perfil.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './harness';

const LIVE = process.env.AURORA_LIVE === '1';
const GH = 'https://api.github.com/repos/LeonardoSSm/aurora-board';
const HTML = `<div id="r">-</div><button id="go">ir</button><script>
  document.getElementById('go').onclick = async () => {
    try { const x = await aurora.request({ url: '${GH}' }); document.getElementById('r').textContent = x.status + '|' + x.data.full_name; }
    catch (e) { document.getElementById('r').textContent = 'erro:' + e.code; }
  };</script>`;

test('ao vivo: GitHub real pelo app desktop; autorização permanente sobrevive a fechar e abrir', async () => {
  test.skip(!LIVE, 'Homologação ao vivo: defina AURORA_LIVE=1 (exige internet).');
  const dir = mkdtempSync(join(tmpdir(), 'aurora-desktop-live-'));
  try {
    let s = await launch(dir);
    try {
      await s.page.locator('[data-library-item="aurora.sandbox-html"]').click();
      await s.page.getByRole('button', { name: 'Editar HTML' }).click();
      await s.page.locator('[data-type="widget"] textarea').fill(HTML);
      await s.page.getByRole('button', { name: 'Aplicar' }).click();
      const f = s.page.frameLocator('iframe[sandbox]').first();
      await f.locator('#go').click();
      const dlg = s.page.getByRole('dialog');
      await expect(dlg.getByTestId('net-consent-origin')).toHaveText('https://api.github.com');
      await dlg.getByRole('button', { name: 'Permitir sempre neste dispositivo' }).click();
      await expect(f.locator('#r')).toHaveText('200|LeonardoSSm/aurora-board', { timeout: 20_000 });
      await s.page.waitForTimeout(1500); // autosave
    } finally {
      await s.close();
    }
    s = await launch(dir);
    try {
      const f = s.page.frameLocator('iframe[sandbox]').first();
      await f.locator('#go').click();
      await expect(f.locator('#r')).toHaveText('200|LeonardoSSm/aurora-board', { timeout: 20_000 });
      await expect(s.page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await s.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* arquivos presos */ }
  }
});
