/** Issue #22 — Smart Links: modelo, saneamento, política de URL, privacidade, layouts e gesto de clique. */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LINK_SIZES,
  defaultVisual,
  displayLabel,
  initialLabel,
  insideClickZone,
  isInsecureHttp,
  knownSite,
  linkTargetUrl,
  redactUrl,
  referenceSize,
  remoteImageAllowed,
  revokeRemoteImageConsent,
  sanitizeVisual,
  shortcutLayout,
  titleFollowingLabel,
  fitLabel,
  followedName,
} from '../../src/core/smartLinks';
import { sanitizeLink } from '../../src/core/widgetData';
import { WIDGET } from '../../src/core/widgetIds';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { getWidget, summarizeElement } from '../../src/widgets/registry';
import { LINK_BRAND_SOURCES, LINK_ICONS, linkIconSVG } from '../../src/widgets/builtin/linkIcons';
import { linkPlugin, openLinkElement, setLinkLayout, setLinkMode, shortcutSVG } from '../../src/widgets/builtin/link';
import { createBoard, createWidget, createWorkspace, cloneElements } from '../../src/core/elements';
import { assetIdsOf, buildExport, parseImport } from '../../src/persistence/exportImport';
import { elementDocs } from '../../src/core/search';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { addElements, pasteContent, redo, undo, worldToScreen } from '../../src/store/actions';
import { clickableWidgetAt, pointerDown, pointerMove, pointerUp, LONG_PRESS_MS, type PointerInfo } from '../../src/canvas/controller';
import type { WidgetElement } from '../../src/core/schema';

registerBuiltinWidgets();

const LEGACY = { url: 'https://exemplo.com/a?token=SEGREDO#x', description: 'Referência', preview: { title: 'Exemplo', description: 'd', image: 'https://cdn.exemplo.com/og.png', siteName: 'Ex', fetchedAt: 5 } };

describe('modelo e compatibilidade', () => {
  it('dados antigos (sem visual) continuam Clássicos e intactos; sanitize é idempotente', () => {
    const d = sanitizeLink(LEGACY);
    expect(d).toEqual(LEGACY);
    expect('visual' in d).toBe(false);
    expect(sanitizeLink(d)).toEqual(d);
    expect(linkPlugin.frameFor!(d)).toBe('standard');
    expect(linkPlugin.clickAction!(d, {} as never)).toBeNull();
  });

  it('inserção nova começa como Atalho Visual horizontal', () => {
    const d = linkPlugin.createData();
    expect(d.visual?.displayMode).toBe('shortcut');
    expect(d.visual?.layout).toBe('horizontal');
    expect(linkPlugin.frameFor!(d)).toBe('bare');
    expect(linkPlugin.defaultSize).toEqual(LINK_SIZES.horizontal);
  });

  it('visual inválido volta a padrões seguros; campos desconhecidos são descartados', () => {
    const v = sanitizeVisual({ displayMode: 'x', layout: 'grid', label: 'a'.repeat(500) + '\n', iconMode: 'remote', iconId: '../evil', assetId: 'javascript:alert(1)', fit: 'stretch', showLabel: 0, extra: 1, remoteImageConsent: { at: 'ontem' } })!;
    expect(v).toEqual({ version: 1, displayMode: 'shortcut', layout: 'horizontal', label: 'a'.repeat(120), iconMode: 'local', iconId: '', assetId: '', fit: 'cover', showLabel: true, showExternal: true });
    expect(sanitizeVisual(null)).toBeUndefined();
    expect(sanitizeVisual('shortcut')).toBeUndefined();
    expect(sanitizeVisual([])).toBeUndefined();
    expect(sanitizeVisual({ assetId: 'a_abc123', iconId: 'youtube', label: 'x\u0000y' })).toMatchObject({ assetId: 'a_abc123', iconId: 'youtube', label: 'x y' });
    expect(sanitizeVisual({ remoteImageConsent: { at: 7, src: 'https://cdn.x.com/a.png' } })?.remoteImageConsent).toEqual({ at: 7, src: 'https://cdn.x.com/a.png' });
    // formato sem src, src http ou perigoso: nenhum opt-in
    for (const c of [{ at: 7 }, { at: 7, src: 'http://cdn.x.com/a.png' }, { at: 7, src: 'javascript:alert(1)' }, { at: 7, src: 42 }]) expect(sanitizeVisual({ remoteImageConsent: c })?.remoteImageConsent).toBeUndefined();
  });

  it('conversão Clássico ⇄ Atalho preserva URL, descrição e pré-visualização (e é reversível)', () => {
    setState({ ...initialEditorState, status: 'ready', boardId: 'b', history: {}, elements: [] });
    const el = createWidget(WIDGET.link, '1.0.0', 'Link', 0, 0, 320, 210, LEGACY);
    addElements([el]);
    setLinkMode(el.id, 'shortcut');
    let cur = getState().elements[0] as WidgetElement;
    expect(sanitizeLink(cur.data)).toMatchObject({ url: LEGACY.url, description: LEGACY.description, preview: LEGACY.preview, visual: { displayMode: 'shortcut' } });
    expect([cur.width, cur.height]).toEqual([LINK_SIZES.horizontal.width, LINK_SIZES.horizontal.height]);
    expect(cur.x + cur.width / 2).toBe(160); // mantém o centro
    setLinkLayout(el.id, 'card');
    cur = getState().elements[0] as WidgetElement;
    expect([cur.width, cur.height]).toEqual([LINK_SIZES.card.width, LINK_SIZES.card.height]);
    setLinkMode(el.id, 'classic');
    cur = getState().elements[0] as WidgetElement;
    expect(sanitizeLink(cur.data)).toMatchObject({ ...LEGACY, visual: { displayMode: 'classic', layout: 'card' } });
    undo(); undo(); undo();
    expect(sanitizeLink((getState().elements[0] as WidgetElement).data)).toEqual(LEGACY);
    redo();
    expect(sanitizeLink((getState().elements[0] as WidgetElement).data).visual?.displayMode).toBe('shortcut');
  });
});

