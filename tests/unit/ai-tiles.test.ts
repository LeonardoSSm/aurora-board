/** AI Tiles: presets, validação, layout, logos, persistência, cópia e operações do quadro. */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AI_PRESETS,
  AI_PROVIDER_IDS,
  DISPLAY_SIZES,
  aiTileLayout,
  createAITileData,
  integrationState,
  safeExternalUrl,
  sanitizeAITile,
  type TileNode,
} from '../../src/core/aiTiles';
import { AI_LOGO_SOURCES, logoDataURL } from '../../src/widgets/builtin/aiTileLogos';
import { aiTilePlugin, setTileMode, tileNodesToSVG } from '../../src/widgets/builtin/aiTile';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { findWidgetPreset, getWidget, listWidgets, summarizeElement } from '../../src/widgets/registry';
import { WIDGET } from '../../src/core/widgetIds';
import { cloneElements, createBoard, createLinear, createWidget, createWorkspace } from '../../src/core/elements';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addWidget, duplicateSelected, groupSelection, redo, setSelection, toggleLockSelection, undo, updateElements } from '../../src/store/actions';
import { applyImport, buildExport, parseImport } from '../../src/persistence/exportImport';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { migrateBoard } from '../../src/persistence/migrations';
import { updateBoundArrows } from '../../src/core/bindings';
import type { AuroraElement, LinearElement, WidgetElement } from '../../src/core/schema';

registerBuiltinWidgets();

const tiles = () => getState().elements.filter((e): e is WidgetElement => e.type === 'widget' && e.widgetType === WIDGET.aiTile);
const logos = (nodes: TileNode[]) => nodes.filter((n): n is Extract<TileNode, { kind: 'logo' }> => n.kind === 'logo');
const texts = (nodes: TileNode[]) => nodes.filter((n): n is Extract<TileNode, { kind: 'text' }> => n.kind === 'text').map((n) => n.text);

describe('presets', () => {
  it('seis assistentes com ids estáveis e únicos', () => {
    expect(AI_PROVIDER_IDS).toEqual(['chatgpt', 'codex', 'claude', 'claude-code', 'gemini', 'grok']);
    expect(Object.keys(AI_PRESETS).sort()).toEqual([...AI_PROVIDER_IDS].sort());
  });

  it('cada preset tem nome, empresa, tipo, cor, link https e logos existentes', () => {
    for (const id of AI_PROVIDER_IDS) {
      const p = AI_PRESETS[id];
      expect(p.id).toBe(id);
      expect(p.name && p.company && p.productType && p.description).toBeTruthy();
      expect(p.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.brandBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(safeExternalUrl(p.defaultUrl)).toBe(p.defaultUrl);
      expect(AI_LOGO_SOURCES[p.logoMono]).toBeTruthy();
      if (p.logoColor) expect(AI_LOGO_SOURCES[p.logoColor]).toBeTruthy();
    }
  });

  it('empresas e produtos corretos; produtos da mesma empresa não viram APIs distintas', () => {
    expect([AI_PRESETS.chatgpt.company, AI_PRESETS.codex.company]).toEqual(['OpenAI', 'OpenAI']);
    expect([AI_PRESETS.claude.company, AI_PRESETS['claude-code'].company]).toEqual(['Anthropic', 'Anthropic']);
    expect(AI_PRESETS.gemini.company).toBe('Google');
    expect(AI_PRESETS.grok.company).toBe('xAI');
    expect(AI_PRESETS.chatgpt.apiProvider).toBe(AI_PRESETS.codex.apiProvider);
    expect(AI_PRESETS.claude.apiProvider).toBe(AI_PRESETS['claude-code'].apiProvider);
    expect(AI_PRESETS.grok.apiProvider).toBeNull();
  });

  it('Codex e Claude Code usam símbolo próprio, não a logo genérica da empresa', () => {
    expect(AI_PRESETS.codex.logoMono).toBe('codex');
    expect(AI_PRESETS['claude-code'].logoMono).toBe('claudecode');
  });

  it('presets do widget geram dados completos (link do próprio assistente)', () => {
    const presets = aiTilePlugin.presets!;
    expect(presets.map((p) => p.id)).toEqual([...AI_PROVIDER_IDS]);
    for (const p of presets) {
      expect(p.data.providerId).toBe(p.id);
      expect(p.data.externalUrl).toBe(AI_PRESETS[p.id as keyof typeof AI_PRESETS].defaultUrl);
    }
  });
});

describe('logos locais', () => {
  const dir = 'src/assets/ai-logos';
  const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));

  it('todas as logos referenciadas existem como arquivo local', () => {
    expect(files.length).toBe(Object.keys(AI_LOGO_SOURCES).length);
    for (const key of Object.keys(AI_LOGO_SOURCES)) expect(files).toContain(`${key}.svg`);
  });

  it('SVGs sem script, foreignObject, eventos ou referências externas', () => {
    for (const f of files) {
      const svg = readFileSync(`${dir}/${f}`, 'utf8');
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
      expect(svg).not.toMatch(/<script|foreignObject|\son[a-z]+\s*=|(?:xlink:)?href\s*=\s*"(?!#)|url\((?!#)|@import/i);
    }
  });

  it('versões monocromáticas trocam currentColor só pelo tom pedido', () => {
    const url = logoDataURL('openai', '#ffffff')!;
    const svg = decodeURIComponent(url.split(',')[1]);
    expect(svg).toContain('#ffffff');
    expect(svg).not.toContain('currentColor');
    expect(logoDataURL('openai', 'red;}')).toBe(logoDataURL('openai', null));
  });

  it('logo desconhecida devolve null (sem quebrar)', () => {
    expect(logoDataURL('nao-existe', null)).toBeNull();
  });
});

