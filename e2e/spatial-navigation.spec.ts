import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drag, ready, state, toPage, waitSaved, expectNear, emptyCanvasPoint } from './helpers';

// Estes testes exercitam a animação real da câmera.
test.use({ reducedMotion: 'no-preference' });

const cam = async (page: Page) => (await state(page)).camera;
const cps = (page: Page) => page.evaluate(() => (window as any).__aurora.getState().checkpoints as { id: string; name: string; x: number; y: number; color: string; savedZoom: number | null; restoreZoom: boolean }[]);
/** Espera a animação da câmera terminar (o motor informa; não depende de amostragem da câmera). */
const settle = async (page: Page) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating(), undefined, { polling: 'raf', timeout: 5000 });
};
const viewport = async (page: Page) => (await state(page)).camera && page.evaluate(() => (window as any).__aurora.getState().viewport as { width: number; height: number });

async function newBoard(page: Page, name: string) {
  await page.evaluate((n) => (window as any).__aurora.actions.createBoard(n), name);
  await expect.poll(async () => { const s = await state(page); return s.boards.find((b) => b.id === s.boardId)?.name; }).toBe(name);
}

/** Cria um checkpoint pelo menu do canvas no ponto de tela (relativo ao canvas). */
async function addCheckpointAt(page: Page, name: string, at: { x: number; y: number }) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y, { button: 'right' });
  await page.getByTestId('context-menu').getByRole('menuitem', { name: 'Adicionar checkpoint aqui' }).click();
  const dlg = page.getByTestId('checkpoint-dialog');
  await dlg.getByLabel('Nome do checkpoint').fill(name);
  await dlg.getByRole('button', { name: 'Salvar' }).click();
  await expect(dlg).toHaveCount(0);
}

/** Leva a câmera para centralizar um ponto do mundo (sem animação). */
async function jumpTo(page: Page, x: number, y: number, zoom?: number) {
  await page.evaluate(({ x, y, zoom }) => {
    const a = (window as any).__aurora;
    const v = a.getState().viewport, z = zoom ?? a.getState().camera.zoom;
    a.store.setState({ camera: { zoom: z, x: v.width / 2 - x * z, y: v.height / 2 - y * z } });
  }, { x, y, zoom });
}

test('A — zoom suave: incremento controlado, âncora, sensibilidade, botões, atalhos, pan, arrasto e persistência', async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Zoom E2E');
  await page.keyboard.press('r');
  await drag(page, await toPage(page, -60, -40), await toPage(page, 60, 40));
  const rect = (await state(page)).elements[0];
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const anchor = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 };
  const worldAt = async () => { const c = await cam(page); return { x: (anchor.x - box.x - c.x) / c.zoom, y: (anchor.y - box.y - c.y) / c.zoom }; };

  // 3–4: um clique de roda (100 px) = incremento pequeno (≈ 13% no padrão “Suave”), não um salto.
  await page.mouse.move(anchor.x, anchor.y);
  const w0 = await worldAt();
  const z0 = (await cam(page)).zoom;
  await page.mouse.wheel(0, -100);
  await settle(page);
  const z1 = (await cam(page)).zoom;
  expect(z1 / z0).toBeGreaterThan(1.05);
  expect(z1 / z0).toBeLessThan(1.2);
  // 5–6: afastar; o ponto sob o cursor continua sob o cursor.
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await settle(page);
  const w1 = await worldAt();
  expect(Math.hypot(w1.x - w0.x, w1.y - w0.y)).toBeLessThan(2);
  expect((await cam(page)).zoom).toBeLessThan(z0);

  // 7–8: sensibilidade “Rápido” aumenta o passo (painel do quadro aparece sem seleção).
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Rápido' }).click();
  await page.mouse.move(anchor.x, anchor.y);
  const zf0 = (await cam(page)).zoom;
  await page.mouse.wheel(0, -100);
  await settle(page);
  expect((await cam(page)).zoom / zf0).toBeGreaterThan(z1 / z0 + 0.05);

  // 9: botões (transição suave até o próximo nível).
  await page.getByRole('button', { name: 'Aumentar zoom' }).click();
  await settle(page);
  const zb = (await cam(page)).zoom;
  expect([1.1, 1.25, 1.5, 1]).toContain(zb);
  // 10: atalhos Ctrl+0 (100%) e Ctrl+−.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+0');
  await settle(page);
  expect((await cam(page)).zoom).toBe(1);
  await page.keyboard.press('Control+-');
  await settle(page);
  expect((await cam(page)).zoom).toBe(0.9);

  // 11: pan com espaço + arrastar.
  const c0 = await cam(page);
  const e = await emptyCanvasPoint(page);
  await page.keyboard.down('Space');
  await drag(page, e, { x: e.x - 120, y: e.y - 80 });
  await page.keyboard.up('Space');
  const c1 = await cam(page);
  expectNear({ dx: c1.x - c0.x, dy: c1.y - c0.y }, { dx: -120, dy: -80 }, 2);

  // 12–13: arrastar o elemento com a câmera ampliada: deslocamento no mundo = deslocamento na tela ÷ zoom.
  const r0 = (await state(page)).elements[0];
  const from = await toPage(page, r0.x, r0.y + r0.height / 2); // borda (forma sem preenchimento)
  await drag(page, from, { x: from.x + 90, y: from.y + 45 });
  const r1 = (await state(page)).elements[0];
  const z = (await cam(page)).zoom;
  expectNear({ dx: r1.x - r0.x, dy: r1.y - r0.y }, { dx: 90 / z, dy: 45 / z }, 1.5);
  expect(r1.id).toBe(rect.id);

  // 14–15: preferência de sensibilidade persiste após recarregar.
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  expect(await page.evaluate(() => (window as any).__aurora.getState().zoomPrefs)).toMatchObject({ preset: 'fast' });
  await expect(page.getByRole('radio', { name: 'Rápido' })).toHaveAttribute('aria-checked', 'true');
});

