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
    // S1-SEC-019: a prévia de SVG usa data: (não blob: da origem); "abrir imagem em nova aba" não roda o SVG no app.
    const src = await page.locator('[data-testid="doc-preview"] img').getAttribute('src');
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
    const tab = await page.context().newPage();
    await tab.goto(src!).catch(() => undefined); // navegação de topo para data: é bloqueada pelos navegadores
    await tab.waitForTimeout(500);
    await tab.close();
    await expectNotPwned(page);
  });

  test('S1-SEC-021: colagem externa com dados aninhados demais é recusada', async ({ page }) => {
    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = [deep];
    const payload = JSON.stringify({ type: 'aurora-board/clipboard', version: 1, elements: [{ id: 'p', type: 'widget', widgetType: 'aurora.notes', x: 0, y: 0, width: 100, height: 100, data: { markdown: 'x', fundo: deep } }] });
    const before = (await state(page)).elements.length;
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, payload);
    await expect(page.getByText(/Conteúdo colado recusado/)).toBeVisible();
    expect((await state(page)).elements.length).toBe(before);
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

test.describe('Etapa 8: mídias validadas pelo conteúdo', () => {
  const pngHeader = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString('base64');
  };

  test('imagem importada que é HTML ou PNG-bomba não é decodificada; o asset é preservado', async ({ page }) => {
    const data = backup(
      [el({ id: 'i1', type: 'image', assetId: 'a_html', width: 120, height: 90 }), el({ id: 'i2', type: 'image', assetId: 'a_bomb', x: 400, width: 120, height: 90 })],
      [
        { id: 'a_html', name: 'foto.png', mimeType: 'image/png', size: 10, createdAt: 1, dataURL: `data:image/png;base64,${b64(SENTINEL_HTML)}` },
        { id: 'a_bomb', name: 'bomba.png', mimeType: 'image/png', size: 33, createdAt: 1, dataURL: `data:image/png;base64,${pngHeader(60_000, 60_000)}` },
      ],
    );
    await importBackup(page, data);
    await confirmImport(page);
    await expect(page.getByTestId('image-blocked')).toHaveCount(2);
    await expect(page.getByTestId('image-blocked').first()).toContainText(/não é uma imagem válida|grande demais/);
    const stored = await page.evaluate(async () => !!(await (window as any).__aurora.actions.getAsset('a_bomb')));
    expect(stored).toBe(true);
    await expectNotPwned(page);
  });

  test('upload local: HTML renomeado para .png é recusado', async ({ page }) => {
    const before = (await state(page)).elements.length;
    await page.evaluate(async (html) => {
      const f = new File([html], 'falsa.png', { type: 'image/png' });
      await (window as any).__aurora.actions.insertImageFiles([f], { x: 0, y: 0 });
    }, SENTINEL_HTML);
    await expect(page.getByText(/não é uma imagem válida/)).toBeVisible();
    expect((await state(page)).elements.length).toBe(before);
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

  // Outra origem (127.0.0.1 ≠ localhost) e data: são bloqueadas pela CSP do app (frame-src 'self');
  // a mesma origem é permitida pela CSP, mas o host detecta o 2º load e desmonta o widget.
  for (const [target, blocked] of [['data:text/html,<p>pagina externa</p>', true], ['http://127.0.0.1:5173/favicon.svg?s1nav', true], ['/favicon.svg?s1same', false]] as const) {
    test(`[reprodução] navegação do próprio frame é bloqueada/detectada (${target.slice(0, 12)})`, async ({ page }) => {
      const html = `<script>aurora.setState({ antes: 1 }); setTimeout(function(){ location.href = ${JSON.stringify(target)}; }, 50)</script>`;
      await page.evaluate((h) => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }, { html: h }), html);
      await expect(page.getByTestId('sandbox-navigated')).toBeVisible({ timeout: 5000 });
      if (blocked) expect(page.frames().some((f) => f.url().includes('s1nav') || f.url().startsWith('data:'))).toBe(false);
      await page.getByRole('button', { name: 'Recarregar widget' }).click();
      await expect(page.locator('iframe[sandbox]')).toHaveCount(1);
    });
  }

  test('hospedeiro do sandbox se recusa a rodar fora de um iframe sandboxed', async ({ page }) => {
    await page.goto('/sandbox.html');
    await expect(page.locator('html')).toHaveAttribute('data-sandbox-refused', '1');
    // Mesmo recebendo uma mensagem "de si mesmo", não injeta HTML (aberto como página teria a origem do app).
    await page.evaluate((h) => window.postMessage({ type: 'aurora:load', html: h, state: null }, '*'), SENTINEL_SCRIPT);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.body.innerHTML.trim())).toBe('');
  });

  test('HTML importado: ativação consciente executa; a decisão persiste após recarregar', async ({ page }) => {
    const html = '<p id="x">inicial</p><script>document.getElementById("x").textContent="executou"; aurora.setState({ rodou: true })</script>';
    // Um backup que tenta se declarar "já ativado" continua desativado: a marcação é do importador.
    const data = sandboxBoard(html);
    (data.boards[0].elements[0] as any).data.activation = { state: 'allowed', source: 'import', at: 1 };
    await importBackup(page, data);
    await expect(page.getByTestId('import-active-content')).toContainText('1 widget');
    await confirmImport(page);
    await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
    await page.getByRole('button', { name: 'Ver código' }).click();
    await expect(page.getByTestId('sandbox-inactive').locator('pre')).toContainText('executou');
    await page.getByTestId('sandbox-activate').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ativar este widget' }).click();
    await expect(page.locator('iframe[sandbox]')).toHaveCount(1);
    await expect(page.frameLocator('iframe[sandbox]').locator('#x')).toHaveText('executou');
    await expect.poll(async () => (await state(page)).elements.find((e) => e.widgetType === 'aurora.sandbox-html')?.data.state).toEqual({ rodou: true });
    await page.waitForFunction(() => (window as any).__aurora.getState().saveState === 'saved');
    await page.reload();
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    await expect(page.locator('iframe[sandbox]')).toHaveCount(1);
    await expectNotPwned(page);
  });

  test('colar JSON externo: elementos validados e HTML desativado', async ({ page }) => {
    const payload = JSON.stringify({ type: 'aurora-board/clipboard', version: 1, elements: [
      { id: 'p1', type: 'widget', widgetType: 'aurora.sandbox-html', x: 0, y: 0, width: 300, height: 200, data: { html: '<b>colado</b>', activation: { state: 'allowed' } } },
      { id: 'p2', type: 'rectangle', x: 'NaN', y: 0, width: 10, height: 10, style: { strokeColor: 'red"><script>' } },
      { id: 'p3', type: 'desconhecido' },
    ] });
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, payload);
    await expect(page.getByTestId('sandbox-inactive')).toBeVisible();
    const els = (await state(page)).elements;
    const rectEl = els.find((e) => e.type === 'rectangle')!;
    expect(rectEl.x).toBe(rectEl.x); // número finito, não NaN
    expect(Number.isFinite(rectEl.x)).toBe(true);
    expect(rectEl.style.strokeColor).not.toContain('<');
    expect(els.some((e) => e.type === ('desconhecido' as string))).toBe(false);
  });

  test('modo seguro (?safe) desliga todo HTML personalizado', async ({ page }) => {
    await page.evaluate(() => (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 200, y: 200 }));
    await expect(page.locator('iframe[sandbox]')).toHaveCount(1);
    await page.waitForFunction(() => (window as any).__aurora.getState().saveState === 'saved');
    await page.goto('/?safe');
    await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
    await expect(page.getByTestId('sandbox-safe-mode')).toBeVisible();
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
  });

  test('limite de iframes simultâneos: excedentes ficam pausados', async ({ page }) => {
    // Todos dentro da tela (widgets fora do viewport já são desmontados pelo canvas).
    await page.evaluate(() => { for (let i = 0; i < 23; i++) (window as any).__aurora.actions.addWidget('aurora.sandbox-html', { x: 100 + (i % 6) * 120, y: 100 + Math.floor(i / 6) * 100 }, { html: `<p>${i}</p>` }, { size: { width: 110, height: 90 } }); });
    await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
    await expect(page.locator('iframe[sandbox]')).toHaveCount(20);
    await expect(page.getByTestId('sandbox-paused')).toHaveCount(3);
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
