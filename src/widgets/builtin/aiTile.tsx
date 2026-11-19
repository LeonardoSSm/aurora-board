/**
 * AI Tiles — blocos com a identidade visual de assistentes de IA.
 * Um único widget (`aurora.ai-tile`); ChatGPT, Codex, Claude, Claude Code, Gemini e Grok são presets.
 * Funciona sem nenhuma API; o vínculo com um bloco “Assistente IA” é opcional.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ExternalLink, Link2, Link2Off, Plus } from 'lucide-react';
import type { WidgetElement, AuroraElement } from '../../core/schema';
import type { WidgetPlugin, WidgetPreset } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import {
  AI_PRESETS,
  AI_PROVIDER_IDS,
  DISPLAY_MODES,
  DISPLAY_MODE_LABEL,
  DISPLAY_SIZES,
  INTEGRATION_LABEL,
  TILE_FONT,
  aiTileLayout,
  createAITileData,
  getPreset,
  integrationState,
  safeExternalUrl,
  sanitizeAITile,
  tileAccent,
  tileName,
  type AITileData,
  type AITileDisplayMode,
  type IntegrationState,
  type TileNode,
} from '../../core/aiTiles';
import { createLinear, createWidget } from '../../core/elements';
import { resolveLinear } from '../../core/bindings';
import { getState, useEditor } from '../../store/editor';
import { addElements, focusElement, openExternalUrl, openWidgetInspector, updateElements } from '../../store/actions';
import { toast } from '../../store/ui';
import { fetchAIStatus, type AIStatus } from '../../integrations/aiClient';
import { Button, Field, Label, Segmented, Select, TextArea } from '../../ui/primitives';
import { logoDataURL } from './aiTileLogos';

/* ------------------------------------------------------------------ */
/* Integração                                                          */
/* ------------------------------------------------------------------ */

let statusSnapshot: AIStatus | null = null;

function configuredSet(s: AIStatus | null): Set<string> | null {
  if (!s) return null;
  return s.state === 'ready' ? new Set(s.providers.filter((p) => p.configured).map((p) => p.id)) : new Set();
}

function useConfiguredProviders(enabled: boolean) {
  const [status, setStatus] = useState<AIStatus | null>(statusSnapshot);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchAIStatus().then((s) => { statusSnapshot = s; if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [enabled]);
  return useMemo(() => configuredSet(status), [status]);
}

function linkedInfo(elements: AuroraElement[], id: string) {
  if (!id) return null;
  const el = elements.find((e) => e.id === id);
  if (!el || el.type !== 'widget' || el.widgetType !== WIDGET.ai) return null;
  const d = (el.data ?? {}) as { provider?: unknown };
  return { provider: typeof d.provider === 'string' ? d.provider : '' };
}

function useIntegration(data: AITileData): IntegrationState {
  const provider = useEditor((s) => (data.linkedWidgetId ? linkedInfo(s.elements, data.linkedWidgetId)?.provider ?? null : null));
  const configured = useConfiguredProviders(!!data.linkedWidgetId);
  return integrationState(data, provider === null ? null : { provider }, configured);
}

/* ------------------------------------------------------------------ */
/* Render compartilhado                                                */
/* ------------------------------------------------------------------ */

function NodeView({ n }: { n: TileNode }) {
  switch (n.kind) {
    case 'rect':
      return <rect x={n.x} y={n.y} width={Math.max(0, n.w)} height={Math.max(0, n.h)} rx={n.rx} fill={n.fill} stroke={n.stroke ?? 'none'} strokeWidth={n.strokeWidth} />;
    case 'logo': {
      const href = logoDataURL(n.logo, n.tone);
      return href ? <image data-testid="ai-tile-logo" data-logo={n.logo} href={href} x={n.x} y={n.y} width={n.w} height={n.h} preserveAspectRatio="xMidYMid meet" /> : null;
    }
    case 'text':
      return <text x={n.x} y={n.y} fontSize={n.size} fontWeight={n.weight} fill={n.color} textAnchor={n.anchor} fontFamily={TILE_FONT}>{n.text}</text>;
    case 'dot':
      return <circle cx={n.x} cy={n.y} r={n.r} fill={n.fill} />;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const n2 = (v: number) => Math.round(v * 100) / 100;

/** Serializa o mesmo layout da tela em SVG (exportação). */
export function tileNodesToSVG(nodes: TileNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'rect':
          return `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(Math.max(0, n.w))}" height="${n2(Math.max(0, n.h))}" rx="${n2(n.rx)}" fill="${esc(n.fill)}" stroke="${esc(n.stroke ?? 'none')}"${n.strokeWidth ? ` stroke-width="${n.strokeWidth}"` : ''}/>`;
        case 'logo': {
          const href = logoDataURL(n.logo, n.tone);
          return href ? `<image href="${esc(href)}" x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.w)}" height="${n2(n.h)}" preserveAspectRatio="xMidYMid meet"/>` : '';
        }
        case 'text':
          return `<text x="${n2(n.x)}" y="${n2(n.y)}" font-size="${n2(n.size)}" font-weight="${n.weight}" fill="${esc(n.color)}" text-anchor="${n.anchor === 'middle' ? 'middle' : 'start'}" font-family='${esc(TILE_FONT)}' xml:space="preserve">${esc(n.text)}</text>`;
        case 'dot':
          return `<circle cx="${n2(n.x)}" cy="${n2(n.y)}" r="${n2(n.r)}" fill="${esc(n.fill)}"/>`;
      }
    })
    .join('');
}