test('B — checkpoints: criar, indicadores nas bordas certas, navegar, editar, excluir, recarregar, duplicar e importar', async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Universo E2E');
  const vp = await viewport(page);
  const c = { x: vp.width / 2, y: vp.height / 2 };
  // 2–5: Financeiro aqui; Arquitetura e Projetos em regiões distantes.
  await addCheckpointAt(page, 'Financeiro', { x: c.x - 200, y: c.y });
  await jumpTo(page, 6000, -2500);
  await addCheckpointAt(page, 'Arquitetura', c);
  await jumpTo(page, -4000, 5000);
  await addCheckpointAt(page, 'Projetos', c);
  const list = await cps(page);
  expect(list.map((x) => x.name)).toEqual(['Financeiro', 'Arquitetura', 'Projetos']);
  const fin = list[0], arq = list[1], prj = list[2];

  // 6–7: longe de todos → cada checkpoint tem indicador (simples ou em grupo) no lado da direção real.
  const sideOf = (id: string) => page.evaluate((id) => [...document.querySelectorAll('[data-testid="checkpoint-indicator"]')].find((b) => (b as HTMLElement).dataset.ids!.split(',').includes(id))?.getAttribute('data-side') ?? null, id);
  await jumpTo(page, 1000, -6000); // acima de tudo
  await expect(page.getByTestId('checkpoint-marker')).toHaveCount(0);
  expect(await sideOf(fin.id)).toBe('bottom');
  expect(await sideOf(arq.id)).toMatch(/right|bottom/);
  expect(await sideOf(prj.id)).toBe('bottom');
  await jumpTo(page, 12000, 0); // à direita de tudo
  expect(await sideOf(fin.id)).toBe('left');
  expect(await sideOf(prj.id)).toMatch(/left|bottom/);
  await jumpTo(page, -12000, -2500); // à esquerda de tudo
  expect(await sideOf(arq.id)).toBe('right');
  await jumpTo(page, 1000, 1500); // entre os três: três direções distintas
  await expect(page.getByTestId('checkpoint-indicator')).toHaveCount(3);
  expect(await sideOf(arq.id)).toMatch(/top|right/);
  expect(await sideOf(prj.id)).toMatch(/left|bottom/);

  // 8–9: clicar em Financeiro centraliza (zoom atual preservado).
  const zBefore = (await cam(page)).zoom;
  await page.locator('[data-testid="checkpoint-indicator"][aria-label^="Ir para Financeiro"]').click();
  await settle(page);
  let cm = await cam(page);
  expect(cm.zoom).toBe(zBefore);
  expectNear({ x: cm.x, y: cm.y }, { x: vp.width / 2 - fin.x * cm.zoom, y: vp.height / 2 - fin.y * cm.zoom }, 0.01);
  await expect(page.locator(`[data-testid="checkpoint-marker"][data-id="${fin.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="checkpoint-indicator"][aria-label^="Ir para Financeiro"]`)).toHaveCount(0);

  // 10–11: Arquitetura pelo painel Locais (atalho G).
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('g');
  const panel = page.getByTestId('locations-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Ir para Arquitetura' }).click();
  await settle(page);
  cm = await cam(page);
  expectNear({ x: cm.x, y: cm.y }, { x: vp.width / 2 - arq.x * cm.zoom, y: vp.height / 2 - arq.y * cm.zoom }, 0.01);

  // 12–13: renomear Projetos e mudar a cor.
  await panel.getByRole('button', { name: 'Editar Projetos' }).click();
  const dlg = page.getByTestId('checkpoint-dialog');
  await dlg.getByLabel('Nome do checkpoint').fill('Projetos pessoais');
  await dlg.getByRole('radio', { name: 'Cor #fb8590' }).click();
  await dlg.getByRole('button', { name: 'Salvar' }).click();
  expect((await cps(page)).find((x) => x.id === prj.id)).toMatchObject({ name: 'Projetos pessoais', color: '#fb8590' });

  // 14: excluir Arquitetura (com confirmação); Ctrl+Z desfaz, Ctrl+Y refaz.
  await panel.getByRole('button', { name: 'Excluir Arquitetura' }).click();
  await page.getByRole('dialog', { name: 'Excluir local' }).getByRole('button', { name: 'Excluir', exact: true }).click();
  expect((await cps(page)).map((x) => x.name)).toEqual(['Financeiro', 'Projetos pessoais']);
  await page.keyboard.press('Escape');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  expect((await cps(page)).map((x) => x.name)).toEqual(['Financeiro', 'Arquitetura', 'Projetos pessoais']);
  await page.keyboard.press('Control+y');
  expect((await cps(page)).map((x) => x.name)).toEqual(['Financeiro', 'Projetos pessoais']);

  // 15–16: recarregar preserva coordenadas, nome e cor.
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  const before = await cps(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  expect(await cps(page)).toEqual(before);

  // 17: duplicar o quadro → a cópia tem os mesmos locais; editar a cópia não muda o original.
  const originalId = (await state(page)).boardId;
  await page.evaluate((id) => (window as any).__aurora.actions.duplicateBoard(id), originalId);
  await expect.poll(async () => (await state(page)).boards.filter((b) => b.name.startsWith('Universo E2E')).length).toBe(2);
  const copyId = (await state(page)).boards.find((b) => b.name === 'Universo E2E (cópia)')!.id;
  await page.evaluate((id) => (window as any).__aurora.actions.openBoard(id), copyId);
  await expect.poll(async () => (await state(page)).boardId).toBe(copyId);
  expect((await cps(page)).map((x) => [x.name, x.x, x.y])).toEqual(before.map((x) => [x.name, x.x, x.y]));
  await page.evaluate(async () => { const m = (window as any).__aurora.checkpoints; const cp = (window as any).__aurora.getState().checkpoints[0]; m.updateCheckpoint(cp.id, { name: 'Só na cópia' }); });
  await page.keyboard.press('Control+s');
  await waitSaved(page);
  await page.evaluate((id) => (window as any).__aurora.actions.openBoard(id), originalId);
  await expect.poll(async () => (await state(page)).boardId).toBe(originalId);
  expect((await cps(page))[0].name).toBe('Financeiro');

  // 18–19: exportar JSON e importar como novo quadro preserva os locais.
  await page.getByRole('button', { name: /Exportar/ }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Este quadro/ }).click();
  const file = await (await dl).path();
  expect(JSON.parse(readFileSync(file!, 'utf8')).boards[0].checkpoints.map((x: { name: string }) => x.name)).toEqual(['Financeiro', 'Projetos pessoais']);
  const nBoards = (await state(page)).boards.length;
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser).setFiles(file!);
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect.poll(async () => (await state(page)).boards.length).toBe(nBoards + 1);
  expect((await cps(page)).map((x) => [x.name, x.x, x.y, x.color])).toEqual(before.map((x) => [x.name, x.x, x.y, x.color]));
});

