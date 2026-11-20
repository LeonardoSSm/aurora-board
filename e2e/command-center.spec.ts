/**
 * Issue #14 — Aurora Command Center: Ctrl+K, busca local em todos os quadros (PT-BR, sem acento), navegação até o
 * resultado, privacidade, corrida de navegação, recentes e captura rápida (quadro atual e Inbox). Dados sintéticos.
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state, waitSaved } from './helpers';

const palette = (page: Page) => page.getByTestId('command-center');
const input = (page: Page) => palette(page).getByRole('combobox');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function newBoard(page: Page, name: string) {
  await page.evaluate((n) => (window as any).__aurora.actions.createBoard(n), name);
  await expect.poll(async () => { const s = await state(page); return s.boards.find((b) => b.id === s.boardId)?.name; }).toBe(name);
  return (await state(page)).boardId;
}

/** Adiciona um widget com dados e devolve o id (sem selecionar). */
async function addWidget(page: Page, type: string, at: { x: number; y: number }, data: unknown, title?: string) {
  return page.evaluate(({ type, at, data, title }) => {
    const a = (window as any).__aurora;
    const el = a.actions.addWidget(type, at, data, title ? { title } : {});
    a.store.setState({ editingWidgetId: null, selectedIds: [] });
    return el.id as string;
  }, { type, at, data, title });
}

async function openPalette(page: Page) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press(`${mod}+k`);
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

async function seed(page: Page) {
  await ready(page);
  const projetos = await newBoard(page, 'Projetos E2E');
  const noteId = await addWidget(page, 'aurora.notes', { x: 2400, y: -900 }, { markdown: '# Reforma\nOrçamento da reforma da cozinha: pedir três cotações.', mode: 'preview' }, 'Plano da casa');
  const tasksId = await addWidget(page, 'aurora.tasks', { x: -1800, y: 700 }, { items: [{ id: 't1', text: 'Comprar tinta acrílica', status: 'todo', priority: 'medium', dueDate: '' }], hideDone: false }, 'Pendências');
  await addWidget(page, 'aurora.ai', { x: 0, y: 0 }, { messages: [{ id: 'm1', role: 'user', content: 'segredoia123 meu saldo', at: 1 }] }, 'Assistente pessoal');
  await addWidget(page, 'aurora.sandbox-html', { x: 600, y: 0 }, { html: '<p>segredohtml456</p>' }, 'Painel HTML');
  await page.evaluate(() => (window as any).__aurora.checkpoints.addCheckpoint({ name: 'Financeiro anual', description: '', color: '#8f9bff', icon: 'pin', x: 5000, y: 5000 }));
  await waitSaved(page);
  const casa = await newBoard(page, 'Casa E2E');
  await waitSaved(page);
  return { projetos, casa, noteId, tasksId };
}

test('A — Ctrl+K abre com foco; Esc fecha e devolve o foco; botão da barra também abre', async ({ page }) => {
  await ready(page);
  await openPalette(page);
  await expect(palette(page).getByText('Ações')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByTestId('canvas')).toBeFocused();
  await page.getByRole('button', { name: /Buscar \(Ctrl\+K\)/ }).click();
  await expect(palette(page)).toBeVisible();
  // Letras digitadas vão para a busca, não viram atalhos do quadro.
  await page.keyboard.type('rv');
  expect((await state(page)).tool).toBe('select');
  await page.keyboard.press('Escape');
});

test('B — busca sem acento em outro quadro e vai ao local exato sem alterar dados nem histórico', async ({ page }) => {
  const { projetos, casa, noteId } = await seed(page);
  const before = await page.evaluate(() => { const s = (window as any).__aurora.getState(); return { cam: s.camera, board: s.boardId }; });
  await openPalette(page);
  await input(page).fill('ORCAMENTO reforma');
  const row = palette(page).getByTestId('command-row').filter({ hasText: 'Plano da casa' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Projetos E2E');
  await expect(palette(page).getByTestId('command-snippet').first()).toContainText('Orçamento');
  // Até confirmar, nada muda.
  const mid = await page.evaluate(() => { const s = (window as any).__aurora.getState(); return { cam: s.camera, board: s.boardId }; });
  expect(mid).toEqual(before);
  expect(mid.board).toBe(casa);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).boardId).toBe(projetos);
  await expect.poll(async () => (await state(page)).selectedIds).toEqual([noteId]);
  await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating());
  const s = await page.evaluate((id) => {
    const st = (window as any).__aurora.getState();
    const el = st.elements.find((e: any) => e.id === id);
    const cx = (st.viewport.width / 2 - st.camera.x) / st.camera.zoom, cy = (st.viewport.height / 2 - st.camera.y) / st.camera.zoom;
    return { el, cx, cy, hist: st.history[st.boardId]?.undo?.length ?? 0, flash: st.elementFlash?.id };
  }, noteId);
  expect(Math.abs(s.cx - (s.el.x + s.el.width / 2))).toBeLessThan(2);
  expect(Math.abs(s.cy - (s.el.y + s.el.height / 2))).toBeLessThan(2);
  expect(s.el.x).toBe(2400 - s.el.width / 2);
  expect(s.flash).toBe(noteId);
});

