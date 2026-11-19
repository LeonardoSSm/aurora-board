/**
 * AI Tiles — modelo, presets, validação e layout compartilhado entre tela e exportação.
 * Puro (sem React/DOM): a resolução das logos para URLs fica em widgets/builtin/aiTileLogos.ts.
 */
import { measureLine, wrapText } from './text';

export const AI_PROVIDER_IDS = ['chatgpt', 'codex', 'claude', 'claude-code', 'gemini', 'grok'] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Provedor de API usado por um bloco “Assistente IA” vinculado (null = sem integração nesta versão). */
export type AIApiProvider = 'openai' | 'anthropic' | 'gemini';

export interface AIProviderPreset {
  id: AIProviderId;
  name: string;
  company: string;
  productType: string;
  description: string;
  defaultUrl: string;
  accent: string;
  /** Fundo do modo “marca” (cor de fundo do ícone do aplicativo). */
  brandBackground: string;
  /** Chave da logo colorida original; null quando a marca é monocromática. */
  logoColor: string | null;
  /** Chave da logo monocromática (`currentColor`). */
  logoMono: string;
  apiProvider: AIApiProvider | null;
  keywords: string[];
}

export const AI_PRESETS: Record<AIProviderId, AIProviderPreset> = {
  chatgpt: {
    id: 'chatgpt', name: 'ChatGPT', company: 'OpenAI', productType: 'Assistente conversacional', description: 'Assistente conversacional da OpenAI.',
    defaultUrl: 'https://chatgpt.com/', accent: '#10a37f', brandBackground: '#ffffff', logoColor: null, logoMono: 'openai', apiProvider: 'openai', keywords: ['openai', 'gpt'],
  },
  codex: {
    id: 'codex', name: 'Codex', company: 'OpenAI', productType: 'Agente de programação', description: 'Agente de programação da OpenAI.',
    defaultUrl: 'https://chatgpt.com/codex', accent: '#7a9dff', brandBackground: '#ffffff', logoColor: 'codex-color', logoMono: 'codex', apiProvider: 'openai', keywords: ['openai', 'código', 'agente'],
  },
  claude: {
    id: 'claude', name: 'Claude', company: 'Anthropic', productType: 'Assistente conversacional', description: 'Assistente conversacional da Anthropic.',
    defaultUrl: 'https://claude.ai/', accent: '#d97757', brandBackground: '#f4f3ee', logoColor: 'claude-color', logoMono: 'claude', apiProvider: 'anthropic', keywords: ['anthropic'],
  },
  'claude-code': {
    id: 'claude-code', name: 'Claude Code', company: 'Anthropic', productType: 'Agente de programação', description: 'Agente de programação da Anthropic no terminal e no editor.',
    defaultUrl: 'https://code.claude.com/', accent: '#d97757', brandBackground: '#141413', logoColor: 'claudecode-color', logoMono: 'claudecode', apiProvider: 'anthropic', keywords: ['anthropic', 'terminal', 'código', 'agente'],
  },
  gemini: {
    id: 'gemini', name: 'Gemini', company: 'Google', productType: 'Assistente conversacional', description: 'Assistente de IA do Google.',
    defaultUrl: 'https://gemini.google.com/', accent: '#3186ff', brandBackground: '#ffffff', logoColor: 'gemini-color', logoMono: 'gemini', apiProvider: 'gemini', keywords: ['google', 'bard'],
  },
  grok: {
    id: 'grok', name: 'Grok', company: 'xAI', productType: 'Assistente conversacional', description: 'Assistente conversacional da xAI.',
    defaultUrl: 'https://grok.com/', accent: '#c8ced8', brandBackground: '#000000', logoColor: null, logoMono: 'grok', apiProvider: null, keywords: ['xai', 'x'],
  },
};

export function getPreset(id: string): AIProviderPreset | null {
  return (AI_PROVIDER_IDS as readonly string[]).includes(id) ? AI_PRESETS[id as AIProviderId] : null;
}

export type AITileDisplayMode = 'compact' | 'normal' | 'detailed';
export type AITileBackground = 'dark' | 'transparent' | 'brand';