describe('política de URL', () => {
  it('aceita http(s) com host; recusa esquemas perigosos, credenciais e tamanho excessivo', () => {
    expect(linkTargetUrl(' https://studio.youtube.com/ ')).toBe('https://studio.youtube.com/');
    expect(linkTargetUrl('http://exemplo.com')).toBe('http://exemplo.com/');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x', 'file:///C:/x', 'blob:https://a/b', 'about:blank', 'ftp://x.com', 'https://user:pw@x.com', 'https://', '', '   ', 'https://x.com/' + 'a'.repeat(2050)]) {
      expect(linkTargetUrl(bad)).toBeNull();
    }
    expect(linkTargetUrl(42)).toBeNull();
    expect(isInsecureHttp('http://x.com')).toBe(true);
    expect(isInsecureHttp('https://x.com')).toBe(false);
  });

  it('resumo/IA não levam query, fragmento nem credenciais', () => {
    expect(redactUrl('https://ex.com/a/b?token=SEGREDO#frag')).toBe('https://ex.com/a/b (parâmetros omitidos)');
    expect(redactUrl('https://ex.com/')).toBe('https://ex.com/');
    expect(redactUrl('javascript:alert(1)')).toBe('');
    const el = createWidget(WIDGET.link, '1.0.0', 'Painel', 0, 0, 240, 56, { ...LEGACY, visual: defaultVisual({ label: 'Painel' }) });
    const s = summarizeElement(el);
    expect(s).toContain('Painel');
    expect(s).toContain('https://exemplo.com/a');
    expect(s).not.toContain('SEGREDO');
    expect(linkPlugin.compute!(sanitizeLink(el.data), {}, el).url).toBe(LEGACY.url); // porta de dados explícita: URL completa
  });

  it('busca indexa nome exibido, domínio e descrição — nunca a URL completa', () => {
    const el = createWidget(WIDGET.link, '1.0.0', 'Link', 0, 0, 240, 56, { ...LEGACY, visual: defaultVisual({ label: 'Military Fails — YouTube' }) });
    const [doc] = elementDocs(el, 'b', 'w', () => 'Link');
    expect(doc.title).toBe('Military Fails — YouTube');
    expect(doc.body).toContain('exemplo.com');
    expect(doc.body).not.toContain('SEGREDO');
  });
});

