/**
 * Ciclo S1 — testes adversariais controlados (somente locais, dados fictícios).
 *
 * Cada teste descreve o comportamento SEGURO esperado; antes das correções do ciclo S1 os cenários
 * marcados com "[reprodução]" falhavam (ver docs/security/S1-INDEPENDENT-AUDIT.md).
 */
import { expect, test } from '@playwright/test';
import { ready, state } from './helpers';
import { b64, backup, confirmImport, el, expectNotPwned, importBackup, SENTINEL_HTML, SENTINEL_SCRIPT } from './security-helpers';

test.beforeEach(async ({ page }) => {
  await ready(page);
  await page.evaluate(() => localStorage.removeItem('aurora-s1-pwned'));
});

function docsBoard(doc: Record<string, unknown>, asset: Record<string, unknown>) {
  const id = 'd_s1';
  return backup(
    [el({ id: 'w_docs', type: 'widget', widgetType: 'aurora.documents', title: 'Documentos', data: { selected: id, docs: [{ id, name: 'relatorio.pdf', size: 1200, url: '', description: '', tags: [], addedAt: 1, assetId: 'a_s1_doc', ...doc }] } })],
    [{ id: 'a_s1_doc', name: 'relatorio.pdf', size: 1200, createdAt: 1, ...asset }],
    'Documento suspeito',
  );
}