function AITileView({ element, data, selected }: { element: WidgetElement; data: AITileData; selected: boolean }) {
  const integration = useIntegration(data);
  const nodes = useMemo(() => aiTileLayout(data, element.width, element.height, element.title, integration), [data, element.width, element.height, element.title, integration]);
  const accent = tileAccent(data);
  const name = tileName(element.title, data);
  const shadow = data.backgroundStyle === 'transparent' ? undefined : selected ? `drop-shadow(0 0 7px ${accent}66)` : 'drop-shadow(0 8px 18px rgba(0,0,0,.38))';
  return (
    <svg
      data-testid="ai-tile"
      data-provider={data.providerId}
      data-mode={data.displayMode}
      data-integration={integration}
      role="img"
      aria-label={`${name}${getPreset(data.providerId) ? ` (${getPreset(data.providerId)!.company})` : ''}`}
      width={Math.max(1, element.width)}
      height={Math.max(1, element.height)}
      viewBox={`0 0 ${Math.max(1, element.width)} ${Math.max(1, element.height)}`}
      className="absolute inset-0 overflow-visible"
      style={{ filter: shadow }}
    >
      {nodes.map((n, i) => <NodeView key={i} n={n} />)}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Ações                                                               */
/* ------------------------------------------------------------------ */

function patchTile(id: string, fn: (d: AITileData, el: WidgetElement) => Partial<AITileData>, extra?: (el: WidgetElement, next: AITileData) => Partial<WidgetElement>, coalesceKey?: string) {
  updateElements(new Set([id]), (el) => {
    if (el.type !== 'widget') return el;
    const cur = sanitizeAITile(el.data);
    const next = sanitizeAITile({ ...cur, ...fn(cur, el) });
    return { ...el, ...(extra ? extra(el, next) : {}), data: next } as AuroraElement;
  }, coalesceKey);
}

/** Troca o modo visual e adota o tamanho de referência do modo (mantendo o centro). */
export function setTileMode(id: string, mode: AITileDisplayMode) {
  patchTile(id, () => ({ displayMode: mode }), (el) => {
    const size = DISPLAY_SIZES[mode];
    return { x: el.x + (el.width - size.width) / 2, y: el.y + (el.height - size.height) / 2, width: size.width, height: size.height };
  });
}

function nextMode(m: AITileDisplayMode): AITileDisplayMode {
  return DISPLAY_MODES[(DISPLAY_MODES.indexOf(m) + 1) % DISPLAY_MODES.length];
}

/** Cria um bloco “Assistente IA” com o provedor de API do tile, conectado por seta e vinculado. */
export function createLinkedAssistant(tileId: string) {
  const s = getState();
  const tile = s.elements.find((e) => e.id === tileId);
  if (!tile || tile.type !== 'widget') return;
  const data = sanitizeAITile(tile.data);
  const api = getPreset(data.providerId)?.apiProvider;
  if (!api) { toast('Este assistente não tem integração funcional nesta versão.', 'info'); return; }
  const name = tileName(tile.title, data);
  const ai = createWidget(WIDGET.ai, '1.0.0', `Assistente · ${name}`, tile.x + tile.width + 120, tile.y, 380, 460, { provider: api, model: '' });
  ai.style.strokeColor = '#b8a0ff';
  const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: '#8fa6c8' }, 'visual');
  arrow.startBinding = { elementId: tile.id, fixedPoint: null };
  arrow.endBinding = { elementId: ai.id, fixedPoint: null };
  const byId = new Map<string, AuroraElement>([...s.elements.map((e) => [e.id, e] as const), [ai.id, ai]]);
  addElements([ai, resolveLinear(arrow, byId)], false);
  patchTile(tileId, () => ({ linkedWidgetId: ai.id }));
  toast(`Bloco de IA criado e vinculado. Ele usa a API ${API_LABEL[api]} (chave no servidor local).`, 'success');
}

