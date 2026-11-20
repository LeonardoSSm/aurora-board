/** Issue #14 — Command Center: normalização, extração com privacidade, pontuação, trechos e recentes. */
import { describe, expect, it } from 'vitest';
import { elementDocs, normalize, pushRecent, sanitizeRecents, scoreDoc, snippet, terms, type SearchDoc } from '../../src/core/search';
import { createShape, createText, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';

const name = (t: string) => ({ [WIDGET.notes]: 'Notas', [WIDGET.tasks]: 'Tarefas', [WIDGET.ai]: 'Assistente IA' } as Record<string, string>)[t] ?? t;
const docsOf = (el: Parameters<typeof elementDocs>[0]) => elementDocs(el, 'B1', 'W1', name);
const widget = (type: string, title: string, data: unknown) => createWidget(type, '1.0.0', title, 0, 0, 200, 100, data);

describe('normalização', () => {
  it('ignora caixa, acentos e espaços extras', () => {
    expect(normalize('  Ação   RÁPIDA  ')).toBe('acao rapida');
    expect(normalize('Coração')).toBe(normalize('coracao'));
    expect(terms('Plano  plano ANUAL')).toEqual(['plano', 'anual']);
    expect(terms('')).toEqual([]);
  });
});

describe('extração com privacidade', () => {
  it('textos, notas adesivas e formas com texto', () => {
    const t = createText(0, 0, 'Reunião de orçamento');
    const d = docsOf(t);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'element', boardId: 'B1', title: 'Reunião de orçamento', filter: 'notes' });
    const s = { ...createShape('sticky', 0, 0, 100, 100), text: 'Ideia X' };
    expect(docsOf(s)[0].typeLabel).toBe('Nota adesiva');
    expect(docsOf(createShape('rectangle', 0, 0, 10, 10))).toEqual([]); // forma sem texto
  });
  it('tarefas: cada item vira resultado próprio com estado', () => {
    const w = widget(WIDGET.tasks, 'Casa', { items: [{ id: 't1', text: 'Pagar conta de luz', status: 'done', priority: 'low', dueDate: '' }, { id: 't2', text: '', status: 'todo' }], hideDone: false });
    const d = docsOf(w);
    expect(d.map((x) => x.kind)).toEqual(['element', 'task']);
    expect(d[1]).toMatchObject({ title: 'Pagar conta de luz', status: 'done', id: w.id });
    expect(d[1].body).toContain('concluída');
  });
  it('IA, sandbox HTML e blocos financeiros: só o título, conteúdo marcado como oculto', () => {
    const ai = widget(WIDGET.ai, 'Assistente', { messages: [{ id: 'm', role: 'user', content: 'meu saldo secreto 1234', at: 1 }], instruction: 'prompt privado' });
    const html = widget(WIDGET.sandbox, 'Painel', { html: '<script>token="abc"</script>' });
    const bank = widget(WIDGET.bankQuery, 'Gastos', { accountIds: ['acc-1'], period: '2026-11' });
    const value = widget(WIDGET.value, 'Salário', { amount: 123456 });
    for (const w of [ai, html, bank, value]) {
      const [d] = docsOf(w);
      expect(d.body).toBe('');
      expect(d.contentHidden).toBe(true);
      expect(JSON.stringify(d)).not.toMatch(/secreto|prompt privado|script|token|acc-1|123456/);
    }
  });
  it('documentos: só metadados, nunca a URL nem o asset', () => {
    const w = widget(WIDGET.documents, 'Arquivos', { docs: [{ id: 'd', name: 'contrato.pdf', description: 'aluguel', tags: ['casa'], url: 'https://x.test/secret', assetId: 'asset_123', mimeType: 'application/pdf', size: 1, addedAt: 1 }], selected: 'd' });
    const [d] = docsOf(w);
    expect(d.body).toContain('contrato.pdf');
    expect(d.body).toContain('aluguel');
    expect(d.body).not.toContain('secret');
    expect(d.body).not.toContain('asset_123');
  });
  it('notas Markdown sem URLs; código indexado', () => {
    const n = widget(WIDGET.notes, 'Diário', { markdown: '# Viagem\nver https://exemplo.test/x?token=1', mode: 'edit' });
    expect(docsOf(n)[0].body).toContain('Viagem');
    expect(docsOf(n)[0].body).not.toContain('token');
    const c = widget(WIDGET.code, 'Script', { language: 'ts', code: 'const soma = 1', wrap: false });
    expect(docsOf(c)[0]).toMatchObject({ filter: 'code' });
    expect(docsOf(c)[0].body).toContain('soma');
  });
  // Apontamento do PR #18: a pontuação era trocada antes de remover a URL, que ficava partida e pesquisável.
  it.each([
    'https://example.test/path#access_token=secret123',
    'https://example.test/a-b_c/d?x=1&api_key=secret123',
    '[link](https://example.test/x_y-z#frag-secret123)',
    '<https://example.test/~u/secret123>',
    'ftp://user:secret123@example.test/file',
    'mailto:pessoa@example.test?subject=secret123',
    'www.example.test/secret123',
  ])('notas: URL removida inteira (%s)', (url) => {
    const n = widget(WIDGET.notes, 'Diário', { markdown: `Antes ${url} depois`, mode: 'edit' });
    const [d] = docsOf(n);
    expect(d.body).toContain('Antes');
    expect(d.body).toContain('depois');
    expect(d.body).not.toMatch(/secret123|access|token|api|example/);
    expect(JSON.stringify(snippet(d.body, terms('depois')))).not.toMatch(/secret123/);
  });
  it('widget desconhecido (terceiros): só o título', () => {
    const w = widget('acme.plugin', 'Meu plugin', { segredo: 'x' });
    expect(docsOf(w)[0]).toMatchObject({ body: '', contentHidden: true });
  });
});

