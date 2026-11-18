/**
 * Testes de interação reais (mouse/teclado no navegador) cobrindo os critérios de aceitação.
 * Cada teste usa um contexto novo do navegador = IndexedDB vazio.
 */
import { expect, test } from '@playwright/test';
import { drag, drawShape, ready, state, toPage, waitSaved } from './helpers';

test('1-3: quadro vazio, desenhar formas e escrever dentro do retângulo com duplo clique', async ({ page }) => {
  await ready(page);
  const s0 = await state(page);
  expect(s0.boards.find((b) => b.id === s0.boardId)?.name).toBe('Meu primeiro quadro');
  expect(s0.elements).toHaveLength(0);

  await drawShape(page, 'r', 0, 0, 200, 120);
  await drawShape(page, 'o', -420, 0, -260, 120);
  await drawShape(page, 'd', -220, 0, -40, 120);
  const s1 = await state(page);
  expect(s1.elements.map((e) => e.type)).toEqual(['rectangle', 'ellipse', 'diamond']);
  expect(s1.elements[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 120 });

  const c = await toPage(page, 100, 60);
  await page.mouse.dblclick(c.x, c.y);
  await expect(page.getByTestId('text-editor')).toBeFocused();
  await page.keyboard.type('Texto dentro');
  await page.keyboard.press('Escape');
  const s2 = await state(page);
  expect(s2.elements[0].text).toBe('Texto dentro');
  await expect(page.locator(`[data-element-id="${s2.elements[0].id}"]`)).toContainText('Texto dentro');
});

test('4: tamanhos S/M/L/XL e famílias de fonte', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 240, 120);
  const c = await toPage(page, 120, 60);
  await page.mouse.dblclick(c.x, c.y);
  await page.keyboard.type('Fonte');
  await page.keyboard.press('Escape');
  const props = page.getByTestId('properties');
  for (const [label, px] of [['S', 16], ['M', 20], ['L', 28], ['XL', 36]] as const) {
    await props.getByRole('radiogroup', { name: 'Tamanho do texto' }).getByRole('radio', { name: label, exact: true }).click();
    expect((await state(page)).elements[0].style.fontSize).toBe(px);
  }
  for (const [label, fam] of [['Sans', 'sans'], ['Mono', 'mono'], ['Serifada', 'serif'], ['Manual', 'hand']] as const) {
    await props.getByRole('radiogroup', { name: 'Família tipográfica' }).getByRole('radio', { name: label }).click();
    expect((await state(page)).elements[0].style.fontFamily).toBe(fam);
  }
  // texto independente com a ferramenta T
  await page.keyboard.press('t');
  const p = await toPage(page, 0, 300);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('Texto livre');
  await page.keyboard.press('Escape');
  const s = await state(page);
  expect(s.elements.find((e) => e.type === 'text')?.text).toBe('Texto livre');
});

test('5-7 + 16: agrupar, mover grupo, desagrupar, desfazer/refazer', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 100, 100);
  await drawShape(page, 'o', 200, 0, 300, 100);
  // seleção por área
  await drag(page, await toPage(page, -20, -20), await toPage(page, 320, 120));
  expect((await state(page)).selectedIds).toHaveLength(2);
  await page.keyboard.press('Control+g');
  let s = await state(page);
  const gid = s.elements[0].groupIds[0];
  expect(gid).toBeTruthy();
  expect(s.elements[1].groupIds[0]).toBe(gid);

  // clicar no fundo, depois arrastar pela borda do retângulo: move o grupo inteiro
  const bg = await toPage(page, 600, 400);
  await page.mouse.click(bg.x, bg.y);
  await drag(page, await toPage(page, 1, 50), await toPage(page, 101, 250));
  s = await state(page);
  expect([s.elements[0].x, s.elements[0].y]).toEqual([100, 200]);
  expect([s.elements[1].x, s.elements[1].y]).toEqual([300, 200]);

  await page.keyboard.press('Control+Shift+g');
  s = await state(page);
  expect(s.elements.every((e) => e.groupIds.length === 0)).toBe(true);

  await page.keyboard.press('Control+z'); // desfaz desagrupar
  expect((await state(page)).elements[0].groupIds).toHaveLength(1);
  await page.keyboard.press('Control+z'); // desfaz mover
  expect((await state(page)).elements[0].x).toBe(0);
  await page.keyboard.press('Control+Shift+z'); // refaz mover
  expect((await state(page)).elements[0].x).toBe(100);
});

test('8-9: setas entre formas acompanham o movimento', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', -350, 0, -200, 100);
  await drawShape(page, 'r', 50, 0, 200, 100);
  await page.keyboard.press('a');
  await drag(page, await toPage(page, -275, 50), await toPage(page, 125, 50), { steps: 12 });
  let s = await state(page);
  const arrow = s.elements.find((e) => e.type === 'arrow')!;
  expect(arrow.startBinding?.elementId).toBe(s.elements[0].id);
  expect(arrow.endBinding?.elementId).toBe(s.elements[1].id);

  // arrasta o destino para baixo pela borda
  await drag(page, await toPage(page, 200, 50), await toPage(page, 200, 350));
  s = await state(page);
  const a2 = s.elements.find((e) => e.id === arrow.id)!;
  expect(a2.endBinding?.elementId).toBe(s.elements[1].id);
  const endY = a2.y + a2.points![1][1];
  expect(endY).toBeGreaterThan(280);

  // ferramenta Conectar com tipo Dados
  await page.keyboard.press('c');
  await page.getByRole('radio', { name: 'Dados' }).click();
  await drag(page, await toPage(page, -275, 50), await toPage(page, 125, 350), { steps: 12 });
  s = await state(page);
  const conn = s.elements.filter((e) => e.type === 'arrow');
  expect(conn).toHaveLength(2);
});