describe('modelo e validação', () => {
  it('valores padrão seguros', () => {
    const d = createAITileData('claude');
    expect(d).toMatchObject({ providerId: 'claude', displayMode: 'normal', showLabel: true, backgroundStyle: 'dark', logoVariant: 'color', linkedWidgetId: '', externalUrl: 'https://claude.ai/' });
  });

  it('dados inválidos viram padrões; números são limitados', () => {
    const d = sanitizeAITile({ providerId: 42, displayMode: 'giant', accentColor: 'red', radius: 999, logoScale: -3, backgroundStyle: 'neon', showLabel: 'yes', logoVariant: 'rainbow', description: 'x'.repeat(900), linkedWidgetId: 7 });
    expect(d.providerId).toBe('chatgpt');
    expect(d.displayMode).toBe('normal');
    expect(d.accentColor).toBe('');
    expect(d.radius).toBe(50);
    expect(d.logoScale).toBe(0.3);
    expect(d.backgroundStyle).toBe('dark');
    expect(d.showLabel).toBe(true);
    expect(d.logoVariant).toBe('color');
    expect(d.description).toHaveLength(500);
    expect(d.linkedWidgetId).toBe('');
    expect(sanitizeAITile(null)).toEqual(createAITileData('chatgpt'));
  });

  it('preset desconhecido (versão futura) é preservado', () => {
    const d = sanitizeAITile({ providerId: 'futuro-x', description: 'novo' });
    expect(d.providerId).toBe('futuro-x');
    expect(d.externalUrl).toBe('');
    expect(sanitizeAITile({ providerId: '<script>' }).providerId).toBe('chatgpt');
  });

  it('sanitizar é idempotente', () => {
    const d = sanitizeAITile({ providerId: 'gemini', accentColor: '#ABCDEF', displayMode: 'detailed', description: 'Pesquisa' });
    expect(sanitizeAITile(d)).toEqual(d);
    expect(d.accentColor).toBe('#abcdef');
  });

  it('link: ausente → padrão do preset; vazio explícito é respeitado', () => {
    expect(sanitizeAITile({ providerId: 'grok' }).externalUrl).toBe('https://grok.com/');
    expect(sanitizeAITile({ providerId: 'grok', externalUrl: '' }).externalUrl).toBe('');
  });

  it.each([
    ['javascript:alert(1)', ''],
    ['JaVaScRiPt:alert(1)', ''],
    ['data:text/html,<script>alert(1)</script>', ''],
    ['http://claude.ai', ''],
    ['file:///etc/passwd', ''],
    ['https://user:senha@claude.ai/', ''],
    ['//claude.ai', ''],
    ['claude.ai', ''],
    ['  https://claude.ai/new  ', 'https://claude.ai/new'],
    ['https://chatgpt.com/codex', 'https://chatgpt.com/codex'],
  ])('URL %s → %s', (input, out) => {
    expect(safeExternalUrl(input)).toBe(out);
    expect(sanitizeAITile({ providerId: 'claude', externalUrl: input }).externalUrl).toBe(out);
  });
});

