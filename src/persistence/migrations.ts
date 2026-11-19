/** Versionamento e migração do esquema de quadros. */
import type { AuroraElement, Board } from '../core/schema';
import { BoardSettingsSchema, ElementSchema, SCHEMA_VERSION } from '../core/schema';
import { DEFAULT_BOARD_SETTINGS, DEFAULT_STYLE, randomSeed, uid } from '../core/elements';
import { sanitizeCheckpoints } from '../core/checkpoints';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Migrações incrementais: MIGRATIONS[n] converte um quadro da versão n para n+1.
 * Ao alterar o esquema, incremente SCHEMA_VERSION e adicione a função aqui (com teste).
 */
export const MIGRATIONS: Record<number, (board: Raw) => Raw> = {
  // 3: (b) => ({ ...b, novoCampo: ... }),
};

/**
 * Cores aceitas em estilos (S1-SEC-007): hex, `transparent`, nomes CSS simples e rgb/hsl numéricos.
 * Qualquer outra coisa (aspas, `<`, `url(`, ponto e vírgula...) volta ao padrão.
 */
const COLOR_RE = /^(#[0-9a-f]{3,8}|transparent|currentcolor|[a-z]{3,24}|rgba?\(\s*[\d.\s,%/]+\)|hsla?\(\s*[\d.\s,%/]+(deg)?[\d.\s,%/]*\))$/i;
export function isSafeColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && (v === '' || COLOR_RE.test(v.trim()));
}
const COLOR_FIELDS = ['strokeColor', 'backgroundColor', 'textColor'] as const;
function sanitizeStyleColors(style: Raw): Raw {
  for (const f of COLOR_FIELDS) if (!isSafeColor(style[f])) style[f] = DEFAULT_STYLE[f];
  return style;
}

/** Preenche campos ausentes com padrões e valida. Retorna null se irrecuperável. */
export function normalizeElement(raw: unknown): { element: AuroraElement | null; warning?: string } {
  const r = obj(raw);
  const type = String(r.type ?? '');
  const base: Raw = {
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    seed: randomSeed(),
    version: 1,
    updatedAt: Date.now(),
    text: '',
    ...r,
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    x: num(r.x, 0),
    y: num(r.y, 0),
    width: num(r.width, 100),
    height: num(r.height, 100),
    style: sanitizeStyleColors({ ...DEFAULT_STYLE, ...obj(r.style) }),
  };
  if (type === 'text') base.autoSize ??= true;
  if (type === 'line' || type === 'arrow') {
    base.points ??= [[0, 0], [base.width as number, base.height as number]];
    base.startBinding ??= null;
    base.endBinding ??= null;
    base.startArrowhead ??= 'none';
    base.endArrowhead ??= type === 'arrow' ? 'arrow' : 'none';
    base.path ??= 'straight';
    base.bend ??= 0;
    base.connection = { kind: 'visual', relation: '', ...obj(r.connection) };
  }
  if (type === 'freedraw') {
    // Pontos que não são arrays (null, objetos, números) são descartados em vez de derrubar a importação.
    base.points = Array.isArray(r.points) ? (r.points as unknown[]).filter(Array.isArray).map((p) => [num(p[0], 0), num(p[1], 0), num(p[2], 0.5)]) : [];
    base.simulatePressure ??= true;
  }
  if (type === 'widget') {
    base.widgetVersion ??= '1.0.0';
    base.title ??= '';
    base.data ??= {};
  }
  const parsed = ElementSchema.safeParse(base);
  if (!parsed.success) {
    return { element: null, warning: `Elemento "${base.id}" (${type || 'sem tipo'}) inválido e ignorado: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}` };
  }
  return { element: parsed.data };
}

/**
 * Repara referências internas quebradas (in-place) e retorna avisos:
 * - vínculo de seta para elemento inexistente → ponta solta (a seta é mantida);
 * - frame inexistente → elemento fica fora de frame;
 * - grupo com um único membro → grupo removido (não há o que agrupar).
 */