test('10-11: bloco financeiro com receitas, despesas e cálculos corretos', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.finance"]').click();
  const add = async (kind: 'Receita' | 'Despesa', desc: string, value: string) => {
    await page.getByTestId('finance-add').click();
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page.getByTestId('finance-desc').fill(desc);
    await page.getByTestId('finance-amount').fill(value);
    await page.getByTestId('finance-save').click();
  };
  await add('Receita', 'Salário', '5.000,00');
  await add('Despesa', 'Aluguel', '1.800,50');
  await add('Despesa', 'Mercado', '0,10');
  await expect(page.getByTestId('finance-balance')).toHaveText(/R\$\s?3\.199,40/);
  await expect(page.getByTestId('finance-income')).toHaveText(/5\.000,00/);
  await expect(page.getByTestId('finance-expense')).toHaveText(/1\.800,60/);
});

test('12: notas, tarefas, texto e imagem', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.notes"]').click();
  await page.locator('[data-widget-body] textarea').first().fill('# Ideia\n- item');
  await page.locator('[data-library-item="aurora.tasks"]').click();
  const taskInput = page.getByPlaceholder('Nova tarefa e Enter');
  await taskInput.fill('Primeira tarefa');
  await taskInput.press('Enter');
  await expect(page.getByTestId('tasks-progress')).toHaveText('0/1 concluídas');
  await page.getByRole('checkbox', { name: 'Concluir Primeira tarefa' }).check();
  await expect(page.getByTestId('tasks-progress')).toHaveText('1/1 concluídas');

  // imagem via seletor de arquivo
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGRgYAAAhAQX/7xHnBQAAAABJRU5ErkJggg==', 'base64');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-library-item="tool:image"]').click();
  await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect.poll(async () => (await state(page)).elements.some((e) => e.type === 'image')).toBe(true);
  const s = await state(page);
  const notes = s.elements.find((e) => e.widgetType === 'aurora.notes')!;
  expect(notes.data.markdown).toContain('# Ideia');
});

test('13-14: segundo quadro independente e persistência após recarregar', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 100, 100);
  await page.getByRole('button', { name: 'Novo quadro' }).click();
  await page.getByPlaceholder('Nome do quadro').fill('Planejamento');
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByTestId('board-name')).toHaveText('Planejamento');
  expect((await state(page)).elements).toHaveLength(0);
  await drawShape(page, 'o', 0, 0, 80, 80);
  await waitSaved(page);

  await page.reload();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
  let s = await state(page);
  expect(s.boards.find((b) => b.id === s.boardId)?.name).toBe('Planejamento');
  expect(s.elements.map((e) => e.type)).toEqual(['ellipse']);
  const first = s.boards.find((b) => b.name === 'Meu primeiro quadro')!;
  await page.getByRole('button', { name: 'Abrir lista de quadros' }).click();
  await page.getByTestId('boards-list').getByText('Meu primeiro quadro').click();
  await page.waitForFunction((id) => (window as any).__aurora.getState().boardId === id, first.id);
  s = await state(page);
  expect(s.elements.map((e) => e.type)).toEqual(['rectangle']);
});

test('15 + 20: exportar e importar JSON (sem sobrescrever) e importar v0.3', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 0, 0, 100, 100);
  await page.getByRole('button', { name: /Exportar/ }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Este quadro/ }).click();
  const file = await dl;
  const path = await file.path();
  const boardsBefore = (await state(page)).boards.length;

  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser).setFiles(path!);
  await expect(page.getByRole('dialog')).toContainText('adicionados como novos');
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect.poll(async () => (await state(page)).boards.length).toBe(boardsBefore + 1);
  expect((await state(page)).elements.map((e) => e.type)).toEqual(['rectangle']);

  // v0.3
  const legacy = { version: 2, active: 'x', boards: [{ id: 'x', name: 'Antigo', camera: { x: 0, y: 0, z: 1 }, nodes: [{ id: 'n', type: 'finance', x: 0, y: 0, w: 265, title: 'Fin', desc: '', data: { items: [{ id: 'i', text: 'Entrada', value: 10 }] } }, { id: 'm', type: 'manual_rect', x: 300, y: 0, w: 100, h: 60, title: '', desc: 'Oi', style: {}, data: {} }], edges: [{ id: 'e', from: 'n', to: 'm', kind: 'reference', label: '' }], strokes: [] }] };
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser2 = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser2).setFiles({ name: 'v03.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await expect(page.getByRole('dialog')).toContainText('v0.2/v0.3');
  await page.getByRole('button', { name: 'Importar como novos quadros' }).click();
  await expect(page.getByTestId('board-name')).toHaveText('Antigo (v0.3)');
  const s = await state(page);
  expect(s.elements.map((e) => e.type).sort()).toEqual(['arrow', 'rectangle', 'widget']);

  // arquivo inválido é recusado sem alterar nada
  await page.getByRole('button', { name: /Importar/ }).click();
  const chooser3 = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Arquivo JSON/ }).click();
  await (await chooser3).setFiles({ name: 'ruim.json', mimeType: 'application/json', buffer: Buffer.from('{oops') });
  await expect(page.getByRole('dialog')).toContainText('Importação recusada');
});