export interface AITileData {
  /** Preset representado. Valores desconhecidos são preservados (versões futuras) e exibidos com fallback neutro. */
  providerId: string;
  description: string;
  displayMode: AITileDisplayMode;
  showLabel: boolean;
  showDescription: boolean;
  /** '' = cor do preset. */
  accentColor: string;
  accentBorder: boolean;
  backgroundStyle: AITileBackground;
  /** Arredondamento em % do menor lado (0–50). */
  radius: number;
  /** Fração da área disponível ocupada pela logo (0,3–1). */
  logoScale: number;
  logoVariant: 'color' | 'mono';
  /** Somente https; '' = sem link. */
  externalUrl: string;
  /** Id de um bloco “Assistente IA” do mesmo quadro; '' = sem vínculo. */
  linkedWidgetId: string;
}

export const DISPLAY_SIZES: Record<AITileDisplayMode, { width: number; height: number }> = {
  compact: { width: 64, height: 64 },
  normal: { width: 104, height: 112 },
  detailed: { width: 200, height: 150 },
};

export const DISPLAY_MODES: AITileDisplayMode[] = ['compact', 'normal', 'detailed'];
export const DISPLAY_MODE_LABEL: Record<AITileDisplayMode, string> = { compact: 'Compacto', normal: 'Normal', detailed: 'Detalhado' };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** Aceita somente URLs https absolutas, sem credenciais embutidas. Qualquer outra coisa vira ''. */
export function safeExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.length > 2048) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return '';
  return u.href;
}

export function createAITileData(providerId: string = 'chatgpt'): AITileData {
  const p = getPreset(providerId);
  return {
    providerId,
    description: '',
    displayMode: 'normal',
    showLabel: true,
    showDescription: true,
    accentColor: '',
    accentBorder: false,
    backgroundStyle: 'dark',
    radius: 22,
    logoScale: 0.62,
    logoVariant: 'color',
    externalUrl: p?.defaultUrl ?? '',
    linkedWidgetId: '',
  };
}

export function sanitizeAITile(raw: unknown): AITileData {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const providerId = typeof d.providerId === 'string' && /^[a-z0-9-]{1,40}$/.test(d.providerId) ? d.providerId : 'chatgpt';
  const base = createAITileData(providerId);
  return {
    providerId,
    description: typeof d.description === 'string' ? d.description.slice(0, 500) : '',
    displayMode: oneOf(d.displayMode, DISPLAY_MODES, base.displayMode),
    showLabel: typeof d.showLabel === 'boolean' ? d.showLabel : base.showLabel,
    showDescription: typeof d.showDescription === 'boolean' ? d.showDescription : base.showDescription,
    accentColor: typeof d.accentColor === 'string' && HEX.test(d.accentColor) ? d.accentColor.toLowerCase() : '',
    accentBorder: d.accentBorder === true,
    backgroundStyle: oneOf(d.backgroundStyle, ['dark', 'transparent', 'brand'] as const, base.backgroundStyle),
    radius: num(d.radius, base.radius, 0, 50),
    logoScale: num(d.logoScale, base.logoScale, 0.3, 1),
    logoVariant: oneOf(d.logoVariant, ['color', 'mono'] as const, base.logoVariant),
    // Campo ausente (dados antigos/importados) → link padrão do preset; '' explícito = usuário removeu o link.
    externalUrl: d.externalUrl === undefined ? base.externalUrl : safeExternalUrl(d.externalUrl),
    linkedWidgetId: typeof d.linkedWidgetId === 'string' ? d.linkedWidgetId.slice(0, 100) : '',
  };
}

/* ------------------------------------------------------------------ */
/* Integração (estado calculado, nunca gravado)                        */
/* ------------------------------------------------------------------ */

export type IntegrationState = 'visual' | 'configured' | 'not-configured' | 'link-missing';

export interface LinkedAssistantInfo {
  /** Provedor gravado no bloco de IA vinculado ('' = automático). */
  provider: string;
}

/**
 * - visual: sem vínculo (padrão; não exige nada);
 * - link-missing: vínculo aponta para bloco que não existe neste quadro;
 * - configured: bloco vinculado usa o provedor de API do tile e a chave existe no servidor;
 * - not-configured: vinculado, mas servidor offline, chave ausente ou provedor diferente.
 */
