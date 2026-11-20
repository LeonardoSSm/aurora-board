/**
 * Issue #13 — AI Companions. Provedor SIMULADO (page.route): nenhuma chave real, nenhum custo.
 * Personagem no canvas, mini chat, dock, estados reais (aguardando/resposta/erro/não lida), isolamento entre dois
 * assistentes, propostas que exigem aprovação, standby sem chamadas, limite de animação e compatibilidade.
 */
import { expect, test, type Page } from '@playwright/test';
import { ready, state, waitSaved } from './helpers';

interface ChatBody { system: string; messages: { role: string; content: string }[] }

/** Provedor simulado; `gate` segura a resposta até o teste liberar. */
async function mockAI(page: Page, opts: { replies?: string[]; fail?: boolean } = {}) {
  const bodies: ChatBody[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  await page.route('**/api/ai/providers', (r) => r.fulfill({ json: { providers: [{ id: 'anthropic', name: 'Anthropic', configured: true, defaultModel: 'mock' }] } }));
  await page.route('**/api/ai/chat', async (r) => {
    bodies.push(r.request().postDataJSON() as ChatBody);
    const n = bodies.length;
    if (hold) await new Promise<void>((res) => gates.push(res));
    if (opts.fail) return r.fulfill({ status: 500, json: { error: 'Provedor indisponível (simulado)' } });
    await r.fulfill({ json: { text: opts.replies?.[n - 1] ?? `resposta ${n}`, provider: 'anthropic', model: 'mock' } });
  });
  return { bodies, holdNext: () => { hold = true; }, release: () => { hold = false; gates.splice(0).forEach((g) => g()); } };
}

async function addCompanion(page: Page, opts: { title?: string; at?: { x: number; y: number }; docked?: boolean; preset?: string; mode?: 'classic' | 'character'; messages?: unknown[] } = {}) {
  return page.evaluate((o) => {
    const a = (window as any).__aurora;
    const el = a.actions.addWidget('aurora.ai', o.at ?? { x: 0, y: 0 }, { provider: 'anthropic', messages: o.messages ?? [], companion: { displayMode: o.mode ?? 'character', preset: o.preset ?? 'aurora', name: o.title ?? 'Aurora', docked: !!o.docked } }, { title: o.title ?? 'Aurora', size: { width: 180, height: 220 } });
    a.store.setState({ selectedIds: [], editingWidgetId: null });
    return el.id as string;
  }, opts);
}

const messagesOf = (page: Page, id: string) => page.evaluate((id) => (window as any).__aurora.getState().elements.find((e: any) => e.id === id).data.messages.map((m: any) => `${m.role}:${m.content}`), id);
const avatar = (page: Page, id: string) => page.locator(`[data-testid="companion-character"][data-id="${id}"] [data-testid="companion-avatar"]`);

async function newBoard(page: Page, name = 'Companions E2E') {
  await ready(page);
  await page.evaluate((n) => (window as any).__aurora.actions.createBoard(n), name);
  await expect.poll(async () => { const s = await state(page); return s.boards.find((b) => b.id === s.boardId)?.name; }).toBe(name);
}

test('A — personagem: clique abre o mini chat; aguardando → resposta; mesmas mensagens do clássico, sem duplicar', async ({ page }) => {
  const ai = await mockAI(page, { replies: ['Olá! Posso ajudar com o quadro.'] });
  await newBoard(page);
  const id = await addCompanion(page);
  await page.getByTestId('companion-open').click();
  const chat = page.getByTestId('companion-minichat');
  await expect(chat).toBeVisible();
  await expect(chat.getByRole('textbox')).toBeFocused();
  ai.holdNext();
  await chat.getByRole('textbox').fill('Oi, Aurora');
  await chat.getByRole('textbox').press('Enter');
  await expect(chat.getByTestId('companion-waiting')).toBeVisible();
  await expect(avatar(page, id)).toHaveAttribute('data-state', 'thinking');
  // Segundo envio durante o pendente não sai (sem request duplicado).
  await chat.getByRole('textbox').fill('de novo');
  await chat.getByRole('textbox').press('Enter');
  ai.release();
  await expect(chat.getByTestId('companion-bubble').last()).toContainText('Posso ajudar');
  await expect(avatar(page, id)).not.toHaveAttribute('data-state', 'thinking');
  expect(ai.bodies).toHaveLength(1);
  expect(await messagesOf(page, id)).toEqual(['user:Oi, Aurora', 'assistant:Olá! Posso ajudar com o quadro.']);
  // Clássico mostra as MESMAS mensagens.
  await page.keyboard.press('Escape');
  await page.evaluate((id) => { const a = (window as any).__aurora; a.actions.updateWidgetData(id, (d: any) => ({ ...d, companion: { ...d.companion, displayMode: 'classic' } })); }, id);
  await expect(page.locator(`[data-widget-root="${id}"]`).getByText('Olá! Posso ajudar com o quadro.')).toBeVisible();
  expect(await messagesOf(page, id)).toHaveLength(2);
});

test('B — dock: conversar de qualquer lugar do quadro, ir ao widget e desafixar', async ({ page }) => {
  const ai = await mockAI(page, { replies: ['Resposta pelo dock'] });
  await newBoard(page);
  const id = await addCompanion(page, { docked: true, at: { x: 0, y: 0 } });
  // Câmera muito longe do personagem.
  await page.evaluate(() => (window as any).__aurora.store.setState({ camera: { x: -40000, y: -30000, zoom: 1 } }));
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toHaveCount(0);
  const item = page.locator(`[data-testid="companion-dock-item"][data-id="${id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  const chat = page.getByTestId('companion-minichat');
  await chat.getByRole('textbox').fill('Pergunta pelo dock');
  await chat.getByRole('button', { name: 'Enviar' }).click();
  await expect(chat.getByTestId('companion-bubble').last()).toContainText('Resposta pelo dock');
  expect(ai.bodies).toHaveLength(1);
  // A dock não cobre o painel de propriedades (#10).
  const dock = (await page.getByTestId('companion-dock').boundingBox())!;
  const props = (await page.getByTestId('properties-panel').boundingBox())!;
  expect(dock.x + dock.width).toBeLessThanOrEqual(props.x + 1);
  await chat.getByRole('button', { name: 'Ir para o assistente no quadro' }).click();
  await page.waitForFunction(() => !(window as any).__aurora.core.isCameraAnimating());
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toBeVisible();
  await chat.getByRole('button', { name: 'Desafixar do dock' }).click();
  await expect(page.getByTestId('companion-dock')).toHaveCount(0);
});

test('C — resposta com o mini chat fechado vira “nova resposta” no dock até abrir', async ({ page }) => {
  const ai = await mockAI(page);
  await newBoard(page);
  const id = await addCompanion(page, { docked: true });
  await page.locator(`[data-testid="companion-dock-item"][data-id="${id}"]`).click();
  const chat = page.getByTestId('companion-minichat');
  ai.holdNext();
  await chat.getByRole('textbox').fill('demora');
  await chat.getByRole('textbox').press('Enter');
  await chat.getByRole('button', { name: 'Fechar conversa' }).click();
  ai.release();
  await expect(page.locator(`[data-testid="companion-dock-item"][data-id="${id}"] [data-testid="companion-unread"]`)).toBeVisible();
  await page.locator(`[data-testid="companion-dock-item"][data-id="${id}"]`).click();
  await expect(page.locator(`[data-testid="companion-dock-item"][data-id="${id}"] [data-testid="companion-unread"]`)).toHaveCount(0);
});

test('D — dois assistentes: estados e históricos isolados; clicar num durante a resposta do outro', async ({ page }) => {
  const ai = await mockAI(page, { replies: ['resposta para A', 'resposta para B'] });
  await newBoard(page);
  const a = await addCompanion(page, { title: 'Aurora', at: { x: -150, y: 0 } });
  const b = await addCompanion(page, { title: 'Sol', preset: 'sol', at: { x: 150, y: 0 } });
  await page.locator(`[data-testid="companion-character"][data-id="${a}"] [data-testid="companion-open"]`).click();
  ai.holdNext();
  await page.getByTestId('companion-minichat').getByRole('textbox').fill('para A');
  await page.getByTestId('companion-minichat').getByRole('textbox').press('Enter');
  await expect(avatar(page, a)).toHaveAttribute('data-state', 'thinking');
  await page.keyboard.press('Escape');
  await page.locator(`[data-testid="companion-character"][data-id="${b}"] [data-testid="companion-open"]`).click();
  await expect(page.getByTestId('companion-minichat')).toHaveAttribute('data-id', b);
  await expect(avatar(page, b)).not.toHaveAttribute('data-state', 'thinking');
  ai.release();
  await expect.poll(() => messagesOf(page, a)).toEqual(['user:para A', 'assistant:resposta para A']);
  expect(await messagesOf(page, b)).toEqual([]);
});

test('E — erro do provedor: estado de erro acessível, sem resposta inventada', async ({ page }) => {
  await mockAI(page, { fail: true });
  await newBoard(page);
  const id = await addCompanion(page);
  await page.getByTestId('companion-open').click();
  const chat = page.getByTestId('companion-minichat');
  await chat.getByRole('textbox').fill('oi');
  await chat.getByRole('textbox').press('Enter');
  await expect(chat.getByTestId('companion-error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(avatar(page, id)).toHaveAttribute('data-state', 'error');
  expect(await messagesOf(page, id)).toEqual(['user:oi']);
});

test('F — resposta com ações propostas: nada é aplicado pelo mini chat; revisão na conversa completa', async ({ page }) => {
  const proposal = 'Sugestão:\n\n```json\n' + JSON.stringify({ version: 2, actions: [{ type: 'create_note', title: 'Plano', content: 'Passo 1' }] }) + '\n```';
  await mockAI(page, { replies: [proposal] });
  await newBoard(page);
  await addCompanion(page);
  const before = (await state(page)).elements.length;
  await page.getByTestId('companion-open').click();
  const chat = page.getByTestId('companion-minichat');
  await chat.getByRole('textbox').fill('crie um plano');
  await chat.getByRole('textbox').press('Enter');
  await expect(chat.getByTestId('companion-review-actions')).toBeVisible();
  await chat.getByTestId('companion-bubble').last().click({ position: { x: 6, y: 6 } }); // clicar no balão não aplica nada
  expect((await state(page)).elements.length).toBe(before);
  await chat.getByTestId('companion-review-actions').click();
  const full = page.getByTestId('companion-full');
  await expect(full).toBeVisible();
  await expect(full.getByTestId('ai-proposal')).toBeVisible();
  await expect(full.getByTestId('ai-proposal-apply')).toBeVisible();
  expect((await state(page)).elements.length).toBe(before);
});

test.describe('animação', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('G — standby anima localmente sem chamar a API; limite de instâncias; “Desligadas” deixa estático', async ({ page }) => {
    const ai = await mockAI(page);
    await newBoard(page);
    for (let i = 0; i < 8; i++) await addCompanion(page, { title: `C${i}`, at: { x: (i % 4) * 200 - 300, y: Math.floor(i / 4) * 240 - 120 } });
    await page.waitForTimeout(3000);
    expect(ai.bodies).toHaveLength(0); // standby nunca chama a IA
    const animated = await page.locator('[data-testid="companion-avatar"][data-animated="true"]').count();
    expect(animated).toBeGreaterThan(0);
    expect(animated).toBeLessThanOrEqual(6);
    await page.evaluate(() => (window as any).__aurora.actions.setCompanionPrefs({ motion: 'off' }));
    await expect(page.locator('[data-testid="companion-avatar"][data-animated="true"]')).toHaveCount(0);
    // O chat continua funcionando com animações desligadas.
    await page.locator('[data-testid="companion-open"]').first().click();
    await expect(page.getByTestId('companion-minichat')).toBeVisible();
  });
});

test('H — movimento reduzido no sistema: personagem estático por padrão; compatibilidade e persistência', async ({ page }) => {
  await mockAI(page);
  await newBoard(page);
  const id = await addCompanion(page);
  await expect(avatar(page, id)).toHaveAttribute('data-animated', 'false');
  // Bloco antigo (sem `companion`) continua clássico.
  const old = await page.evaluate(() => { const a = (window as any).__aurora; const el = a.actions.addWidget('aurora.ai', { x: 600, y: 0 }, { messages: [{ id: 'm1', role: 'assistant', content: 'mensagem antiga', at: 1 }] }); a.store.setState({ editingWidgetId: null }); return el.id; });
  await expect(page.locator(`[data-widget-root="${old}"]`).getByText('mensagem antiga')).toBeVisible();
  expect(await page.evaluate((id) => (window as any).__aurora.getState().elements.find((e: any) => e.id === id).data.companion, old)).toBeUndefined();
  await waitSaved(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toBeVisible();
  // Desfazer volta ao visual anterior.
  await page.evaluate((id) => { const a = (window as any).__aurora; a.actions.updateWidgetData(id, (d: any) => ({ ...d, companion: { ...d.companion, displayMode: 'classic' } })); }, id);
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toHaveCount(0);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toBeVisible();
});

/** Codex P2 (PR #19): a conversa completa é modal — foco dentro, contido, Esc fecha, foco volta, atalhos do quadro mudos. */
test('J — conversa completa: foco, contenção, Esc e nenhum atalho do quadro atrás do diálogo', async ({ page }) => {
  await mockAI(page);
  await newBoard(page);
  const id = await addCompanion(page, { messages: [{ id: 'm1', role: 'user', content: 'pergunta antiga', at: 1 }, { id: 'm2', role: 'assistant', content: 'resposta antiga', at: 2 }] });
  const inFull = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="companion-full"]'));
  const geometry = () => page.evaluate((id) => { const s = (window as any).__aurora.getState(); const e = s.elements.find((x: any) => x.id === id); return e ? { x: e.x, y: e.y, n: s.elements.length, tool: s.tool } : null; }, id);

  await page.getByTestId('companion-open').click();
  await page.getByTestId('companion-minichat').getByRole('button', { name: 'Abrir a conversa completa' }).click();
  const full = page.getByTestId('companion-full');
  await expect(full).toBeVisible();
  await expect(full.getByText('resposta antiga')).toBeVisible();
  // O assistente fica SELECIONADO atrás do diálogo (cenário do apontamento).
  await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), id);
  await expect.poll(inFull).toBe(true);
  const before = await geometry();

  // Atalhos do quadro não agem: Delete/Backspace, setas, ferramentas, duplicar, selecionar tudo.
  for (const k of ['Delete', 'Backspace', 'ArrowRight', 'ArrowDown', 'r', 'v', 'Control+d', 'Control+a']) await page.keyboard.press(k);
  expect(await geometry()).toEqual(before);
  await expect(full).toBeVisible();

  // Tab e Shift+Tab nunca saem do diálogo.
  for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); expect(await inFull()).toBe(true); }
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); expect(await inFull()).toBe(true); }

  // Foco perdido para o <body> volta ao diálogo; e mesmo nesse intervalo, Delete não exclui nada.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Delete');
  expect(await geometry()).toEqual(before);
  await expect.poll(inFull).toBe(true);

  // Esc fecha só o diálogo (seleção e quadro intactos) e o foco volta a quem abriu.
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
  await expect(page.getByTestId('companion-open')).toBeFocused();
  expect(await geometry()).toEqual(before);
  expect((await state(page)).selectedIds).toEqual([id]);
});

test('I — inspetor: trocar visual e fixar no dock pelo painel de propriedades', async ({ page }) => {
  await mockAI(page);
  await newBoard(page);
  const id = await addCompanion(page, { mode: 'classic' });
  await page.evaluate((id) => (window as any).__aurora.actions.setSelection([id]), id);
  const insp = page.getByTestId('companion-inspector');
  await expect(insp).toBeVisible();
  await insp.getByRole('radio', { name: 'Personagem' }).click();
  await expect(page.locator(`[data-testid="companion-character"][data-id="${id}"]`)).toBeVisible();
  await insp.getByLabel('Personagem').selectOption('nimbus');
  await insp.getByRole('checkbox', { name: /Fixar no dock/ }).check();
  await expect(page.locator(`[data-testid="companion-dock-item"][data-id="${id}"]`)).toBeVisible();
});
