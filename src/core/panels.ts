/**
 * Larguras das laterais (issue #10). Preferência LOCAL deste navegador (configurações do IndexedDB, chave
 * `panelWidths`): não pertence a nenhum quadro e não vai em backups.
 *
 * Regras:
 * - padrão: Biblioteca 256 px, Propriedades 288 px; cada uma entre 220 e 650 px;
 * - o canvas mantém pelo menos `MIN_CANVAS` px: se a janela estreitar, as laterais encolhem (sem alterar o
 *   valor salvo, que volta a valer quando houver espaço);
 * - em modo compacto (≤ 899 px) os painéis são sobrepostos e ficam limitados a 85% da janela.
 */
export type PanelSide = 'library' | 'properties';
export interface PanelWidths { library: number; properties: number }

export const PANEL_DEFAULTS: PanelWidths = { library: 256, properties: 288 };
export const PANEL_MIN = 220;
export const PANEL_MAX = 650;
/** Espaço mínimo do canvas entre as laterais. */
export const MIN_CANVAS = 360;
export const PANEL_STEP = 16;
export const PANEL_STEP_LARGE = 64;

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Valor salvo (não confiável: IndexedDB editável) → larguras válidas. */
export function sanitizePanelWidths(raw: unknown): PanelWidths {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const one = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clampNum(v, PANEL_MIN, PANEL_MAX)) : def);
  return { library: one(o.library, PANEL_DEFAULTS.library), properties: one(o.properties, PANEL_DEFAULTS.properties) };
}

/**
 * Largura efetiva de uma lateral na janela atual.
 * `otherOpen`/`other`: a outra lateral (para reservar o canvas mínimo).
 */
export function effectivePanelWidth(stored: number, viewport: number, opts: { compact: boolean; otherOpen: boolean; other: number }): number {
  if (opts.compact) return Math.round(Math.min(stored, Math.max(200, viewport * 0.85)));
  const max = maxPanelWidth(viewport, opts);
  return Math.round(clampNum(stored, Math.min(PANEL_MIN, max), max));
}

/** Maior largura possível agora (respeita o canvas mínimo e o máximo absoluto). */
export function maxPanelWidth(viewport: number, opts: { otherOpen: boolean; other: number }): number {
  const otherW = opts.otherOpen ? Math.min(opts.other, PANEL_MAX) : 0;
  // A outra lateral também pode ter encolhido, mas nunca abaixo do mínimo: reserva o que ela ocupa de fato.
  const room = viewport - MIN_CANVAS - Math.max(otherW, opts.otherOpen ? PANEL_MIN : 0);
  return Math.max(160, Math.min(PANEL_MAX, Math.floor(room)));
}