export function openLinkedAssistant(tileId: string) {
  const tile = getState().elements.find((e) => e.id === tileId);
  if (!tile || tile.type !== 'widget') return;
  const id = sanitizeAITile(tile.data).linkedWidgetId;
  if (!id || !focusElement(id)) toast('O bloco de IA vinculado não está neste quadro.', 'warning');
}

/* ------------------------------------------------------------------ */
/* Inspetor                                                            */
/* ------------------------------------------------------------------ */

const API_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' } as const;

function Inspector({ element, data }: { element: WidgetElement; data: AITileData }) {
  const id = element.id;
  const preset = getPreset(data.providerId);
  const focus = useEditor((s) => s.inspectorFocus);
  const opacity = element.style.opacity;
  const rootRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLDivElement>(null);
  const [urlDraft, setUrlDraft] = useState(data.externalUrl);
  useEffect(() => setUrlDraft(data.externalUrl), [data.externalUrl, id]);
  const urlValid = !urlDraft.trim() || !!safeExternalUrl(urlDraft);
  const integration = useIntegration(data);
  const elements = useEditor((s) => s.elements);
  const assistants = useMemo(() => elements.filter((e): e is WidgetElement => e.type === 'widget' && e.widgetType === WIDGET.ai), [elements]);

  useEffect(() => {
    if (!focus || focus.id !== id) return;
    const target = focus.section === 'integration' ? linkRef.current : rootRef.current;
    target?.scrollIntoView({ block: 'nearest' });
    if (focus.section !== 'integration') rootRef.current?.querySelector<HTMLElement>('textarea')?.focus();
  }, [focus, id]);

  const set = (p: Partial<AITileData>, key?: string) => patchTile(id, () => p, undefined, key ? `ai-tile:${key}:${id}` : undefined);

  const changeProvider = (next: string) => {
    patchTile(
      id,
      (d) => {
        const old = getPreset(d.providerId), np = getPreset(next);
        return {
          providerId: next,
          // Link padrão acompanha a troca; link personalizado é preservado.
          externalUrl: !d.externalUrl || d.externalUrl === old?.defaultUrl ? np?.defaultUrl ?? '' : d.externalUrl,
          // Vínculo com bloco de IA só vale se o provedor de API continuar o mesmo.
          linkedWidgetId: old?.apiProvider && old.apiProvider === np?.apiProvider ? d.linkedWidgetId : '',
        };
      },
      (el) => {
        const old = getPreset(sanitizeAITile(el.data).providerId);
        return !el.title.trim() || el.title === old?.name ? { title: getPreset(next)?.name ?? el.title } : {};
      },
    );
  };

  const compatible = preset?.apiProvider ? assistants.filter((a) => (a.data as { provider?: string })?.provider === preset.apiProvider) : [];

  return (
    <div ref={rootRef} className="flex flex-col text-[12px]" data-testid="ai-tile-inspector">
      <Label>Assistente representado</Label>
      <Select aria-label="Assistente representado" value={data.providerId} onChange={(e) => changeProvider(e.target.value)} className="w-full">
        {AI_PROVIDER_IDS.map((p) => <option key={p} value={p}>{AI_PRESETS[p].name} — {AI_PRESETS[p].company}</option>)}
        {!preset && <option value={data.providerId}>Desconhecido ({data.providerId})</option>}
      </Select>

      <Label>Descrição / responsabilidade</Label>
      <TextArea
        aria-label="Descrição do tile"
        rows={2}
        maxLength={500}
        value={data.description}
        placeholder={preset?.description ?? 'Ex.: Estratégia, Desenvolvimento, Auditoria'}
        onChange={(e) => set({ description: e.target.value }, 'desc')}
        onKeyDown={(e) => e.stopPropagation()}
      />

      <Label>Modo visual</Label>
      <Segmented<AITileDisplayMode> label="Modo visual" value={data.displayMode} onChange={(m) => setTileMode(id, m)} options={DISPLAY_MODES.map((m) => ({ value: m, label: DISPLAY_MODE_LABEL[m] }))} />
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-fg-2">
        <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={data.showLabel} onChange={(e) => set({ showLabel: e.target.checked })} disabled={data.displayMode === 'compact'} /> Mostrar nome</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={data.showDescription} onChange={(e) => set({ showDescription: e.target.checked })} disabled={data.displayMode !== 'detailed'} /> Mostrar descrição</label>
      </div>

      <Label>Fundo</Label>
      <Segmented label="Fundo" value={data.backgroundStyle} onChange={(v) => set({ backgroundStyle: v })} options={[{ value: 'dark', label: 'Escuro' }, { value: 'transparent', label: 'Transparente' }, { value: 'brand', label: 'Marca', title: 'Cor de fundo do ícone do aplicativo' }]} />

      <Label>Logo</Label>
      <Segmented
        label="Versão da logo"
        value={data.logoVariant}
        onChange={(v) => set({ logoVariant: v })}
        options={[{ value: 'color', label: 'Original' }, { value: 'mono', label: 'Monocromática', title: 'Branca ou preta conforme o fundo' }]}
      />
      <Slider label="Tamanho da logo" value={Math.round(data.logoScale * 100)} min={30} max={100} suffix="%" onChange={(v) => set({ logoScale: v / 100 }, 'logo')} />

      <Label>Cor de destaque</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label="Cor de destaque" value={tileAccent(data)} onChange={(e) => set({ accentColor: e.target.value }, 'accent')} className="w-8 h-8 rounded border border-line bg-transparent" />
        <label className="flex items-center gap-1.5 text-[11px] text-fg-2"><input type="checkbox" className="accent-accent" checked={data.accentBorder} onChange={(e) => set({ accentBorder: e.target.checked })} /> Borda colorida</label>
        {data.accentColor && <button className="text-[11px] text-accent hover:underline ml-auto" onClick={() => set({ accentColor: '' })}>Padrão</button>}
      </div>
      <Slider label="Arredondamento" value={data.radius} min={0} max={50} suffix="%" onChange={(v) => set({ radius: v }, 'radius')} />
      <Slider label="Opacidade" value={opacity} min={10} max={100} suffix="%" onChange={(v) => updateElements(new Set([id]), (el) => ({ ...el, style: { ...el.style, opacity: v } }), `ai-tile:opacity:${id}`)} />

      <Label>Link da ferramenta</Label>
      <div className="flex gap-1.5">
        <Field
          aria-label="Link externo"
          value={urlDraft}
          placeholder="https://"
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => { if (urlValid && urlDraft.trim() !== data.externalUrl) set({ externalUrl: urlDraft.trim() }); }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className={urlValid ? '' : '!border-danger'}
        />
        <Button aria-label="Abrir ferramenta" title="Abrir em nova aba" disabled={!data.externalUrl} onClick={() => openExternalUrl(data.externalUrl)}><ExternalLink size={14} /></Button>
      </div>
      {!urlValid && <div className="text-[11px] text-danger mt-1">Use um endereço https:// válido.</div>}
      {preset && data.externalUrl !== preset.defaultUrl && <button className="self-start text-[11px] text-accent hover:underline mt-1" onClick={() => set({ externalUrl: preset.defaultUrl })}>Restaurar link padrão</button>}

      <div ref={linkRef}>
        <Label>Integração (opcional)</Label>
        {!preset?.apiProvider ? (
          <div className="text-[11px] text-soft leading-relaxed">Sem integração funcional nesta versão. O tile funciona como representação visual.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] text-soft leading-relaxed">
              Vincula este tile a um bloco “Assistente IA” que usa a <b>API {API_LABEL[preset.apiProvider]}</b> (chave no servidor). Assinatura do aplicativo não dá acesso à API.
            </div>
            <div className="text-[11px]" data-testid="ai-tile-integration">
              Estado: <span className={integration === 'configured' ? 'text-ok' : integration === 'visual' ? 'text-muted' : 'text-warn'}>{integration === 'visual' ? 'Somente visual' : INTEGRATION_LABEL[integration]}</span>
            </div>
            <Select aria-label="Bloco de IA vinculado" value={compatible.some((a) => a.id === data.linkedWidgetId) ? data.linkedWidgetId : ''} onChange={(e) => set({ linkedWidgetId: e.target.value })} className="w-full">
              <option value="">{data.linkedWidgetId && !compatible.some((a) => a.id === data.linkedWidgetId) ? 'Vínculo indisponível — escolher…' : 'Sem vínculo'}</option>
              {compatible.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </Select>
            {compatible.length === 0 && <div className="text-[11px] text-soft">Nenhum bloco de IA com provedor {API_LABEL[preset.apiProvider]} neste quadro.</div>}
            <div className="flex flex-wrap gap-1.5">
              <Button onClick={() => createLinkedAssistant(id)}><Plus size={13} /> Criar assistente vinculado</Button>
              {data.linkedWidgetId && <Button onClick={() => openLinkedAssistant(id)}><Bot size={13} /> Abrir</Button>}
              {data.linkedWidgetId && <Button onClick={() => set({ linkedWidgetId: '' })}><Link2Off size={13} /> Remover</Button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5 mt-2 text-[11px] text-fg-2">
      <span className="flex justify-between"><span>{label}</span><span className="text-soft tabular-nums">{value}{suffix}</span></span>
      <input type="range" aria-label={label} min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full min-w-0 accent-accent" />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Plugin e presets                                                    */
/* ------------------------------------------------------------------ */

function logoIcon(providerId: string) {
  const p = AI_PRESETS[providerId as keyof typeof AI_PRESETS];
  const key = p.logoColor ?? p.logoMono;
  const tone = p.logoColor ? null : '#ffffff';
  const Icon = ({ size = 16, className }: { size?: number; className?: string }) => (
    <img src={logoDataURL(key, tone) ?? ''} width={size} height={size} alt="" draggable={false} className={className} style={{ objectFit: 'contain' }} />
  );
  Icon.displayName = `AILogo(${providerId})`;
  return Icon;
}

const presets: WidgetPreset<AITileData>[] = AI_PROVIDER_IDS.map((id) => {
  const p = AI_PRESETS[id];
  return { id, name: p.name, description: `${p.company} · ${p.productType}`, keywords: [p.company, ...p.keywords], icon: logoIcon(id), data: createAITileData(id), size: DISPLAY_SIZES.normal, accent: p.accent };
});

export const aiTilePlugin: WidgetPlugin<AITileData> = {
  id: WIDGET.aiTile,
  name: 'AI Tile',
  description: 'Bloco com a identidade visual de um assistente de IA. Não exige API.',
  icon: Link2,
  version: '1.0.0',
  category: 'IA',
  status: 'ready',
  accent: '#8fa6c8',
  permissions: [],
  defaultSize: DISPLAY_SIZES.normal,
  minSize: { width: 24, height: 24 },
  inputs: [],
  outputs: [],
  frame: 'bare',
  presets,
  librarySection: 'Inteligências Artificiais',
  hideInLibrary: true,
  createData: () => createAITileData('chatgpt'),
  sanitize: sanitizeAITile,
  summarize: (d, el) => {
    const p = getPreset(d.providerId);
    return [`${tileName(el.title, d)}${p ? ` (${p.company})` : ''}`, d.description.trim()].filter(Boolean).join(' — ');
  },
  Component: ({ element, data, selected }) => <AITileView element={element} data={data} selected={selected} />,
  Inspector: ({ element, data }) => <Inspector element={element} data={data} />,
  onDoubleClick: (el) => openWidgetInspector(el.id),
  menuItems: (el, d) => {
    const p = getPreset(d.providerId);
    return [
      { id: 'edit', label: 'Editar tile', run: () => openWidgetInspector(el.id) },
      { id: 'mode', label: `Modo: ${DISPLAY_MODE_LABEL[nextMode(d.displayMode)]}`, run: () => setTileMode(el.id, nextMode(d.displayMode)) },
      { id: 'open-tool', label: 'Abrir ferramenta', disabled: !d.externalUrl, run: () => openExternalUrl(d.externalUrl) },
      ...(d.linkedWidgetId
        ? [
            { id: 'open-assistant', label: 'Abrir assistente', run: () => openLinkedAssistant(el.id) },
            { id: 'unlink', label: 'Remover vínculo', run: () => patchTile(el.id, () => ({ linkedWidgetId: '' })) },
          ]
        : p?.apiProvider
          ? [{ id: 'link', label: 'Vincular assistente…', run: () => openWidgetInspector(el.id, 'integration') }]
          : []),
    ];
  },
  exportSVG: async (d, el) => {
    const status = d.linkedWidgetId ? await fetchAIStatus() : null;
    const integration = integrationState(d, linkedInfo(getState().elements, d.linkedWidgetId), configuredSet(status));
    return tileNodesToSVG(aiTileLayout(d, el.width, el.height, el.title, integration));
  },
  remapIds: (d, idMap) => (d.linkedWidgetId && idMap.has(d.linkedWidgetId) ? { ...d, linkedWidgetId: idMap.get(d.linkedWidgetId)! } : d),
};