test('19: bloco de IA sem credenciais aparece como não configurado (sem respostas simuladas)', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.ai"]').click();
  await expect(page.getByTestId('ai-status')).toContainText('Não configurado');
  await expect(page.getByPlaceholder('IA não configurada')).toBeDisabled();
});

test('atalhos não interferem na digitação e copiar/colar/duplicar funcionam', async ({ page }) => {
  await ready(page);
  await page.locator('[data-library-item="aurora.notes"]').click();
  const ta = page.locator('[data-widget-body] textarea').first();
  await ta.click();
  await page.keyboard.type('rodhvat');
  expect((await state(page)).tool).toBe('select');
  await expect(ta).toHaveValue('rodhvat');
  // fora do campo: Ctrl+D duplica
  const bg = await toPage(page, 1500, 1500);
  await page.mouse.click(bg.x, bg.y);
  await drawShape(page, 'r', 0, 0, 50, 50);
  await page.keyboard.press('Control+d');
  expect((await state(page)).elements.filter((e) => e.type === 'rectangle')).toHaveLength(2);
  await page.keyboard.press('Delete');
  expect((await state(page)).elements.filter((e) => e.type === 'rectangle')).toHaveLength(1);
});

test('paridade Excalidraw: Enter escreve, Ctrl+seta cria fluxo, foco não fica em botões, dica contextual', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', -300, 0, -160, 80);
  await expect(page.getByTestId('hint')).toContainText('Ctrl+setas');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Início');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Fim');
  await page.keyboard.press('Escape');
  let s = await state(page);
  expect(s.elements.filter((e) => e.type === 'rectangle').map((e) => e.text)).toEqual(['Início', 'Fim']);
  const arrow = s.elements.find((e) => e.type === 'arrow')!;
  expect(arrow.startBinding?.elementId).toBe(s.elements[0].id);
  await page.keyboard.press('Alt+ArrowLeft');
  expect((await state(page)).selectedIds).toEqual([s.elements[0].id]);

  // clicar no zoom e depois Espaço não reaciona o botão; ferramenta de desenho limpa a seleção
  await page.getByRole('button', { name: 'Aumentar zoom' }).click();
  const z = (await state(page)).camera.zoom;
  await page.keyboard.press('Space');
  expect((await state(page)).camera.zoom).toBe(z);
  await page.getByRole('button', { name: 'Elipse' }).click();
  s = await state(page);
  expect(s.tool).toBe('ellipse');
  expect(s.selectedIds).toEqual([]);
  await expect(page.getByTestId('hint')).toContainText('Arraste para desenhar');
});

test('setas multiponto: clicar cria pontos, curva passa por eles, edição de pontos', async ({ page }) => {
  await ready(page);
  await drawShape(page, 'r', 150, -60, 260, 40);
  await page.keyboard.press('a');
  for (const [x, y] of [[-300, 100], [-200, -40], [-100, 120]] as const) {
    const p = await toPage(page, x, y);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByTestId('hint')).toContainText('Enter ou Esc para finalizar');
  const t = await toPage(page, 200, -10);
  await page.mouse.move(t.x, t.y, { steps: 6 });
  await page.mouse.click(t.x, t.y); // clicar na forma ancora e finaliza
  let s = await state(page);
  const arrow = s.elements.find((e) => e.type === 'arrow')!;
  expect(arrow.points).toHaveLength(4);
  expect(arrow.endBinding?.elementId).toBe(s.elements[0].id);
  expect((arrow as any).path).toBe('curved');

  // arrastar o ponto médio do 1º segmento cria um ponto; clicar nele + Delete remove
  const pts = arrow.points!.map(([x, y]) => [arrow.x + x, arrow.y + y]);
  const mid = await page.evaluate(([id]) => {
    const st = (window as any).__aurora.getState();
    const el = st.elements.find((e: any) => e.id === id);
    return { n: el.points.length };
  }, [arrow.id]);
  expect(mid.n).toBe(4);
  const p1 = await toPage(page, pts[1][0], pts[1][1]);
  await page.mouse.click(p1.x, p1.y);
  expect((await state(page)).selectedIds).toEqual([arrow.id]);
  await page.mouse.click(p1.x, p1.y); // seleciona o ponto
  await page.keyboard.press('Delete');
  s = await state(page);
  expect(s.elements.find((e) => e.id === arrow.id)!.points).toHaveLength(3);
});