test.describe('S1-SEC-001: documentos importados não executam na origem do app', () => {
  test('[reprodução] HTML com metadado application/pdf e data URL text/html', async ({ page }) => {
    await importBackup(page, docsBoard({ mimeType: 'application/pdf' }, { mimeType: 'application/pdf', dataURL: `data:text/html;base64,${b64(SENTINEL_HTML)}` }));
    await confirmImport(page);
    await expect.poll(async () => (await state(page)).elements.some((e) => e.widgetType === 'aurora.documents')).toBe(true);
    await page.waitForTimeout(1500);
    await expectNotPwned(page);
    // Nenhum iframe de documento sem sandbox pode existir no app.
    expect(await page.locator('iframe:not([sandbox])').count()).toBe(0);
  });

  test('HTML disfarçado é exibido como texto, com aviso de tipo inconsistente', async ({ page }) => {
    await importBackup(page, docsBoard({ mimeType: 'application/pdf' }, { mimeType: 'application/pdf', dataURL: `data:text/html;base64,${b64(SENTINEL_HTML)}` }));
    await confirmImport(page);
    await expect(page.getByTestId('doc-preview')).toHaveAttribute('data-preview', 'text');
    await expect(page.getByTestId('doc-mismatch')).toBeVisible();
    await expect(page.locator('[data-testid="doc-preview"] pre')).toContainText('<script>');
    await expectNotPwned(page);
  });

  test('PDF válido: sem prévia embutida, download disponível como octet-stream', async ({ page }) => {
    const pdf = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
    await importBackup(page, docsBoard({ mimeType: 'application/pdf' }, { mimeType: 'application/pdf', dataURL: `data:application/pdf;base64,${b64(pdf)}` }));
    await confirmImport(page);
    await expect(page.getByTestId('doc-preview')).toHaveAttribute('data-sniffed', 'pdf');
    await expect(page.getByTestId('doc-preview')).toHaveAttribute('data-preview', 'none');
    await expect(page.locator('iframe')).toHaveCount(0);
    const dl = page.waitForEvent('download');
    await page.getByRole('link', { name: /Baixar/ }).click();
    expect((await dl).suggestedFilename()).toBe('relatorio.pdf');
  });

  test('PNG válido com MIME errado vira imagem pelo conteúdo', async ({ page }) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await importBackup(page, docsBoard({ mimeType: 'text/html', name: 'foto.html' }, { mimeType: 'text/html', dataURL: `data:text/html;base64,${png}` }));
    await confirmImport(page);
    await expect(page.getByTestId('doc-preview')).toHaveAttribute('data-preview', 'image');
    await expect(page.locator('[data-testid="doc-preview"] img')).toHaveCount(1);
  });

  test('data URL malformado e asset ausente não travam o widget', async ({ page }) => {
    await importBackup(page, docsBoard({}, { mimeType: 'application/pdf', dataURL: 'data:application/pdf;base64,@@@não-é-base64@@@' }));
    await confirmImport(page);
    await expect(page.getByTestId('doc-error')).toBeVisible();
    const missing = docsBoard({ assetId: 'a_inexistente' }, {});
    (missing as { assets: unknown[] }).assets = [];
    await importBackup(page, missing);
    await expect(page.getByText(/ausente no backup/).first()).toBeVisible(); // aviso da importação
    await confirmImport(page);
    await expect(page.getByTestId('doc-missing')).toBeVisible();
    await expectNotPwned(page);
  });

  test('HTML disfarçado com data URL application/pdf', async ({ page }) => {
    await importBackup(page, docsBoard({ mimeType: 'application/pdf' }, { mimeType: 'application/pdf', dataURL: `data:application/pdf;base64,${b64(SENTINEL_HTML)}` }));
    await confirmImport(page);
    await page.waitForTimeout(1500);
    await expectNotPwned(page);
    expect(await page.locator('iframe:not([sandbox])').count()).toBe(0);
  });

  test('SVG com script anexado como documento e como imagem', async ({ page }) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="try{parent.document.documentElement.setAttribute('data-pwned','svg')}catch(e){}"><rect width="40" height="40" fill="red"/>${SENTINEL_SCRIPT.replace(/<\/?script>/g, (t) => t.replace('script', 'script'))}</svg>`;
    const data = backup(
      [
        el({ id: 'w_docs', type: 'widget', widgetType: 'aurora.documents', title: 'Docs', data: { selected: 'd1', docs: [{ id: 'd1', name: 'logo.svg', mimeType: 'image/svg+xml', size: 300, assetId: 'a_svg', url: '', description: '', tags: [], addedAt: 1 }] } }),
        el({ id: 'img1', type: 'image', assetId: 'a_svg', x: 600, width: 80, height: 80 }),
      ],
      [{ id: 'a_svg', name: 'logo.svg', mimeType: 'image/svg+xml', size: 300, createdAt: 1, dataURL: `data:image/svg+xml;base64,${b64(svg)}` }],
    );
    await importBackup(page, data);
    await confirmImport(page);
    await page.waitForTimeout(1500);
    await expectNotPwned(page);
  });

  test('[reprodução] link de download nunca serve conteúdo ativo na origem do app', async ({ page }) => {
    await importBackup(page, docsBoard({ mimeType: 'text/html', name: 'pagina.html' }, { mimeType: 'text/html', dataURL: `data:text/html;base64,${b64(SENTINEL_HTML)}` }));
    await confirmImport(page);
    const link = page.getByRole('link', { name: /Baixar/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    const type = await page.evaluate(async (u) => (await (await fetch(u!)).blob()).type, href);
    // HTML/SVG/XML abertos a partir de um blob: da própria origem rodariam com acesso total ao app.
    expect(type).toBe('application/octet-stream');
  });
});

test.describe('S1-SEC-004/005/006: importação recusada não altera nada', () => {
  async function refusedDialog(page: import('@playwright/test').Page, re: RegExp) {
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText(/Importação recusada/);
    await expect(dlg).toContainText(re);
    await expect(dlg).toContainText(/Nenhum dado foi alterado/);
    await dlg.getByRole('button', { name: 'Ok' }).click();
  }

  test('JSON malformado, aninhamento profundo e excesso de elementos são recusados; quadro atual intacto', async ({ page }) => {
    await page.evaluate(() => (window as any).__aurora.actions.addElements([(window as any).__aurora.elements.createShape('rectangle', 0, 0, 100, 80)]));
    const before = await state(page);
    await importBackup(page, '{"format":"aurora-board", "boards": [');
    await refusedDialog(page, /JSON válido/);
    let deep = '1';
    for (let i = 0; i < 5000; i++) deep = `[${deep}]`;
    await importBackup(page, `{"format":"aurora-board","schemaVersion":3,"exportedAt":1,"app":"x","boards":[{"id":"b","name":"b","elements":[{"id":"w","type":"widget","widgetType":"aurora.notes","x":0,"y":0,"width":1,"height":1,"data":{"markdown":"","x":${deep}}}]}],"assets":[]}`);
    await refusedDialog(page, /aninhada/);
    const many = backup(Array.from({ length: 100_001 }, (_, i) => ({ id: `e${i}`, type: 'rectangle', x: i, y: 0, width: 1, height: 1 })));
    await importBackup(page, many);
    await refusedDialog(page, /elementos/);
    const after = await state(page);
    expect(after.boards.map((b) => b.id)).toEqual(before.boards.map((b) => b.id));
    expect(after.elements.map((e) => e.id)).toEqual(before.elements.map((e) => e.id));
    // Depois de recusas, uma importação válida funciona normalmente e persiste após recarregar.
    await importBackup(page, backup([el({ id: 'n1', type: 'widget', widgetType: 'aurora.notes', title: 'Nota S1', data: { markdown: 'ok', mode: 'edit' } })], [], 'Quadro válido S1'));
    await confirmImport(page);
    await expect.poll(async () => (await state(page)).boards.some((b) => b.name === 'Quadro válido S1')).toBe(true);
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    expect((await state(page)).boards.filter((b) => b.name === 'Quadro válido S1')).toHaveLength(1);
  });
});

test.describe('S1-SEC-003: HTML importado e isolamento do sandbox', () => {
  const sandboxBoard = (html: string) => backup([el({ id: 'w_sb', type: 'widget', widgetType: 'aurora.sandbox-html', title: 'HTML', data: { html, state: null } })], [], 'Quadro com HTML');

  test('[reprodução] HTML personalizado importado começa desativado até consentimento', async ({ page }) => {
    await importBackup(page, sandboxBoard('<p id="x">ativo</p><script>document.getElementById("x").textContent="executou"</script>'));
    await confirmImport(page);
    await expect.poll(async () => (await state(page)).elements.some((e) => e.widgetType === 'aurora.sandbox-html')).toBe(true);
    await page.waitForTimeout(800);
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
  });

  test('sandbox criado localmente não alcança o DOM nem o armazenamento do app', async ({ page }) => {
    await page.evaluate((html) => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }, { html }), SENTINEL_SCRIPT);
    await expect(page.locator('iframe[sandbox]')).toHaveCount(1);
    await page.waitForTimeout(1200);
    await expectNotPwned(page);
    const sb = await page.locator('iframe[sandbox]').getAttribute('sandbox');
    expect(sb).toBe('allow-scripts');
  });

  test('sandbox não abre janelas, não navega o topo e não envia formulários', async ({ page, context }) => {
    const html = `<form id="f" action="http://127.0.0.1:9/x" method="post"><input name="a" value="1"></form><script>
      try { window.open('about:blank#s1-popup'); } catch (e) {}
      try { top.location.href = '/?s1-top-nav'; } catch (e) {}
      try { document.getElementById('f').submit(); } catch (e) {}
    </script>`;
    const pagesBefore = context.pages().length;
    await page.evaluate((h) => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }, { html: h }), html);
    await page.waitForTimeout(1500);
    expect(context.pages().length).toBe(pagesBefore);
    expect(page.url()).not.toContain('s1-top-nav');
  });

  test('[reprodução] navegação do próprio frame é detectada e o widget é bloqueado', async ({ page }) => {
    const html = `<script>setTimeout(function(){ location.href = 'data:text/html,<p>pagina externa</p>'; }, 50)</script>`;
    await page.evaluate((h) => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }, { html: h }), html);
    await expect(page.getByTestId('sandbox-navigated')).toBeVisible({ timeout: 5000 });
  });

  test('mensagens inválidas, enormes ou em excesso não corrompem o estado', async ({ page }) => {
    const html = `<script>
      parent.postMessage({ type: 'aurora:setState', state: { ok: 1 }, extra: 1 }, '*');
      parent.postMessage({ type: 'aurora:setState', state: 'x'.repeat(200000) }, '*');
      parent.postMessage('lixo', '*');
      for (var i = 0; i < 500; i++) parent.postMessage({ type: 'aurora:setState', state: { n: i } }, '*');
    </script>`;
    await page.evaluate((h) => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }, { html: h }), html);
    await page.waitForTimeout(2500);
    const sb = (await state(page)).elements.find((e) => e.widgetType === 'aurora.sandbox-html')!;
    expect(sb.data.state).toEqual({ n: 499 }); // "a última vence"; inválidas ignoradas
  });
});