export function integrationState(data: AITileData, linked: LinkedAssistantInfo | null | undefined, configuredProviders: ReadonlySet<string> | null): IntegrationState {
  if (!data.linkedWidgetId) return 'visual';
  if (!linked) return 'link-missing';
  const api = getPreset(data.providerId)?.apiProvider;
  if (!api || linked.provider !== api) return 'not-configured';
  return configuredProviders?.has(api) ? 'configured' : 'not-configured';
}

export const INTEGRATION_LABEL: Record<IntegrationState, string> = {
  visual: 'Visual',
  configured: 'API configurada',
  'not-configured': 'API não configurada',
  'link-missing': 'Vínculo ausente',
};

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export type TileNode =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number; fill: string; fillOpacity?: number; stroke?: string; strokeWidth?: number }
  | { kind: 'logo'; x: number; y: number; w: number; h: number; logo: string; tone: string | null }
  | { kind: 'text'; x: number; y: number; text: string; size: number; weight: number; color: string; anchor: 'start' | 'middle' }
  | { kind: 'dot'; x: number; y: number; r: number; fill: string };

export const TILE_FONT = '"Inter Variable", "Inter", system-ui, sans-serif';
const DARK_BG = '#131d2c';
const DARK_BORDER = '#2e405a';

function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ellipsize(text: string, size: number, weight: number, maxWidth: number): string {
  const style = { fontFamily: 'sans' as const, fontSize: size * (weight >= 600 ? 1.04 : 1) };
  if (measureLine(text, style) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && measureLine(t + '…', style) > maxWidth) t = t.slice(0, -1);
  return t.length ? t.trimEnd() + '…' : '';
}

export function tileAccent(data: AITileData): string {
  return data.accentColor || getPreset(data.providerId)?.accent || '#8fa6c8';
}

export function tileName(title: string, data: AITileData): string {
  return (typeof title === 'string' ? title.trim() : '') || getPreset(data.providerId)?.name || data.providerId;
}

/**
 * Descreve o tile como primitivas (retângulos, logo, textos). A tela (React/SVG) e a exportação (string SVG)
 * desenham exatamente esta lista.
 */
