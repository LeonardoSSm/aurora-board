/**
 * Smart Links (issue #22) — modelo, saneamento, política de URL e layout dos atalhos visuais do widget Link.
 *
 * Um único widget (`aurora.link`) com dois modos: Clássico (campos no bloco, padrão para dados sem `visual`) e
 * Atalho Visual (`[ÍCONE] Nome`, clicável). Tudo aqui é puro (sem DOM/rede): usado pelo widget, pelo controlador
 * do canvas, pela exportação, pela busca, pela importação e pelos testes. Detalhes em docs/SMART_LINKS.md.
 */

export type LinkDisplayMode = 'classic' | 'shortcut';
export type LinkLayout = 'horizontal' | 'compact' | 'card';
/** Fonte da imagem: ícone da biblioteca local, imagem enviada (asset local) ou imagem da pré-visualização (remota, com opt-in). */
export type LinkIconMode = 'local' | 'uploaded' | 'preview';
export type LinkImageFit = 'cover' | 'contain';

export interface LinkVisual {
  version: 1;
  displayMode: LinkDisplayMode;
  layout: LinkLayout;
  /** Nome exibido no atalho. Vazio = nome automático (título do bloco, site conhecido ou domínio). */
  label: string;
  iconMode: LinkIconMode;
  /** Ícone local; vazio = automático pelo domínio (com fallback genérico). */
  iconId: string;
  /** Imagem enviada (asset local do IndexedDB); nunca base64 dentro do quadro. */
  assetId: string;
  fit: LinkImageFit;
  /** Compacto: mostrar o nome abaixo do ícone (false = só o ícone). */
  showLabel: boolean;
  /** Horizontal: indicador discreto de link externo (↗). */
  showExternal: boolean;
  /**
   * Opt-in persistente para exibir a imagem REMOTA da pré-visualização, amarrado à URL EXATA autorizada (`src`):
   * se a pré-visualização mudar de imagem/host por qualquer caminho (modo Clássico, nova pré-visualização), o
   * opt-in deixa de valer. A importação e a colagem externa removem o campo; duplicar no mesmo navegador mantém.
   */
  remoteImageConsent?: { at: number; src: string };
}

export const LINK_LIMITS = { label: 120, url: 2048, iconId: 40 } as const;
export const LINK_LAYOUTS: LinkLayout[] = ['horizontal', 'compact', 'card'];
export const LAYOUT_LABEL: Record<LinkLayout, string> = { horizontal: 'Horizontal', compact: 'Compacto', card: 'Card' };

/** Tamanhos de referência (adotados ao trocar de modo/layout, mantendo o centro). */
export const LINK_SIZES = {
  classic: { width: 320, height: 210 },
  horizontal: { width: 240, height: 56 },
  compact: { width: 96, height: 104 },
  compactIconOnly: { width: 72, height: 72 },
  card: { width: 220, height: 200 },
} as const;

export function referenceSize(v: Pick<LinkVisual, 'displayMode' | 'layout' | 'showLabel'> | undefined) {
  if (!v || v.displayMode === 'classic') return LINK_SIZES.classic;
  if (v.layout === 'compact') return v.showLabel ? LINK_SIZES.compact : LINK_SIZES.compactIconOnly;
  return LINK_SIZES[v.layout];
}

const ASSET_ID = /^a_[A-Za-z0-9_-]{1,64}$/;
const ICON_ID = /^[a-z0-9-]{1,40}$/;