describe('integração (calculada, sem indicadores falsos)', () => {
  const linked = (provider: string) => ({ provider });
  it('sem vínculo é visual, mesmo com APIs configuradas', () => {
    expect(integrationState(createAITileData('claude'), null, new Set(['anthropic']))).toBe('visual');
  });
  it('configurado só com bloco vinculado do mesmo provedor e chave no servidor', () => {
    const d = { ...createAITileData('claude-code'), linkedWidgetId: 'ai1' };
    expect(integrationState(d, linked('anthropic'), new Set(['anthropic']))).toBe('configured');
    expect(integrationState(d, linked('anthropic'), new Set(['openai']))).toBe('not-configured');
    expect(integrationState(d, linked('anthropic'), null)).toBe('not-configured');
    expect(integrationState(d, linked('openai'), new Set(['openai', 'anthropic']))).toBe('not-configured');
    expect(integrationState(d, linked(''), new Set(['anthropic']))).toBe('not-configured');
    expect(integrationState(d, null, new Set(['anthropic']))).toBe('link-missing');
  });
  it('Grok nunca aparece como configurado', () => {
    const d = { ...createAITileData('grok'), linkedWidgetId: 'ai1' };
    expect(integrationState(d, linked('openai'), new Set(['openai', 'anthropic', 'gemini']))).toBe('not-configured');
  });
});