describe('nome e site conhecidos (sem rede)', () => {
  it('identifica sites conhecidos pelo domínio; senão usa o domínio', () => {
    expect(initialLabel('https://studio.youtube.com/')).toBe('YouTube Studio');
    expect(knownSite('https://studio.youtube.com/')?.iconId).toBe('youtube-studio');
    expect(initialLabel('https://www.youtube.com/@canal')).toBe('YouTube');
    expect(initialLabel('https://m.youtube.com/')).toBe('YouTube');
    expect(initialLabel('https://www.tiktok.com/@x')).toBe('TikTok');
    expect(initialLabel('https://www.instagram.com/')).toBe('Instagram');
    expect(initialLabel('https://facebook.com/')).toBe('Facebook');
    expect(initialLabel('https://youtube.com.evil.example/')).toBe('youtube.com.evil.example');
    expect(initialLabel('https://www.notion.so/x')).toBe('notion.so');
    expect(initialLabel('nada')).toBe('');
  });

  it('nome exibido: label > título do usuário > site > domínio > “Configurar link”', () => {
    expect(displayLabel('Link', 'https://studio.youtube.com/', { label: ' Meu canal ' })).toBe('Meu canal');
    expect(displayLabel('Referências', 'https://x.org/', { label: '' })).toBe('Referências');
    expect(displayLabel('Link', 'https://studio.youtube.com/', { label: '' })).toBe('YouTube Studio');
    expect(displayLabel('Atalho', '', undefined)).toBe('Configurar link');
    expect(displayLabel(undefined, '', undefined)).toBe('Configurar link');
  });

  it('título do bloco só acompanha o nome quando ainda era automático', () => {
    expect(titleFollowingLabel('Link', 'YouTube Studio', 'Military Fails')).toBe('Military Fails');
    expect(titleFollowingLabel('YouTube Studio', 'YouTube Studio', 'Military Fails')).toBe('Military Fails');
    expect(titleFollowingLabel('Meu título', 'YouTube Studio', 'Military Fails')).toBeNull();
    expect(titleFollowingLabel('Link', 'x', '  ')).toBeNull();
    // limpar o nome que o título acompanhava devolve o nome automático (revisão do PR #23)
    expect(titleFollowingLabel('Meu canal', 'Meu canal', '')).toBe('Link');
    expect(displayLabel('Link', 'https://studio.youtube.com/', { label: '' })).toBe('YouTube Studio');
    expect(titleFollowingLabel('Meu título', 'Meu canal', '')).toBeNull(); // título independente fica
    // nome com mais de 80 caracteres: o título (cortado) continua acompanhando renomear e limpar
    const longo = 'Canal de referências '.repeat(5).trim(); // > 80
    const t1 = titleFollowingLabel('Link', 'YouTube', longo)!;
    expect(t1.length).toBeLessThanOrEqual(80);
    expect(titleFollowingLabel(t1, longo, 'Curto')).toBe('Curto');
    expect(titleFollowingLabel(t1, longo, '')).toBe('Link');
    // título personalizado com nome vazio (ex.: link clássico convertido) não é sobrescrito ao dar um nome
    expect(followedName('https://exemplo.org/', { label: '' })).toBe('exemplo.org');
    expect(titleFollowingLabel('Referências do projeto', followedName('https://exemplo.org/', { label: '' }), 'Docs')).toBeNull();
    expect(titleFollowingLabel('exemplo.org', followedName('https://exemplo.org/', { label: '' }), 'Docs')).toBe('Docs');
    expect(titleFollowingLabel('YouTube Studio', followedName('https://studio.youtube.com/', { label: 'YouTube Studio' }), '')).toBe('Link');
  });
});