export function defaultVisual(patch: Partial<LinkVisual> = {}): LinkVisual {
  return { version: 1, displayMode: 'shortcut', layout: 'horizontal', label: '', iconMode: 'local', iconId: '', assetId: '', fit: 'cover', showLabel: true, showExternal: true, ...patch };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Saneia `visual`. Ausente/inválido (não-objeto) = undefined → bloco Clássico (dados antigos e backups).
 * Campos desconhecidos são descartados; valores fora do domínio voltam ao padrão seguro.
 */
export function sanitizeVisual(raw: unknown): LinkVisual | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const d = obj(raw);
  const base = defaultVisual();
  const label = typeof d.label === 'string' ? d.label.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LINK_LIMITS.label) : '';
  const iconId = typeof d.iconId === 'string' && ICON_ID.test(d.iconId) ? d.iconId : '';
  const assetId = typeof d.assetId === 'string' && ASSET_ID.test(d.assetId) ? d.assetId : '';
  const c = obj(d.remoteImageConsent);
  const out: LinkVisual = {
    version: 1,
    displayMode: d.displayMode === 'classic' ? 'classic' : d.displayMode === 'shortcut' ? 'shortcut' : base.displayMode,
    layout: d.layout === 'compact' || d.layout === 'card' ? d.layout : 'horizontal',
    label,
    iconMode: d.iconMode === 'uploaded' || d.iconMode === 'preview' ? d.iconMode : 'local',
    iconId,
    assetId,
    fit: d.fit === 'contain' ? 'contain' : 'cover',
    showLabel: d.showLabel !== false,
    showExternal: d.showExternal !== false,
  };
  // Sem `src` válido (inclusive formato antigo) não há opt-in: nunca autoriza imagem “qualquer”.
  const src = typeof c.src === 'string' ? linkTargetUrl(c.src) : null;
  if (typeof c.at === 'number' && Number.isFinite(c.at) && src && src.startsWith('https:')) out.remoteImageConsent = { at: c.at, src };
  return out;
}

export function isShortcut(v: LinkVisual | undefined): v is LinkVisual {
  return !!v && v.displayMode === 'shortcut';
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Destino que o atalho pode abrir: http(s) com host, sem credenciais embutidas e até 2048 caracteres.
 * `javascript:`, `data:`, `file:`, `blob:` etc. são recusados. HTTP é aceito (links clássicos já abriam http),
 * mas o inspetor avisa que a conexão não é criptografada.
 */
export function linkTargetUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > LINK_LIMITS.url) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password) return null;
  return u.href;
}

/** A imagem remota da pré-visualização pode ser exibida? Só a URL exata autorizada, e só https. */
export function remoteImageAllowed(v: Pick<LinkVisual, 'remoteImageConsent'> | undefined, previewImage: unknown): string | null {
  const img = linkTargetUrl(previewImage);
  if (!img || !img.startsWith('https:') || !v?.remoteImageConsent) return null;
  return v.remoteImageConsent.src === img ? img : null;
}

export function isInsecureHttp(raw: unknown): boolean {
  const t = linkTargetUrl(raw);
  return !!t && t.startsWith('http:');
}

export function linkHost(raw: unknown): string {
  const t = linkTargetUrl(raw);
  if (!t) return '';
  return new URL(t).hostname.replace(/^www\./, '');
}

/**
 * Versão segura para contexto automático (IA, exportação de resumo): origem + caminho, SEM query, fragmento
 * nem credenciais — tokens costumam viajar ali. O caminho é limitado a 120 caracteres.
 */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const path = u.pathname.length > 120 ? `${u.pathname.slice(0, 120)}…` : u.pathname;
  return `${u.protocol}//${u.host}${path === '/' ? '/' : path}${u.search || u.hash ? ' (parâmetros omitidos)' : ''}`;
}

/* ------------------------------------------------------------------ */
/* Sites conhecidos (identificação LOCAL — nenhuma consulta de rede)   */
/* ------------------------------------------------------------------ */

export interface KnownSite { name: string; iconId: string }