describe('layout compartilhado', () => {
  it('compacto: só a logo, quadrada e centralizada', () => {
    const n = aiTileLayout({ ...createAITileData('claude'), displayMode: 'compact' }, 64, 64, 'Claude');
    const [l] = logos(n);
    expect(logos(n)).toHaveLength(1);
    expect(texts(n)).toEqual([]);
    expect(l.w).toBe(l.h);
    expect(l.x + l.w / 2).toBeCloseTo(32);
    expect(l.y + l.h / 2).toBeCloseTo(32);
  });

  it('logo nunca distorce nem sai do tile, em qualquer modo e tamanho', () => {
    for (const mode of ['compact', 'normal', 'detailed'] as const)
      for (const [w, h] of [[24, 24], [64, 64], [104, 112], [200, 150], [400, 90], [60, 300]]) {
        const [l] = logos(aiTileLayout({ ...createAITileData('gemini'), displayMode: mode }, w, h, 'Gemini'));
        expect(l.w).toBe(l.h);
        expect(l.x).toBeGreaterThanOrEqual(-0.01);
        expect(l.y).toBeGreaterThanOrEqual(-0.01);
        expect(l.x + l.w).toBeLessThanOrEqual(w + 0.01);
        expect(l.y + l.h).toBeLessThanOrEqual(h + 0.01);
      }
  });

  it('normal mostra o nome; ocultar nome remove o texto', () => {
    const d = createAITileData('codex');
    expect(texts(aiTileLayout(d, 104, 112, 'Codex'))).toEqual(['Codex']);
    expect(texts(aiTileLayout({ ...d, showLabel: false }, 104, 112, 'Codex'))).toEqual([]);
  });

  it('detalhado mostra nome, empresa e descrição; ocultar descrição remove', () => {
    const d = { ...createAITileData('claude'), displayMode: 'detailed' as const, description: 'Desenvolvimento' };
    expect(texts(aiTileLayout(d, 200, 150, 'Claude'))).toEqual(['Claude', 'Anthropic', 'Desenvolvimento']);
    expect(texts(aiTileLayout({ ...d, showDescription: false }, 200, 150, 'Claude'))).toEqual(['Claude', 'Anthropic']);
  });

  it('indicador de integração só aparece quando há vínculo', () => {
    const d = { ...createAITileData('claude'), displayMode: 'detailed' as const };
    expect(texts(aiTileLayout(d, 200, 150, 'Claude', 'visual'))).not.toContain('API configurada');
    expect(texts(aiTileLayout(d, 200, 150, 'Claude', 'configured'))).toContain('API configurada');
    expect(texts(aiTileLayout(d, 200, 150, 'Claude', 'not-configured'))).toContain('API não configurada');
  });

  it('logo original quando existe; monocromática com tom conforme o fundo', () => {
    const claude = createAITileData('claude');
    expect(logos(aiTileLayout(claude, 104, 112, 'Claude'))[0]).toMatchObject({ logo: 'claude-color', tone: null });
    expect(logos(aiTileLayout({ ...claude, logoVariant: 'mono' }, 104, 112, 'Claude'))[0]).toMatchObject({ logo: 'claude', tone: '#ffffff' });
    const chat = createAITileData('chatgpt');
    expect(logos(aiTileLayout(chat, 104, 112, 'ChatGPT'))[0]).toMatchObject({ logo: 'openai', tone: '#ffffff' });
    expect(logos(aiTileLayout({ ...chat, backgroundStyle: 'brand' }, 104, 112, 'ChatGPT'))[0]).toMatchObject({ logo: 'openai', tone: '#000000' });
  });

  it('preset desconhecido: sem logo (nada que imite marca), iniciais neutras', () => {
    const n = aiTileLayout(sanitizeAITile({ providerId: 'futuro-x' }), 104, 112, 'Futuro X');
    expect(logos(n)).toHaveLength(0);
    expect(texts(n)).toContain('FX');
  });

  it('exportação SVG escapa textos do usuário e inclui a logo embutida', () => {
    const d = { ...createAITileData('grok'), displayMode: 'detailed' as const, description: '<script>alert("x")</script> & "aspas"' };
    const svg = tileNodesToSVG(aiTileLayout(d, 200, 150, 'Grok <b>'));
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toMatch(/<image href="data:image\/svg\+xml;charset=utf-8,/);
  });
});

describe('widget no registro e no quadro', () => {
  beforeEach(() => setState({ ...initialEditorState, boardId: 'b', status: 'ready', history: {}, elements: [], boards: [] }));

  it('registrado como widget nativo, sem moldura, com presets na seção de IAs', () => {
    const p = getWidget(WIDGET.aiTile)!;
    expect(p).toBe(aiTilePlugin);
    expect(p.frame).toBe('bare');
    expect(p.librarySection).toBe('Inteligências Artificiais');
    expect(p.inputs).toEqual([]);
    expect(p.permissions).toEqual([]);
    expect(listWidgets().filter((w) => w.id === WIDGET.aiTile)).toHaveLength(1);
    expect(findWidgetPreset(`${WIDGET.aiTile}#claude-code`)?.preset.name).toBe('Claude Code');
    expect(findWidgetPreset(`${WIDGET.aiTile}#nao-existe`)).toBeNull();
  });

  it('inserir preset cria tile com título, dados e tamanho do modo normal; várias instâncias', () => {
    addWidget(`${WIDGET.aiTile}#gemini`, { x: 0, y: 0 });
    addWidget(`${WIDGET.aiTile}#gemini`, { x: 300, y: 0 });
    const [a, b] = tiles();
    expect(a.title).toBe('Gemini');
    expect(a.id).not.toBe(b.id);
    expect(sanitizeAITile(a.data).providerId).toBe('gemini');
    expect({ w: a.width, h: a.height }).toEqual({ w: DISPLAY_SIZES.normal.width, h: DISPLAY_SIZES.normal.height });
    expect(summarizeElement(a)).toBe('Gemini (Google)');
  });

  it('trocar modo ajusta tamanho mantendo o centro; desfazer/refazer', () => {
    addWidget(`${WIDGET.aiTile}#claude`, { x: 100, y: 100 });
    const t = tiles()[0];
    setTileMode(t.id, 'detailed');
    let cur = tiles()[0];
    expect([cur.width, cur.height]).toEqual([200, 150]);
    expect(cur.x + cur.width / 2).toBeCloseTo(100);
    expect(sanitizeAITile(cur.data).displayMode).toBe('detailed');
    undo();
    cur = tiles()[0];
    expect([cur.width, cur.height, sanitizeAITile(cur.data).displayMode]).toEqual([104, 112, 'normal']);
    redo();
    expect(sanitizeAITile(tiles()[0].data).displayMode).toBe('detailed');
  });

  it('duplicar, agrupar, bloquear e redimensionar usam as operações genéricas', () => {
    addWidget(`${WIDGET.aiTile}#chatgpt`, { x: 0, y: 0 });
    addWidget(`${WIDGET.aiTile}#grok`, { x: 200, y: 0 });
    const ids = tiles().map((t) => t.id);
    setSelection(ids);
    groupSelection();
    expect(new Set(tiles().map((t) => t.groupIds[0])).size).toBe(1);
    setSelection([ids[0]], false);
    duplicateSelected();
    expect(tiles()).toHaveLength(3);
    setSelection([ids[1]], false);
    toggleLockSelection();
    expect(tiles().find((t) => t.id === ids[1])!.locked).toBe(true);
    updateElements(new Set([ids[0]]), (e) => ({ ...e, width: 40, height: 40 }));
    expect(tiles().find((t) => t.id === ids[0])!.width).toBe(40);
  });

  it('seta ancorada acompanha o tile movido', () => {
    const a = createWidget(WIDGET.aiTile, '1.0.0', 'Claude', 0, 0, 104, 112, createAITileData('claude'));
    const b = createWidget(WIDGET.aiTile, '1.0.0', 'Grok', 400, 0, 104, 112, createAITileData('grok'));
    const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
    arrow.startBinding = { elementId: a.id, fixedPoint: null };
    arrow.endBinding = { elementId: b.id, fixedPoint: null };
    let els: AuroraElement[] = updateBoundArrows([a, b, arrow]);
    const before = (els.find((e) => e.id === arrow.id) as LinearElement).x;
    els = updateBoundArrows(els.map((e) => (e.id === a.id ? { ...e, x: e.x + 150, y: e.y + 80 } : e)));
    const moved = els.find((e) => e.id === arrow.id) as LinearElement;
    expect(moved.x).not.toBe(before);
    expect(moved.startBinding?.elementId).toBe(a.id);
  });

  it('copiar tile junto com o bloco de IA mantém o vínculo; sozinho mantém o original', () => {
    const ai = createWidget(WIDGET.ai, '1.0.0', 'IA', 300, 0, 380, 460, { provider: 'anthropic' });
    const tile = createWidget(WIDGET.aiTile, '1.0.0', 'Claude', 0, 0, 104, 112, { ...createAITileData('claude'), linkedWidgetId: ai.id });
    const both = cloneElements([tile, ai], { x: 10, y: 10 });
    const t2 = both.find((e) => e.type === 'widget' && e.widgetType === WIDGET.aiTile) as WidgetElement;
    const a2 = both.find((e) => e.type === 'widget' && e.widgetType === WIDGET.ai)!;
    expect(sanitizeAITile(t2.data).linkedWidgetId).toBe(a2.id);
    const alone = cloneElements([tile], { x: 10, y: 10 })[0] as WidgetElement;
    expect(sanitizeAITile(alone.data).linkedWidgetId).toBe(ai.id);
  });
});

describe('persistência e compatibilidade', () => {
  it('exportar e importar JSON preserva tiles, links, descrições, modos e conexões', async () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Q');
    const t = createWidget(WIDGET.aiTile, '1.0.0', 'Revisora', 10, 20, 200, 150, { ...createAITileData('claude-code'), displayMode: 'detailed', description: 'Revisão de PR', externalUrl: 'https://code.claude.com/docs', accentColor: '#ff8800', backgroundStyle: 'brand' });
    const g = createWidget(WIDGET.aiTile, '1.0.0', 'Gemini', 400, 20, 64, 64, { ...createAITileData('gemini'), displayMode: 'compact' });
    const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]]);
    arrow.startBinding = { elementId: t.id, fixedPoint: null };
    arrow.endBinding = { elementId: g.id, fixedPoint: null };
    board.elements = updateBoundArrows([t, g, arrow]);
    const json = buildExport([board], [], ws);
    const parsed = parseImport(json, ws.id);
    expect(parsed.warnings).toEqual([]);
    const adapter = new MemoryAdapter();
    await adapter.saveBoard(board);
    const { boardIds } = await applyImport(adapter, parsed, ws, () => 'novo');
    expect(boardIds).toEqual(['novo']);
    const loaded = (await adapter.loadBoard('novo'))!;
    const lt = loaded.elements.find((e) => e.id === t.id) as WidgetElement;
    expect(lt).toMatchObject({ title: 'Revisora', x: 10, y: 20, width: 200, height: 150 });
    expect(sanitizeAITile(lt.data)).toEqual(sanitizeAITile(t.data));
    const la = loaded.elements.find((e) => e.id === arrow.id) as LinearElement;
    expect([la.startBinding?.elementId, la.endBinding?.elementId]).toEqual([t.id, g.id]);
    expect((await adapter.loadBoard(board.id))!.name).toBe('Q');
  });

  it('migração mantém tiles (inclusive de versão futura) sem alterar dados', () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Q');
    const future = createWidget(WIDGET.aiTile, '9.0.0', 'Novo', 0, 0, 104, 112, { providerId: 'futuro-x', campoNovo: { a: 1 } });
    board.elements = [future];
    const { board: m } = migrateBoard(JSON.parse(JSON.stringify(board)), ws.id);
    expect(m.elements[0]).toMatchObject({ widgetType: WIDGET.aiTile, widgetVersion: '9.0.0' });
    expect((m.elements[0] as WidgetElement).data).toEqual({ providerId: 'futuro-x', campoNovo: { a: 1 } });
  });

  it('quadros antigos (fixture congelada) continuam importando sem tiles nem avisos', () => {
    const r = parseImport(readFileSync('tests/fixtures/aurora-export-v3.json', 'utf8'), 'ws');
    expect(r.warnings).toEqual([]);
    expect(r.boards[0].elements.some((e) => e.type === 'widget' && e.widgetType === WIDGET.aiTile)).toBe(false);
  });

  it('sem API configurada o tile funciona normalmente (estado visual)', () => {
    const d = createAITileData('chatgpt');
    expect(integrationState(d, null, new Set())).toBe('visual');
    expect(logos(aiTileLayout(d, 104, 112, 'ChatGPT'))).toHaveLength(1);
  });
});