describe('privacidade de imagem remota e backups', () => {
  it('importar remove o opt-in de imagem remota e conta a imagem enviada como asset do backup', () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Q');
    const v = { ...defaultVisual({ iconMode: 'preview', assetId: 'a_img1' }), remoteImageConsent: { at: 1, src: LEGACY.preview.image } };
    const el = createWidget(WIDGET.link, '1.0.0', 'Ref', 0, 0, 240, 56, { ...LEGACY, visual: v });
    board.elements = [el];
    expect(assetIdsOf(board.elements).has('a_img1')).toBe(true);
    const asset = { id: 'a_img1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', name: 'x.png', size: 3, createdAt: 1 };
    const parsed = parseImport(buildExport([board], [asset], ws), ws.id);
    expect(parsed.warnings).toEqual([]);
    const data = sanitizeLink((parsed.boards[0].elements[0] as WidgetElement).data);
    expect(data.visual).toMatchObject({ iconMode: 'preview', assetId: 'a_img1', label: '' });
    expect(data.visual?.remoteImageConsent).toBeUndefined();
    expect(data.url).toBe(LEGACY.url);
    expect(data.preview).toEqual(LEGACY.preview);
  });

  it('backup sem o asset da imagem avisa (sem quebrar)', () => {
    const ws = createWorkspace('W');
    const board = createBoard(ws.id, 'Q');
    board.elements = [createWidget(WIDGET.link, '1.0.0', 'Ref', 0, 0, 240, 56, { url: 'https://x.com', visual: defaultVisual({ iconMode: 'uploaded', assetId: 'a_sumiu' }) })];
    const parsed = parseImport(buildExport([board], [], ws), ws.id);
    expect(parsed.warnings.join(' ')).toContain('a_sumiu');
  });

  it('opt-in vale só para a imagem exata autorizada (trocar URL/pré-visualização por qualquer caminho invalida)', () => {
    const v = sanitizeVisual({ ...defaultVisual({ iconMode: 'preview' }), remoteImageConsent: { at: 1, src: 'https://cdn.a.com/og.png' } });
    expect(remoteImageAllowed(v, 'https://cdn.a.com/og.png')).toBe('https://cdn.a.com/og.png');
    expect(remoteImageAllowed(v, 'https://cdn.b.com/og.png')).toBeNull(); // outro host (ex.: URL trocada no modo Clássico)
    expect(remoteImageAllowed(v, 'https://cdn.a.com/outra.png')).toBeNull(); // pré-visualização atualizada
    expect(remoteImageAllowed(v, 'http://cdn.a.com/og.png')).toBeNull();
    expect(remoteImageAllowed(defaultVisual(), 'https://cdn.a.com/og.png')).toBeNull();
    expect(remoteImageAllowed(undefined, 'https://cdn.a.com/og.png')).toBeNull();
  });

  it('revokeRemoteImageConsent só toca atalhos com opt-in', () => {
    const els = [
      { type: 'widget', widgetType: WIDGET.link, data: { url: 'x', visual: { ...defaultVisual(), remoteImageConsent: { at: 1, src: 'https://a.com/i.png' } } } },
      { type: 'widget', widgetType: WIDGET.link, data: { url: 'y' } },
      { type: 'widget', widgetType: WIDGET.notes, data: { visual: { remoteImageConsent: { at: 1 } } } },
    ];
    expect(revokeRemoteImageConsent(els)).toBe(1);
    expect((els[0].data as { visual: object }).visual).not.toHaveProperty('remoteImageConsent');
    expect((els[2].data as { visual: object }).visual).toHaveProperty('remoteImageConsent');
  });

  it('duplicar mantém nome, modo, layout e referência da imagem', () => {
    const el = createWidget(WIDGET.link, '1.0.0', 'Ref', 0, 0, 220, 200, { url: 'https://x.com', visual: defaultVisual({ layout: 'card', label: 'Capa', iconMode: 'uploaded', assetId: 'a_cap' }) });
    const [copy] = cloneElements([el], { x: 10, y: 10 });
    expect(copy.id).not.toBe(el.id);
    expect(sanitizeLink((copy as WidgetElement).data).visual).toMatchObject({ layout: 'card', label: 'Capa', assetId: 'a_cap', displayMode: 'shortcut' });
  });
});

