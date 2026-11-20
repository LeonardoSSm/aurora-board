/**
 * Biblioteca LOCAL de ícones dos Smart Links (issue #22). Nada é baixado: as marcas vêm de arquivos do
 * Simple Icons 16.38.0 (CC0) em src/assets/link-icons/ e os genéricos do lucide-react (ISC, linkIconNodes.ts).
 * O mesmo SVG (data: URL) é usado na tela e na exportação. Procedência: src/assets/link-icons/README.md.
 */
import youtube from '../../assets/link-icons/youtube.svg?raw';
import youtubestudio from '../../assets/link-icons/youtubestudio.svg?raw';
import tiktok from '../../assets/link-icons/tiktok.svg?raw';
import instagram from '../../assets/link-icons/instagram.svg?raw';
import facebook from '../../assets/link-icons/facebook.svg?raw';
import x from '../../assets/link-icons/x.svg?raw';
import github from '../../assets/link-icons/github.svg?raw';
import whatsapp from '../../assets/link-icons/whatsapp.svg?raw';
import { LUCIDE_NODES } from './linkIconNodes';

export const LINK_BRAND_SOURCES: Record<string, string> = { youtube, 'youtube-studio': youtubestudio, tiktok, instagram, facebook, x, github, whatsapp };

export interface LinkIconDef { id: string; label: string; kind: 'brand' | 'generic'; color: string; keywords?: string }

/** Cores oficiais declaradas pelo Simple Icons. */
const BRANDS: LinkIconDef[] = [
  { id: 'youtube', label: 'YouTube', kind: 'brand', color: '#FF0000' },
  { id: 'youtube-studio', label: 'YouTube Studio', kind: 'brand', color: '#FF0000' },
  { id: 'tiktok', label: 'TikTok', kind: 'brand', color: '#000000' },
  { id: 'instagram', label: 'Instagram', kind: 'brand', color: '#FF0069' },
  { id: 'facebook', label: 'Facebook', kind: 'brand', color: '#0866FF' },
  { id: 'x', label: 'X (Twitter)', kind: 'brand', color: '#000000' },
  { id: 'github', label: 'GitHub', kind: 'brand', color: '#181717' },
  { id: 'whatsapp', label: 'WhatsApp', kind: 'brand', color: '#25D366' },
];

const GENERIC_LABEL: Record<string, string> = {
  link: 'Link', globe: 'Site', house: 'Início', star: 'Favorito', bookmark: 'Marcador', folder: 'Pasta', 'file-text': 'Documento',
  'book-open': 'Leitura', video: 'Vídeo', film: 'Filme', clapperboard: 'Produção', 'eighth-notes': 'Música', mic: 'Áudio', image: 'Imagem',
  camera: 'Câmera', mail: 'E-mail', 'message-circle': 'Mensagens', calendar: 'Agenda', 'shopping-cart': 'Loja', briefcase: 'Trabalho',
  'chart-column': 'Métricas', code: 'Código', 'pen-tool': 'Design', 'layout-dashboard': 'Painel', rocket: 'Projeto', lightbulb: 'Ideias',
  users: 'Comunidade', newspaper: 'Notícias', sparkles: 'IA', 'graduation-cap': 'Curso',
};

export const LINK_ICON_ACCENT = '#63d7dd';

export const LINK_ICONS: LinkIconDef[] = [
  ...Object.keys(LUCIDE_NODES).map((id) => ({ id, label: GENERIC_LABEL[id] ?? id, kind: 'generic' as const, color: LINK_ICON_ACCENT })),
  ...BRANDS,
];

export function getLinkIcon(id: string): LinkIconDef | null {
  return LINK_ICONS.find((i) => i.id === id) ?? null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HEX = /^#[0-9a-f]{6}$/i;

/** Geometria da marca: só o atributo `d` do único <path> (o arquivo inteiro nunca é injetado). */
function brandPath(id: string): string | null {
  const src = LINK_BRAND_SOURCES[id];
  const m = src?.match(/<path[^>]*\sd="([^"]+)"/);
  return m && /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(m[1]) ? m[1] : null;
}

function genericMarkup(id: string): string | null {
  const nodes = LUCIDE_NODES[id];
  if (!nodes) return null;
  return nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('');
}

/**
 * SVG completo do ícone (48×48): selo arredondado + símbolo. Marca: selo na cor da marca e símbolo branco.
 * Genérico: selo translúcido e traço na cor de destaque.
 */
export function linkIconSVG(id: string, accent = LINK_ICON_ACCENT): string {
  const def = getLinkIcon(id) ?? getLinkIcon('globe')!;
  const color = HEX.test(accent) ? accent : LINK_ICON_ACCENT;
  if (def.kind === 'brand') {
    const d = brandPath(def.id);
    const dark = def.color === '#000000' || def.color === '#181717';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="0.5" y="0.5" width="47" height="47" rx="11" fill="${def.color}"${dark ? ' stroke="#ffffff" stroke-opacity="0.22"' : ''}/>${d ? `<g transform="translate(11 11) scale(1.0833)"><path fill="#ffffff" d="${d}"/></g>` : ''}</svg>`;
  }
  const inner = genericMarkup(def.id) ?? '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="0.5" y="0.5" width="47" height="47" rx="11" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.35"/><g transform="translate(11 11) scale(1.0833)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
}

const cache = new Map<string, string>();
export function linkIconDataURL(id: string, accent = LINK_ICON_ACCENT): string {
  const key = `${id}|${accent}`;
  let url = cache.get(key);
  if (!url) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(linkIconSVG(id, accent))}`;
    if (cache.size > 200) cache.clear();
    cache.set(key, url);
  }
  return url;
}