export function aiTileLayout(data: AITileData, width: number, height: number, title: string, integration: IntegrationState = 'visual'): TileNode[] {
  const w = Math.max(1, width), h = Math.max(1, height), s = Math.min(w, h);
  const preset = getPreset(data.providerId);
  const accent = tileAccent(data);
  const nodes: TileNode[] = [];
  const rx = (s * data.radius) / 100;

  const bg = data.backgroundStyle === 'brand' ? preset?.brandBackground ?? DARK_BG : data.backgroundStyle === 'dark' ? DARK_BG : null;
  const lightBg = bg ? luminance(bg) > 0.5 : false;
  const fg = lightBg ? '#141413' : '#edf3fc';
  const muted = lightBg ? '#5d6470' : '#8ea3bf';
  const stroke = data.accentBorder ? accent : bg && data.backgroundStyle === 'dark' ? DARK_BORDER : undefined;
  nodes.push({ kind: 'rect', x: 0.5, y: 0.5, w: w - 1, h: h - 1, rx, fill: bg ?? 'none', stroke, strokeWidth: data.accentBorder ? 1.5 : 1 });

  // Logo: original colorida quando existe; senão monocromática em branco/preto conforme o fundo.
  const logoKey = preset ? (data.logoVariant === 'color' && preset.logoColor ? preset.logoColor : preset.logoMono) : null;
  const tone = logoKey && logoKey === preset?.logoMono ? (lightBg ? '#000000' : '#ffffff') : null;
  const name = tileName(title, data);
  const pushLogo = (cx: number, cy: number, size: number) => {
    if (logoKey) nodes.push({ kind: 'logo', x: cx - size / 2, y: cy - size / 2, w: size, h: size, logo: logoKey, tone });
    else {
      // Preset desconhecido: iniciais em fonte comum (nunca um símbolo que pareça logo).
      const initials = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase() || '?';
      nodes.push({ kind: 'rect', x: cx - size / 2, y: cy - size / 2, w: size, h: size, rx: size * 0.22, fill: 'none', stroke: muted, strokeWidth: 1 });
      nodes.push({ kind: 'text', x: cx, y: cy + size * 0.14, text: initials, size: size * 0.38, weight: 600, color: muted, anchor: 'middle' });
    }
  };

  const pad = clamp(s * 0.1, 3, 16);
  const dot = (state: IntegrationState) => {
    if (state === 'visual') return;
    const r = clamp(s * 0.04, 2.5, 5);
    nodes.push({ kind: 'dot', x: w - pad * 0.6 - r, y: pad * 0.6 + r, r, fill: state === 'configured' ? '#5addaa' : '#f3c577' });
  };

  if (data.displayMode === 'compact') {
    pushLogo(w / 2, h / 2, s * data.logoScale);
    dot(integration);
    return nodes;
  }

  if (data.displayMode === 'normal') {
    const labelSize = clamp(h * 0.12, 8, 22);
    const labelArea = data.showLabel ? labelSize * 1.7 : 0;
    const boxW = w - pad * 2, boxH = h - pad * 2 - labelArea;
    const size = Math.max(4, Math.min(boxW, boxH) * Math.min(1, data.logoScale * 1.25));
    pushLogo(w / 2, pad + boxH / 2, size);
    if (data.showLabel) {
      const text = ellipsize(name, labelSize, 600, w - pad * 2);
      if (text) nodes.push({ kind: 'text', x: w / 2, y: h - pad - labelSize * 0.35, text, size: labelSize, weight: 600, color: fg, anchor: 'middle' });
    }
    dot(integration);
    return nodes;
  }

  // Detalhado: logo + nome/empresa no topo, descrição, indicador de integração.
  const logo = clamp(Math.min(h * 0.3, w * 0.3) * (data.logoScale / 0.62), 12, 72);
  pushLogo(pad + logo / 2, pad + logo / 2, logo);
  const tx = pad + logo + pad * 0.8, tw = w - tx - pad;
  const nameSize = clamp(logo * 0.36, 9, 20);
  const companySize = clamp(nameSize * 0.78, 8, 15);
  if (data.showLabel) {
    const n = ellipsize(name, nameSize, 700, tw);
    if (n) nodes.push({ kind: 'text', x: tx, y: pad + logo / 2 - 1, text: n, size: nameSize, weight: 700, color: fg, anchor: 'start' });
  }
  const company = ellipsize(preset?.company ?? 'Assistente de IA', companySize, 400, tw);
  if (company) nodes.push({ kind: 'text', x: tx, y: pad + logo / 2 + companySize * (data.showLabel ? 1.2 : 0.35), text: company, size: companySize, weight: 400, color: muted, anchor: 'start' });

  const badgeSize = clamp(s * 0.075, 8, 12);
  const badgeArea = integration !== 'visual' ? badgeSize * 2.2 : 0;
  const descSize = clamp(s * 0.08, 8, 14);
  const descTop = pad + logo + pad * 0.7;
  if (data.showDescription) {
    const desc = data.description.trim() || preset?.description || '';
    const lh = descSize * 1.35;
    const maxLines = Math.floor((h - descTop - pad - badgeArea) / lh);
    if (desc && maxLines > 0) {
      const lines = wrapText(desc, { fontFamily: 'sans', fontSize: descSize }, w - pad * 2);
      const shown = lines.slice(0, maxLines);
      if (lines.length > maxLines) shown[maxLines - 1] = ellipsize(shown[maxLines - 1] + '…', descSize, 400, w - pad * 2);
      shown.forEach((line, i) => nodes.push({ kind: 'text', x: pad, y: descTop + descSize + i * lh, text: line, size: descSize, weight: 400, color: data.description.trim() ? fg : muted, anchor: 'start' }));
    }
  }
  if (integration !== 'visual') {
    const color = integration === 'configured' ? '#5addaa' : '#f3c577';
    const r = badgeSize * 0.32;
    nodes.push({ kind: 'dot', x: pad + r, y: h - pad - badgeSize * 0.38, r, fill: color });
    nodes.push({ kind: 'text', x: pad + r * 2 + 5, y: h - pad, text: ellipsize(INTEGRATION_LABEL[integration], badgeSize, 500, w - pad * 2 - r * 2 - 5), size: badgeSize, weight: 500, color, anchor: 'start' });
  }
  return nodes;
}