describe('pontuação e trechos', () => {
  const doc = (title: string, body = '', extra: Partial<SearchDoc> = {}): SearchDoc => ({ key: `element:B:${title}`, kind: 'element', boardId: 'B', workspaceId: 'W', id: title, title, body, typeLabel: 'Texto', filter: 'notes', updatedAt: 0, ...extra });
  const score = (d: SearchDoc, q: string) => scoreDoc(d, terms(q), normalize(d.title), normalize(d.body), 0);
  it('todos os termos são obrigatórios', () => {
    expect(score(doc('Plano anual'), 'plano mensal')).toBe(-1);
    expect(score(doc('Plano', 'revisão anual'), 'plano anual')).toBeGreaterThan(0);
  });
  it('título vale mais que corpo; início de palavra vale mais', () => {
    expect(score(doc('Orçamento'), 'orcamento')).toBeGreaterThan(score(doc('Outro', 'orçamento'), 'orcamento'));
    expect(score(doc('Plano'), 'pla')).toBeGreaterThan(score(doc('Explanação'), 'pla'));
  });
  it('recência e tipo desempatam', () => {
    const now = 100 * 86_400_000;
    const recent = scoreDoc(doc('Casa', '', { updatedAt: now }), ['casa'], 'casa', '', now);
    const old = scoreDoc(doc('Casa', '', { updatedAt: 0 }), ['casa'], 'casa', '', now);
    expect(recent).toBeGreaterThan(old);
    expect(score(doc('Casa', '', { kind: 'board' }), 'casa')).toBeGreaterThan(score(doc('Casa'), 'casa'));
  });
  it('trecho curto com o termo original destacado (acentos preservados)', () => {
    const s = snippet('Lista de compras: pão, café e açúcar para a semana toda', terms('acucar'))!;
    expect(s.hit).toBe('açúcar');
    expect(s.before.length).toBeLessThanOrEqual(43);
    expect(snippet('nada aqui', ['xyz'])).toBeNull();
  });
});

describe('recentes', () => {
  it('saneamento descarta inválidos e duplicados; push move para o topo e limita', () => {
    expect(sanitizeRecents('x')).toEqual([]);
    expect(sanitizeRecents([{ key: 'board:B', at: 1 }, { key: 'board:B', at: 2 }, { key: 'evil', at: 1 }, { key: 'element:B:e', at: NaN }, null])).toEqual([{ key: 'board:B', at: 1 }]);
    let r = [{ key: 'board:A', at: 1 }];
    r = pushRecent(r, 'board:B', 2);
    r = pushRecent(r, 'board:A', 3);
    expect(r.map((x) => x.key)).toEqual(['board:A', 'board:B']);
    for (let i = 0; i < 20; i++) r = pushRecent(r, `board:${i}`, 10 + i);
    expect(r).toHaveLength(12);
  });
});