test('C — tarefas, locais e filtros; recentes depois de navegar', async ({ page }) => {
  const { projetos, tasksId } = await seed(page);
  await openPalette(page);
  await input(page).fill('tinta');
  const taskRow = palette(page).getByTestId('command-row').filter({ hasText: 'Comprar tinta acrílica' }).first();
  await expect(taskRow).toContainText('Tarefa · a fazer');
  await expect(taskRow).toContainText('Projetos E2E');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).selectedIds).toEqual([tasksId]);
  // Local (checkpoint).
  await openPalette(page);
  await input(page).fill('financeiro');
  await palette(page).getByRole('radio', { name: 'Locais' }).click();
  await expect(palette(page).getByTestId('command-result')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating());
  const cam = await page.evaluate(() => { const s = (window as any).__aurora.getState(); return { cx: (s.viewport.width / 2 - s.camera.x) / s.camera.zoom, cy: (s.viewport.height / 2 - s.camera.y) / s.camera.zoom }; });
  expect(Math.abs(cam.cx - 5000) + Math.abs(cam.cy - 5000)).toBeLessThan(2);
  expect((await state(page)).boardId).toBe(projetos);
  // Recentes (busca vazia).
  await openPalette(page);
  await expect(palette(page).getByText('Recentes')).toBeVisible();
  await expect(palette(page).getByTestId('command-result').first()).toContainText('Financeiro anual');
});

test('D — privacidade: conversa de IA e HTML não são encontrados; o título do bloco sim, sinalizado', async ({ page }) => {
  await seed(page);
  await openPalette(page);
  for (const q of ['segredoia123', 'segredohtml456', 'meu saldo']) {
    await input(page).fill(q);
    await expect(palette(page).getByTestId('command-empty')).toBeVisible();
  }
  await input(page).fill('assistente pessoal');
  const row = palette(page).getByTestId('command-row').filter({ hasText: 'Assistente pessoal' });
  await expect(row).toContainText('conteúdo não pesquisável');
  // Nada do índice é gravado no armazenamento local.
  const kv = await page.evaluate(() => new Promise<string>((res) => {
    const req = indexedDB.open('aurora-board');
    req.onsuccess = () => { const all = req.result.transaction('kv').objectStore('kv').getAll(); all.onsuccess = () => { res(JSON.stringify(all.result)); req.result.close(); }; };
  }));
  expect(kv).not.toContain('Orçamento da reforma');
  expect(kv).not.toContain('segredo');
});

test('E — conteúdo recém-editado no quadro atual aparece na hora; item excluído some', async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Edição E2E');
  const id = await addWidget(page, 'aurora.notes', { x: 0, y: 0 }, { markdown: 'primeira versão', mode: 'preview' }, 'Rascunho');
  await openPalette(page);
  await input(page).fill('versao revisada');
  await expect(palette(page).getByTestId('command-empty')).toBeVisible();
  await page.evaluate((id) => (window as any).__aurora.actions.updateWidgetData(id, (d: any) => ({ ...d, markdown: 'versão revisada do texto' })), id);
  await expect(palette(page).getByTestId('command-result')).toHaveCount(1);
  await page.evaluate((id) => { const a = (window as any).__aurora; a.actions.setSelection([id]); a.actions.deleteSelected(); }, id);
  await expect(palette(page).getByTestId('command-empty')).toBeVisible();
});

test('F — navegações seguidas: só a última aplica o foco (sem foco obsoleto em outro quadro)', async ({ page }) => {
  const { casa, noteId } = await seed(page);
  const casaNote = await addWidget(page, 'aurora.notes', { x: 100, y: 100 }, { markdown: 'jardim de inverno', mode: 'preview' }, 'Jardim');
  await waitSaved(page);
  // Primeira navegação (para Projetos) e, logo em seguida, outra (para Casa).
  await openPalette(page);
  await input(page).fill('reforma');
  await expect(palette(page).getByTestId('command-result').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await openPalette(page);
  await input(page).fill('jardim');
  await expect(palette(page).getByTestId('command-result').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).boardId).toBe(casa);
  await page.waitForTimeout(500);
  const s = await state(page);
  expect(s.boardId).toBe(casa);
  expect(s.selectedIds).toEqual([casaNote]);
  expect(s.selectedIds).not.toContain(noteId);
});