export function repairReferences(elements: AuroraElement[]): string[] {
  const warnings: string[] = [];
  const ids = new Set(elements.map((e) => e.id));
  const groupCount = new Map<string, number>();
  for (const e of elements) for (const g of e.groupIds) groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  for (const e of elements) {
    if (e.frameId && (!ids.has(e.frameId) || e.frameId === e.id)) {
      warnings.push(`Elemento ${e.id}: frame inexistente removido.`);
      e.frameId = null;
    }
    if (e.type === 'line' || e.type === 'arrow') {
      if (e.startBinding && !ids.has(e.startBinding.elementId)) { warnings.push(`Seta ${e.id}: início apontava para elemento inexistente.`); e.startBinding = null; }
      if (e.endBinding && !ids.has(e.endBinding.elementId)) { warnings.push(`Seta ${e.id}: fim apontava para elemento inexistente.`); e.endBinding = null; }
    }
    const solo = e.groupIds.filter((g) => groupCount.get(g) === 1);
    if (solo.length) e.groupIds = e.groupIds.filter((g) => !solo.includes(g));
  }
  return warnings;
}

/**
 * Configurações do quadro campo a campo (S1-SEC-008): valor inválido volta ao padrão com aviso; campos
 * desconhecidos são descartados (antes eram copiados como vieram, inclusive estruturas arbitrárias).
 */
export function sanitizeSettings(raw: unknown, warnings: string[] = []): Board['settings'] {
  const r = obj(raw);
  const out: Raw = { ...DEFAULT_BOARD_SETTINGS };
  const shape = BoardSettingsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
  const bad: string[] = [];
  for (const key of Object.keys(shape)) {
    if (!(key in r)) continue;
    const p = shape[key].safeParse(r[key]);
    if (p.success && p.data !== undefined) out[key] = p.data;
    else bad.push(key);
  }
  if (bad.length) warnings.push(`Configurações inválidas restauradas ao padrão: ${bad.join(', ')}.`);
  return BoardSettingsSchema.parse(out);
}

export function migrateBoard(raw: unknown, workspaceId: string): { board: Board; warnings: string[] } {
  let b = obj(raw);
  const warnings: string[] = [];
  // A versão vem do arquivo: inteiro entre 1 e o máximo plausível (S1-SEC-018). Antes, `schemaVersion: -1e15`
  // fazia o laço de migração abaixo rodar 10^15 vezes e congelava a aba.
  const rawVersion = num(b.schemaVersion, SCHEMA_VERSION);
  let version = Number.isInteger(rawVersion) ? Math.min(Math.max(rawVersion, 1), 1_000_000) : SCHEMA_VERSION;
  if (version > SCHEMA_VERSION) {
    warnings.push(`O quadro "${String(b.name ?? '')}" foi criado por uma versão mais nova (esquema ${version}). Campos desconhecidos podem ser ignorados.`);
  }
  while (version < SCHEMA_VERSION) {
    const m = MIGRATIONS[version];
    if (m) b = m(b);
    version++;
  }
  const elements: AuroraElement[] = [];
  const seen = new Set<string>();
  for (const rawEl of Array.isArray(b.elements) ? b.elements : []) {
    let res: ReturnType<typeof normalizeElement>;
    try {
      res = normalizeElement(rawEl);
    } catch {
      // Rede de segurança: um elemento com forma inesperada nunca derruba a importação do quadro inteiro.
      res = { element: null, warning: `Elemento com estrutura inesperada ignorado.` };
    }
    const { element, warning } = res;
    if (warning) warnings.push(warning);
    if (!element) continue;
    if (seen.has(element.id)) {
      warnings.push(`Id duplicado "${element.id}" renomeado.`);
      element.id = uid();
    }
    seen.add(element.id);
    elements.push(element);
  }
  warnings.push(...repairReferences(elements));
  const cam = obj(b.camera);
  const cps = sanitizeCheckpoints(b.checkpoints, () => uid('cp_'));
  warnings.push(...cps.warnings);
  const now = Date.now();
  const board: Board = {
    id: typeof b.id === 'string' && b.id ? b.id : uid('b_'),
    workspaceId,
    name: typeof b.name === 'string' && b.name.trim() ? b.name : 'Quadro sem nome',
    description: typeof b.description === 'string' ? b.description : '',
    createdAt: num(b.createdAt, now),
    updatedAt: num(b.updatedAt, now),
    archived: b.archived === true,
    settings: sanitizeSettings(b.settings, warnings),
    camera: { x: num(cam.x, 0), y: num(cam.y, 0), zoom: Math.min(10, Math.max(0.05, num(cam.zoom, 1))) },
    checkpoints: cps.checkpoints,
    elements,
    schemaVersion: SCHEMA_VERSION,
  };
  return { board, warnings };
}
