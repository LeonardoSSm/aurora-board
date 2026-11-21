/**
 * D1-D — estado da janela (posição, tamanho, maximizada) entre aberturas, com suporte a vários monitores.
 * Puro (sem Electron) para ser testado: quem chama passa as áreas de trabalho dos monitores atuais.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState { bounds: Rect; maximized: boolean; fullScreen?: boolean }

export const MIN_SIZE = { width: 720, height: 480 };
const DEFAULT_SIZE = { width: 1440, height: 900 };

function intersect(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Estado salvo (não confiável: arquivo editável) → válido ou null. */
export function sanitizeWindowState(raw: unknown): WindowState | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const b = o?.bounds && typeof o.bounds === 'object' ? (o.bounds as Record<string, unknown>) : null;
  if (!b) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);
  const r = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
  if (Object.values(r).some(Number.isNaN) || r.width < MIN_SIZE.width || r.height < MIN_SIZE.height || r.width > 20_000 || r.height > 20_000) return null;
  return { bounds: r, maximized: o?.maximized === true, ...(o?.fullScreen === true ? { fullScreen: true } : {}) };
}

/**
 * Onde abrir: o estado salvo, se pelo menos um pedaço útil (título incluído) ainda estiver visível em algum monitor;
 * senão (monitor desconectado, resolução menor), centralizado no monitor principal. Primeira abertura em tela
 * pequena (≤ 1440×900 úteis) já abre maximizada.
 */
export function resolveWindowState(saved: WindowState | null, displays: Rect[], primary: Rect): WindowState {
  if (saved) {
    const titleBar: Rect = { x: saved.bounds.x, y: saved.bounds.y, width: saved.bounds.width, height: 40 };
    const visible = displays.some((d) => intersect(titleBar, d) >= Math.min(200 * 40, titleBar.width * 40 * 0.25));
    if (visible) {
      const host = displays.reduce((best, d) => (intersect(saved.bounds, d) > intersect(saved.bounds, best) ? d : best), displays[0] ?? primary);
      return { ...saved, bounds: { ...saved.bounds, width: Math.min(saved.bounds.width, host.width), height: Math.min(saved.bounds.height, host.height) } };
    }
  }
  const width = Math.max(MIN_SIZE.width, Math.min(DEFAULT_SIZE.width, primary.width));
  const height = Math.max(MIN_SIZE.height, Math.min(DEFAULT_SIZE.height, primary.height));
  return {
    bounds: { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height },
    maximized: saved ? saved.maximized : primary.width <= DEFAULT_SIZE.width || primary.height <= DEFAULT_SIZE.height,
  };
}