const KNOWN: { test: (host: string) => boolean; site: KnownSite }[] = [
  { test: (h) => h === 'studio.youtube.com', site: { name: 'YouTube Studio', iconId: 'youtube-studio' } },
  { test: (h) => h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be', site: { name: 'YouTube', iconId: 'youtube' } },
  { test: (h) => h === 'tiktok.com' || h.endsWith('.tiktok.com'), site: { name: 'TikTok', iconId: 'tiktok' } },
  { test: (h) => h === 'instagram.com' || h.endsWith('.instagram.com'), site: { name: 'Instagram', iconId: 'instagram' } },
  { test: (h) => h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.com' || h === 'fb.watch', site: { name: 'Facebook', iconId: 'facebook' } },
  { test: (h) => h === 'x.com' || h === 'twitter.com' || h.endsWith('.twitter.com'), site: { name: 'X', iconId: 'x' } },
  { test: (h) => h === 'github.com' || h.endsWith('.github.com'), site: { name: 'GitHub', iconId: 'github' } },
  { test: (h) => h === 'whatsapp.com' || h.endsWith('.whatsapp.com') || h === 'wa.me', site: { name: 'WhatsApp', iconId: 'whatsapp' } },
];

export function knownSite(raw: unknown): KnownSite | null {
  const t = linkTargetUrl(raw);
  if (!t) return null;
  const host = new URL(t).hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return KNOWN.find((k) => k.test(host))?.site ?? null;
}

/** Nome inicial confiável ao colar/criar: site conhecido ou domínio (sem buscar título na rede). */
export function initialLabel(raw: unknown): string {
  return knownSite(raw)?.name ?? linkHost(raw);
}

/** Ícone local efetivo: o escolhido, ou o do site conhecido, ou o genérico. */
export function autoIconId(v: Pick<LinkVisual, 'iconId'>, url: string): string {
  return v.iconId || knownSite(url)?.iconId || 'globe';
}

/** Títulos padrão do bloco que não contam como “nome dado pelo usuário”. */
const DEFAULT_TITLES = new Set(['', 'Link', 'Atalho', 'Atalho visual', 'Link clássico']);

/**
 * Nome exibido. Política: `visual.label` manda; vazio → título do bloco (se não for o padrão) → site conhecido
 * → domínio → “Configurar link”. O título do bloco só acompanha o nome quando ainda era igual ao nome anterior
 * ou ao padrão (ver `titleFollowingLabel`).
 */
export function displayLabel(title: string | undefined, url: string, v: Pick<LinkVisual, 'label'> | undefined): string {
  const label = v?.label.trim();
  if (label) return label;
  const t = typeof title === 'string' ? title.trim() : '';
  if (t && !DEFAULT_TITLES.has(t)) return t;
  return initialLabel(url) || 'Configurar link';
}

/**
 * Novo título do bloco ao renomear o atalho: acompanha só se o título ainda era automático (padrão ou igual ao
 * nome exibido anterior). Limpar o nome devolve o título padrão, para o nome automático (site/domínio) voltar;
 * um título personalizado à parte nunca é tocado. null = manter o título.
 */
export function titleFollowingLabel(title: string, oldShown: string, nextLabel: string): string | null {
  const t = title.trim();
  const following = DEFAULT_TITLES.has(t) || t === oldShown.trim();
  if (!following) return null;
  const next = nextLabel.trim();
  if (!next) return DEFAULT_TITLES.has(t) ? null : 'Link';
  return next.slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Privacidade de mídia remota                                         */
/* ------------------------------------------------------------------ */

/**
 * Remove o opt-in de imagem remota de atalhos importados/colados de fora (mesma lógica de `blockActiveContent`).
 * Retorna quantos foram alterados.
 */
export function revokeRemoteImageConsent(elements: { type: string; widgetType?: string; data?: unknown }[], linkType = 'aurora.link'): number {
  let n = 0;
  for (const el of elements) {
    if (el.type !== 'widget' || el.widgetType !== linkType) continue;
    const d = obj(el.data);
    const v = obj(d.visual);
    if (!('remoteImageConsent' in v)) continue;
    const { remoteImageConsent: _drop, ...rest } = v;
    el.data = { ...d, visual: rest };
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Layout (compartilhado pela tela e pela exportação SVG)              */
/* ------------------------------------------------------------------ */

export interface ShortcutBox { x: number; y: number; w: number; h: number }
export interface ShortcutLayoutResult {
  /** Área do ícone/imagem (no card: área da capa). */
  media: ShortcutBox;
  /** Raio dos cantos da área de mídia. */
  mediaRadius: number;
  /** Texto do nome; null = não cabe ou desligado. */
  label: (ShortcutBox & { size: number; align: 'left' | 'center' }) | null;
  /** Indicador ↗ (horizontal). */
  external: (ShortcutBox & { size: number }) | null;
  radius: number;
  pad: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function shortcutLayout(v: Pick<LinkVisual, 'layout' | 'showLabel' | 'showExternal'>, width: number, height: number): ShortcutLayoutResult {
  const w = Math.max(1, width), h = Math.max(1, height);
  const radius = clamp(Math.min(w, h) * 0.2, 4, 16);
  if (v.layout === 'compact') {
    const pad = Math.min(clamp(Math.min(w, h) * 0.1, 3, 12), Math.min(w, h) * 0.1);
    const size = clamp(Math.min(w, h) * 0.15, 9, 26);
    // Nome só se sobrar altura para um ícone legível acima dele.
    const withLabel = v.showLabel && h - 2 * pad - size * 1.35 - clamp(size * 0.4, 2, 8) >= Math.min(16, w - 2 * pad);
    const labelH = withLabel ? size * 1.35 : 0;
    const gap = withLabel ? clamp(size * 0.4, 2, 8) : 0;
    const s = Math.max(1, Math.min(w - 2 * pad, h - 2 * pad - labelH - gap));
    const top = (h - (s + gap + labelH)) / 2;
    const media = { x: (w - s) / 2, y: top, w: s, h: s };
    const label = withLabel && w - 2 * pad >= 20 ? { x: pad, y: top + s + gap, w: w - 2 * pad, h: labelH, size, align: 'center' as const } : null;
    return { media, mediaRadius: clamp(s * 0.22, 3, 18), label, external: null, radius, pad };
  }
  if (v.layout === 'card') {
    const size = clamp(Math.min(w * 0.075, h * 0.09), 10, 24);
    const footer = clamp(size * 2.4, 24, Math.max(24, h * 0.45));
    const pad = clamp(size * 0.8, 6, 16);
    const media = { x: 0, y: 0, w, h: Math.max(1, h - footer) };
    const label = w - 2 * pad >= 20 ? { x: pad, y: h - footer, w: w - 2 * pad, h: footer, size, align: 'center' as const } : null;
    return { media, mediaRadius: radius, label, external: null, radius, pad };
  }
  // Horizontal: [ÍCONE] Nome ↗
  const pad = Math.min(clamp(h * 0.16, 4, 14), h * 0.2, w * 0.1);
  const s = Math.max(0, Math.min(h - 2 * pad, w * 0.45, 128));
  const media = { x: pad, y: (h - s) / 2, w: s, h: s };
  const size = clamp(s * 0.46, 10, 44);
  const gap = clamp(s * 0.3, 5, 16);
  const extSize = v.showExternal ? clamp(size * 0.75, 8, 22) : 0;
  const lx = pad + s + gap;
  const lw = w - lx - pad - (extSize ? extSize + gap * 0.6 : 0);
  const label = lw >= 18 ? { x: lx, y: (h - size * 1.4) / 2, w: lw, h: size * 1.4, size, align: 'left' as const } : null;
  const external = extSize && label ? { x: w - pad - extSize, y: (h - extSize) / 2, w: extSize, h: extSize, size: extSize } : null;
  return { media, mediaRadius: clamp(s * 0.24, 3, 18), label, external, radius, pad };
}

/** Corta o nome para caber numa largura (estimativa de fonte proporcional) — usado na exportação SVG. */
export function fitLabel(text: string, width: number, size: number): string {
  const avg = size * 0.56;
  const max = Math.max(1, Math.floor(width / avg));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Faixa da borda (em pixels de TELA) onde o clique só seleciona, sem abrir. Limitada a 25% do menor lado para
 * que atalhos pequenos ainda tenham um centro clicável.
 */
export function insideClickZone(local: { x: number; y: number }, width: number, height: number, zoom: number, edgePx = 8): boolean {
  const e = Math.min(edgePx / Math.max(zoom, 0.01), Math.min(width, height) * 0.25);
  return local.x >= e && local.y >= e && local.x <= width - e && local.y <= height - e;
}
