/**
 * Logos locais dos AI Tiles (procedência em src/assets/ai-logos/README.md).
 * Embutidas no bundle como texto e servidas como data: URL — sem rede, iguais na tela e na exportação.
 */
import openai from '../../assets/ai-logos/openai.svg?raw';
import codex from '../../assets/ai-logos/codex.svg?raw';
import codexColor from '../../assets/ai-logos/codex-color.svg?raw';
import claude from '../../assets/ai-logos/claude.svg?raw';
import claudeColor from '../../assets/ai-logos/claude-color.svg?raw';
import claudecode from '../../assets/ai-logos/claudecode.svg?raw';
import claudecodeColor from '../../assets/ai-logos/claudecode-color.svg?raw';
import gemini from '../../assets/ai-logos/gemini.svg?raw';
import geminiColor from '../../assets/ai-logos/gemini-color.svg?raw';
import grok from '../../assets/ai-logos/grok.svg?raw';

export const AI_LOGO_SOURCES: Record<string, string> = {
  openai,
  codex,
  'codex-color': codexColor,
  claude,
  'claude-color': claudeColor,
  claudecode,
  'claudecode-color': claudecodeColor,
  gemini,
  'gemini-color': geminiColor,
  grok,
};

const cache = new Map<string, string>();

/** data: URL da logo; `tone` (branco/preto) substitui `currentColor` das versões monocromáticas. */
export function logoDataURL(key: string, tone: string | null): string | null {
  const src = AI_LOGO_SOURCES[key];
  if (!src) return null;
  const color = tone && /^#[0-9a-f]{6}$/i.test(tone) ? tone : null;
  const ck = `${key}|${color ?? ''}`;
  let url = cache.get(ck);
  if (!url) {
    const svg = color ? src.replace(/currentColor/g, color) : src;
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    cache.set(ck, url);
  }
  return url;
}