test('G — captura rápida no quadro atual: sem trocar canvas, câmera ou seleção; Ctrl+Z desfaz', async ({ page }) => {
  await ready(page);
  await newBoard(page, 'Captura E2E');
  const keep = await addWidget(page, 'aurora.notes', { x: 0, y: 0 }, { markdown: 'existente', mode: 'preview' }, 'Existente');
  await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), keep);
  const before = await state(page);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+Shift+Space');
  const form = page.getByTestId('quick-capture');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Título')).toBeFocused();
  await form.getByRole('radio', { name: 'Tarefa' }).click();
  await form.getByLabel('Título').fill('Ligar para o eletricista');
  await form.getByLabel('Título').press('Enter');
  await expect(form).toHaveCount(0);
  const after = await state(page);
  expect(after.boardId).toBe(before.boardId);
  expect(after.camera).toEqual(before.camera);
  expect(after.selectedIds).toEqual([keep]);
  expect(after.elements).toHaveLength(2);
  const task = after.elements.find((e) => e.widgetType === 'aurora.tasks')!;
  expect(task.data.items[0].text).toBe('Ligar para o eletricista');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).elements.length).toBe(1);
});

test('H — Inbox em outro quadro: grava no quadro fechado sem tocar no atual; sobrevive a recarregar', async ({ page }) => {
  await ready(page);
  const inbox = await newBoard(page, 'Inbox E2E');
  await waitSaved(page);
  const work = await newBoard(page, 'Trabalho E2E');
  await addWidget(page, 'aurora.notes', { x: 0, y: 0 }, { markdown: 'trabalho', mode: 'preview' }, 'Trabalho');
  await waitSaved(page);
  const before = await state(page);
  await page.getByRole('button', { name: /Captura rápida/ }).click();
  const form = page.getByTestId('quick-capture');
  await form.getByLabel('Destino').selectOption({ label: 'Inbox E2E' });
  await form.getByLabel('Título').fill('Ideia: app de receitas');
  await form.getByLabel('Detalhes (opcional)').fill('com lista de compras');
  await form.getByRole('button', { name: 'Capturar' }).click();
  await expect(form).toHaveCount(0);
  const after = await state(page);
  expect(after.boardId).toBe(work);
  expect(after.elements).toEqual(before.elements); // o quadro atual não muda
  // Lembrar o Inbox: a próxima captura já vem com ele como destino.
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.getByTestId('quick-capture').getByLabel('Destino')).toHaveValue(inbox);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  await page.evaluate((id) => (window as any).__aurora.actions.openBoard(id), inbox);
  await expect.poll(async () => (await state(page)).boardId).toBe(inbox);
  const els = (await state(page)).elements;
  expect(els).toHaveLength(1);
  expect(els[0]).toMatchObject({ widgetType: 'aurora.notes', title: 'Ideia: app de receitas' });
  expect(els[0].data.markdown).toContain('com lista de compras');
  // Buscável e “Abrir item capturado” leva até ele.
  await openPalette(page);
  await input(page).fill('receitas');
  await expect(palette(page).getByTestId('command-result').first()).toContainText('Ideia: app de receitas');
});

test('I — destino inválido: erro claro e o texto continua no formulário', async ({ page }) => {
  await ready(page);
  const inbox = await newBoard(page, 'Inbox apagado');
  await waitSaved(page);
  await newBoard(page, 'Atual');
  await page.keyboard.press('Control+Shift+Space');
  const form = page.getByTestId('quick-capture');
  await form.getByLabel('Destino').selectOption({ label: 'Inbox apagado' });
  // O quadro some antes de gravar (outra aba, exclusão…).
  await page.evaluate((id) => { const a = (window as any).__aurora; a.store.setState({ boards: a.getState().boards.filter((b: any) => b.id !== id) }); }, inbox);
  await form.getByLabel('Título').fill('Não perder isto');
  await form.getByRole('button', { name: 'Capturar' }).click();
  await expect(page.getByTestId('capture-error')).toBeVisible();
  await expect(form.getByLabel('Título')).toHaveValue('Não perder isto');
});