describe('ícones locais', () => {
  it('marcas: arquivos limpos (sem script, foreignObject, on*, href externos) e com um único path', () => {
    const dir = 'src/assets/link-icons';
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.svg'))) {
      const svg = readFileSync(`${dir}/${f}`, 'utf8');
      expect(svg).not.toMatch(/<script|foreignObject|\son[a-z]+=|href=|xlink:/i);
      expect(svg.match(/<path/g)?.length).toBe(1);
    }
    expect(Object.keys(LINK_BRAND_SOURCES).sort()).toEqual(['facebook', 'github', 'instagram', 'tiktok', 'whatsapp', 'x', 'youtube', 'youtube-studio']);
  });

  it('todo ícone do catálogo gera SVG local com geometria e sem rede', () => {
    for (const ic of LINK_ICONS) {
      const svg = linkIconSVG(ic.id);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toMatch(/<(path|circle|rect|line|polyline)/);
      // A única URL permitida é o namespace do SVG (nada hospedado fora).
      expect(svg.match(/https?:\/\/[^\s"'<>]+/g)).toEqual(['http://www.w3.org/2000/svg']);
      if (ic.kind === 'brand') expect(svg).toContain('<path fill="#ffffff" d="M');
    }
    expect(linkIconSVG('nao-existe')).toBe(linkIconSVG('globe'));
    expect(linkIconSVG('link', '"><script>')).not.toContain('<script>');
  });
});

describe('layouts', () => {
  const sizes = [[240, 56], [80, 30], [600, 120], [96, 104], [72, 72], [220, 200], [40, 300], [1, 1]];
  it('mídia e nome ficam dentro do bloco em qualquer tamanho; nome some quando não cabe', () => {
    for (const layout of ['horizontal', 'compact', 'card'] as const) {
      for (const showLabel of [true, false]) {
        for (const [w, h] of sizes) {
          const l = shortcutLayout({ layout, showLabel, showExternal: true }, w, h);
          const inside = (b: { x: number; y: number; w: number; h: number }) => b.x >= -0.01 && b.y >= -0.01 && b.x + b.w <= w + 0.01 && b.y + b.h <= h + 0.01;
          expect(inside(l.media)).toBe(true);
          if (l.label) expect(inside(l.label)).toBe(true);
          if (l.external) expect(inside(l.external)).toBe(true);
          if (layout === 'compact' && !showLabel) expect(l.label).toBeNull();
          if (layout !== 'card') expect(l.media.w).toBeCloseTo(l.media.h); // ícone nunca distorce
        }
      }
    }
    expect(shortcutLayout({ layout: 'horizontal', showLabel: true, showExternal: true }, 30, 30).label).toBeNull();
  });

  it('tamanhos de referência por modo/layout', () => {
    expect(referenceSize(undefined)).toEqual(LINK_SIZES.classic);
    expect(referenceSize(defaultVisual({ layout: 'compact', showLabel: false }))).toEqual(LINK_SIZES.compactIconOnly);
    expect(fitLabel('Military Fails — YouTube', 60, 14).endsWith('…')).toBe(true);
    expect(fitLabel('Curto', 200, 14)).toBe('Curto');
  });

  it('faixa da borda só seleciona; o centro é clicável (inclusive em blocos pequenos)', () => {
    expect(insideClickZone({ x: 120, y: 28 }, 240, 56, 1)).toBe(true);
    expect(insideClickZone({ x: 3, y: 28 }, 240, 56, 1)).toBe(false);
    expect(insideClickZone({ x: 120, y: 54 }, 240, 56, 1)).toBe(false);
    expect(insideClickZone({ x: 12, y: 12 }, 24, 24, 0.1)).toBe(true); // zoom baixo: faixa limitada a 25%
  });
});

describe('exportação SVG', () => {
  it('atalho exporta fundo, ícone local e nome escapado; imagem remota nunca entra', async () => {
    const el = createWidget(WIDGET.link, '1.0.0', 'Link', 0, 0, 240, 56, { ...LEGACY, visual: { ...defaultVisual({ label: '<b>A&B</b>', iconMode: 'preview' }), remoteImageConsent: { at: 1, src: LEGACY.preview.image } } }) as WidgetElement;
    const svg = await shortcutSVG(sanitizeLink(el.data), el);
    expect(svg).toContain('&lt;b&gt;A&amp;B&lt;/b&gt;');
    expect(svg).toContain('data:image/svg+xml');
    expect(svg).not.toContain('cdn.exemplo.com');
    expect(svg).not.toContain('SEGREDO');
    expect(linkPlugin.exportSVG!(sanitizeLink(LEGACY), el)).toBeNull(); // clássico: resumo genérico
  });
});

describe('gesto de clique no canvas', () => {
  const ptr = (x: number, y: number, extra: Partial<PointerInfo> = {}): PointerInfo => ({
    screen: worldToScreen({ x, y }), world: { x, y }, button: 0, shift: false, alt: false, ctrl: false, pointerType: 'mouse', pointerId: 1, pressure: 0.5, ...extra,
  });
  let open: ReturnType<typeof vi.fn>;
  let shortcut: WidgetElement;

  beforeEach(() => {
    setState({
      ...initialEditorState,
      status: 'ready',
      boardId: 'b',
      history: {},
      elements: [],
      tool: 'select',
      viewport: { width: 1600, height: 1000 },
      camera: { x: 800, y: 500, zoom: 1 },
      boards: [{ id: 'b', workspaceId: 'w', name: 'B', description: '', createdAt: 0, updatedAt: 0, archived: false, schemaVersion: 3, camera: { x: 0, y: 0, zoom: 1 }, settings: { grid: false, gridSize: 20, snapToGrid: false, snapToObjects: false, wheelMode: 'zoom' } }],
    });
    open = vi.fn();
    (globalThis.window as unknown as { open: unknown }).open = open;
    shortcut = createWidget(WIDGET.link, '1.0.0', 'YouTube Studio', 100, 100, 240, 56, { url: 'https://studio.youtube.com/', visual: defaultVisual({ label: 'YouTube Studio' }) }) as WidgetElement;
    addElements([shortcut]);
    setState({ selectedIds: [] });
  });

  const click = (x: number, y: number, extra: Partial<PointerInfo> = {}) => { pointerDown(ptr(x, y, extra)); pointerUp(ptr(x, y, extra)); };

  it('clique consciente abre UMA aba com noopener,noreferrer', () => {
    click(220, 128);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://studio.youtube.com/', '_blank', 'noopener,noreferrer');
    click(220, 128); // segundo clique do duplo clique
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('arrastar, Shift+clique, borda, toque longo e botão direito não abrem', () => {
    pointerDown(ptr(220, 128));
    pointerMove(ptr(226, 131));
    pointerUp(ptr(226, 131));
    expect(getState().elements[0].x).toBe(106);
    click(220, 128, { shift: true });
    click(102, 128); // faixa da borda
    click(220, 128, { button: 2 });
    const now = performance.now();
    const spy = vi.spyOn(performance, 'now');
    spy.mockReturnValueOnce(now);
    pointerDown(ptr(220, 128));
    spy.mockReturnValue(now + LONG_PRESS_MS + 50);
    pointerUp(ptr(220, 128));
    spy.mockRestore();
    expect(open).not.toHaveBeenCalled();
    expect(getState().selectedIds).toEqual([shortcut.id]);
  });

  it('link inválido ou vazio não abre nada (nem about:blank) e leva às Propriedades', () => {
    for (const url of ['javascript:alert(1)', '']) {
      setState({ elements: [{ ...shortcut, id: 'x', data: { url, visual: defaultVisual() } } as WidgetElement] });
      expect(openLinkElement('x')).toBe(false);
      expect(getState().propertiesOpen).toBe(true);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('link clássico não vira clicável; outras ferramentas não abrem', () => {
    setState({ elements: [{ ...shortcut, data: LEGACY } as WidgetElement] });
    expect(clickableWidgetAt(getState().elements[0], ptr(220, 128))).toBeNull();
    setState({ elements: [shortcut], tool: 'hand' });
    click(220, 128);
    expect(open).not.toHaveBeenCalled();
  });

  it('atalho bloqueado continua abrindo (vira um botão fixo)', () => {
    setState({ elements: [{ ...shortcut, locked: true }] });
    click(220, 128);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('arrastar um atalho bloqueado (que não se move) também não abre', () => {
    setState({ elements: [{ ...shortcut, locked: true }] });
    pointerDown(ptr(220, 128));
    pointerMove(ptr(260, 150));
    pointerUp(ptr(260, 150));
    expect(getState().elements[0].x).toBe(100);
    expect(open).not.toHaveBeenCalled();
    // voltar ao ponto de partida antes de soltar continua sendo arrasto
    pointerDown(ptr(220, 128));
    pointerMove(ptr(240, 128));
    pointerMove(ptr(220, 128));
    pointerUp(ptr(220, 128));
    expect(open).not.toHaveBeenCalled();
  });
});

describe('colar URL', () => {
  it('cria atalho horizontal com nome local (sem chamadas de rede)', async () => {
    setState({ ...initialEditorState, status: 'ready', boardId: 'b', history: {}, elements: [], viewport: { width: 1600, height: 1000 }, camera: { x: 0, y: 0, zoom: 1 } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await pasteContent('https://studio.youtube.com/', [], { x: 0, y: 0 });
    await pasteContent('https://www.exemplo.org/painel?id=1', [], { x: 0, y: 200 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const [a, b] = getState().elements as WidgetElement[];
    expect(a.widgetType).toBe(WIDGET.link);
    expect(a.title).toBe('YouTube Studio');
    expect([a.width, a.height]).toEqual([LINK_SIZES.horizontal.width, LINK_SIZES.horizontal.height]);
    expect(sanitizeLink(a.data)).toMatchObject({ url: 'https://studio.youtube.com/', visual: { displayMode: 'shortcut', layout: 'horizontal', label: 'YouTube Studio' } });
    expect(sanitizeLink(b.data).visual?.label).toBe('exemplo.org');
    expect(getWidget(WIDGET.link)!.frameFor!(sanitizeLink(a.data))).toBe('bare');
  });
});