test('C — quadro grande: grupos distantes, zoom, navegação, arrasto e conexões; checkpoints não afetam o conteúdo', async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Grande E2E');
  // Três regiões com formas e uma seta cada; 12 checkpoints (10 na mesma direção).
  const ids = await page.evaluate(async () => {
    const a = (window as any).__aurora;
    const E = a.elements;
    const regions = [[0, 0], [8000, -3000], [-6000, 7000]];
    const els: any[] = [];
    for (const [x, y] of regions) {
      const r1 = E.createShape('rectangle', x, y, 160, 90), r2 = E.createShape('ellipse', x + 300, y, 160, 90);
      const l = E.createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
      l.startBinding = { elementId: r1.id, fixedPoint: null };
      l.endBinding = { elementId: r2.id, fixedPoint: null };
      els.push(r1, r2, l);
    }
    a.actions.addElements(els, false);
    const m = (window as any).__aurora.checkpoints;
    m.addCheckpoint({ name: 'Centro', x: 80, y: 45 });
    m.addCheckpoint({ name: 'Arquitetura', x: 8080, y: -2955 });
    for (let i = 0; i < 10; i++) m.addCheckpoint({ name: `Ideia ${i + 1}`, x: -6000 + i * 20, y: 7000 + i * 10 });
    return els.map((e) => e.id);
  });
  const contentBefore = await page.evaluate(() => JSON.stringify((window as any).__aurora.getState().elements));
  await page.evaluate(() => (window as any).__aurora.actions.zoomToFit());
  await settle(page);
  // Enquadrar tudo depende só dos elementos (os checkpoints de “Ideias” ficam junto da região 3 de qualquer forma).
  await jumpTo(page, 1000, 3000, 1);
  await expect(page.getByTestId('checkpoint-indicator')).toHaveCount(3); // Centro, Arquitetura e o grupo das 10 ideias
  const group = page.locator('[data-testid="checkpoint-indicator"][aria-label^="10 locais"]');
  await expect(group).toBeVisible();
  await group.click();
  await expect(page.getByTestId('checkpoint-group-item')).toHaveCount(10);
  await page.getByTestId('checkpoint-group-item').filter({ hasText: 'Ideia 4' }).click();
  await settle(page);
  // Mudanças de destino em sequência: a última vence, câmera exata.
  await page.evaluate(async () => {
    const m = (window as any).__aurora.checkpoints;
    const cps = (window as any).__aurora.getState().checkpoints;
    m.navigateToCheckpoint(cps[1].id);
    await new Promise((r) => setTimeout(r, 60));
    m.navigateToCheckpoint(cps[0].id);
  });
  await settle(page);
  const vp = await viewport(page);
  const cm = await cam(page);
  expectNear({ x: cm.x, y: cm.y }, { x: vp.width / 2 - 80 * cm.zoom, y: vp.height / 2 - 45 * cm.zoom }, 0.01);
  // Pan durante a animação cancela sem salto.
  await page.evaluate(async () => { const m = (window as any).__aurora.checkpoints; m.navigateToCheckpoint((window as any).__aurora.getState().checkpoints[1].id); });
  await page.waitForTimeout(80);
  const e = await emptyCanvasPoint(page);
  await page.keyboard.down('Space');
  await drag(page, e, { x: e.x - 50, y: e.y });
  await page.keyboard.up('Space');
  const afterPan = await cam(page);
  await page.waitForTimeout(400);
  expect(await cam(page)).toEqual(afterPan);
  // Voltar ao Centro, arrastar uma forma: a seta acompanha.
  await page.evaluate(async () => { const m = (window as any).__aurora.checkpoints; m.navigateToCheckpoint((window as any).__aurora.getState().checkpoints[0].id); });
  await settle(page);
  const r1 = (await state(page)).elements.find((x) => x.id === ids[0])!;
  const arrow0 = (await state(page)).elements.find((x) => x.id === ids[2])!;
  const p = await toPage(page, r1.x, r1.y + 45); // borda esquerda
  await drag(page, p, { x: p.x, y: p.y + 120 });
  const arrow1 = (await state(page)).elements.find((x) => x.id === ids[2])!;
  expect(arrow1.y).not.toBe(arrow0.y);
  // Painéis abrem e fecham; indicadores continuam.
  await page.getByRole('button', { name: 'Biblioteca de componentes' }).click();
  await page.getByRole('button', { name: 'Biblioteca de componentes' }).click();
  await jumpTo(page, 1000, 3000, 1);
  await expect(page.getByTestId('checkpoint-indicator')).toHaveCount(3);
  // Os checkpoints não entraram no conteúdo: mesmo número de elementos, Ctrl+A só seleciona elementos.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+a');
  const s = await state(page);
  expect(s.selectedIds.sort()).toEqual([...ids].sort());
  expect(s.elements).toHaveLength(JSON.parse(contentBefore).length);
  // Ocultar indicadores pelo painel.
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.getByTestId('locations-panel').getByLabel('Mostrar indicadores nas bordas da tela').uncheck();
  await expect(page.getByTestId('checkpoint-indicator')).toHaveCount(0);
});
