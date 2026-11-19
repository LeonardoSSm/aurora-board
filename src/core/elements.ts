/** Fábricas e utilitários de elementos (puros, sem dependência de UI). */
import type {
  AuroraElement,
  Board,
  BoardSettings,
  ElementStyle,
  FontFamily,
  FreedrawElement,
  ImageElement,
  LinearElement,
  LinkKind,
  ShapeElement,
  TextElement,
  WidgetElement,
  Workspace,
} from './schema';
import { SCHEMA_VERSION } from './schema';

export function uid(prefix = ''): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return prefix + rand;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Tamanhos de fonte predefinidos S/M/L/XL. */
export const FONT_SIZES = { S: 16, M: 20, L: 28, XL: 36 } as const;
export type FontSizePreset = keyof typeof FONT_SIZES;

export const FONT_FAMILIES: Record<FontFamily, { label: string; css: string; description: string }> = {
  hand: { label: 'Manual', css: '"Kalam", "Segoe Print", "Comic Sans MS", cursive', description: 'Manuscrita' },
  sans: { label: 'Sans', css: '"Inter Variable", "Inter", system-ui, sans-serif', description: 'Sans-serif moderna' },
  mono: { label: 'Mono', css: '"JetBrains Mono", ui-monospace, monospace', description: 'Monoespaçada' },
  serif: { label: 'Serifada', css: '"Lora", Georgia, serif', description: 'Clássica' },
};

export const LINE_HEIGHT = 1.3;

export const STROKE_COLORS = ['#e6e9f4', '#f47f8d', '#72c78e', '#69a8ff', '#f3c577', '#b998ff', '#65cfda', '#1b2333'];
export const BACKGROUND_COLORS = ['transparent', '#5c2f38', '#244e3e', '#24436a', '#5a4517', '#40335e', '#1b3a44', '#f0f0f5'];
export const STICKY_COLORS = ['#f3d77a', '#f5a3b5', '#9fe0b8', '#9cc5ff', '#cdb6ff', '#ffc48a'];

export const DEFAULT_STYLE: ElementStyle = {
  strokeColor: '#e6e9f4',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  roundness: 'round',
  fontFamily: 'hand',
  fontSize: FONT_SIZES.M,
  textAlign: 'center',
  verticalAlign: 'middle',
  textColor: '',
};

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  grid: true,
  gridSize: 20,
  snapToGrid: false,
  snapToObjects: true,
  wheelMode: 'zoom',
};

function base(type: AuroraElement['type'], x: number, y: number, width: number, height: number, style: Partial<ElementStyle> = {}) {
  return {
    id: uid(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    style: { ...DEFAULT_STYLE, ...style },
    groupIds: [] as string[],
    frameId: null,
    locked: false,
    seed: randomSeed(),
    version: 1,
    updatedAt: Date.now(),
    text: '',
  };
}

export function createShape(
  type: ShapeElement['type'],
  x: number,
  y: number,
  width: number,
  height: number,
  style: Partial<ElementStyle> = {},
): ShapeElement {
  const extra: Partial<ElementStyle> =
    type === 'sticky'
      ? { backgroundColor: STICKY_COLORS[0], strokeColor: '#3a3220', textColor: '#2a2414', roughness: 0, strokeWidth: 1, fillStyle: 'solid' }
      : type === 'frame'
        ? { backgroundColor: 'transparent', strokeColor: '#6c7f9c', roughness: 0, strokeWidth: 1.5, strokeStyle: 'solid', roundness: 'round', fontFamily: 'sans', fontSize: 14 }
        : {};
  const el = { ...base(type, x, y, width, height, { ...style, ...extra }), type } as ShapeElement;
  if (type === 'frame') el.text = 'Frame';
  if (type === 'sticky') {
    el.style.textAlign = 'left';
    el.style.verticalAlign = 'top';
  }
  return el;
}

export function createText(x: number, y: number, text = '', style: Partial<ElementStyle> = {}): TextElement {
  const st = { textAlign: 'left' as const, verticalAlign: 'top' as const, ...style };
  const el = { ...base('text', x, y, 10, (st.fontSize ?? DEFAULT_STYLE.fontSize) * LINE_HEIGHT, st), type: 'text', autoSize: true } as TextElement;
  el.text = text;
  return el;
}

export function createLinear(
  type: 'line' | 'arrow',
  x: number,
  y: number,
  points: [number, number][] = [[0, 0], [0, 0]],
  style: Partial<ElementStyle> = {},
  kind: LinkKind = 'visual',
): LinearElement {
  const el = {
    ...base(type, x, y, 0, 0, { ...style, backgroundColor: 'transparent' }),
    type,
    points,
    startBinding: null,
    endBinding: null,
    startArrowhead: 'none',
    endArrowhead: type === 'arrow' ? 'arrow' : 'none',
    path: 'straight',
    bend: 0,
    connection: { kind, relation: '' },
  } as LinearElement;
  return syncLinearBounds(el);
}

export function createFreedraw(x: number, y: number, style: Partial<ElementStyle> = {}): FreedrawElement {
  return {
    ...base('freedraw', x, y, 0, 0, { ...style, backgroundColor: 'transparent' }),
    type: 'freedraw',
    points: [[0, 0, 0.5]],
    simulatePressure: true,
  } as FreedrawElement;
}

export function createImage(x: number, y: number, width: number, height: number, assetId: string): ImageElement {
  return { ...base('image', x, y, width, height, { strokeWidth: 0 }), type: 'image', assetId } as ImageElement;
}

export function createWidget(
  widgetType: string,
  widgetVersion: string,
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
  data: unknown,
): WidgetElement {
  return {
    ...base('widget', x, y, width, height, { roughness: 0, fontFamily: 'sans', fontSize: 14, textAlign: 'left', verticalAlign: 'top' }),
    type: 'widget',
    widgetType,
    widgetVersion,
    title,
    data,
  } as WidgetElement;
}

/** Recalcula largura/altura (bbox) a partir dos pontos de um elemento linear ou de desenho livre. */
export function syncLinearBounds<T extends LinearElement | FreedrawElement>(el: T): T {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of el.points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!Number.isFinite(minX)) return el;
  return { ...el, width: maxX - minX, height: maxY - minY };
}

/** Normaliza desenho livre para que pontos fiquem com origem no canto superior esquerdo. */
export function normalizeFreedraw(el: FreedrawElement): FreedrawElement {
  let minX = Infinity, minY = Infinity;
  for (const p of el.points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
  }
  if (!Number.isFinite(minX)) return el;
  const pts = el.points.map(([px, py, pr]) => [px - minX, py - minY, pr] as [number, number, number]);
  return syncLinearBounds({ ...el, x: el.x + minX, y: el.y + minY, points: pts });
}

export function bump<T extends AuroraElement>(el: T, patch: Partial<T>): T {
  return { ...el, ...patch, version: el.version + 1, updatedAt: Date.now() };
}

export function createWorkspace(name: string): Workspace {
  const now = Date.now();
  return { id: uid('ws_'), name, createdAt: now, updatedAt: now, boardOrder: [] };
}

export function createBoard(workspaceId: string, name: string, description = ''): Board {
  const now = Date.now();
  return {
    id: uid('b_'),
    workspaceId,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    archived: false,
    settings: { ...DEFAULT_BOARD_SETTINGS },
    camera: { x: 0, y: 0, zoom: 1 },
    elements: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

type WidgetDataRemapper = (widgetType: string, data: unknown, idMap: ReadonlyMap<string, string>) => unknown;
let widgetDataRemapper: WidgetDataRemapper | null = null;
/** Registrado pela camada de widgets: permite que dados de widget que referenciam outros elementos acompanhem a cópia. */
export function setWidgetDataRemapper(fn: WidgetDataRemapper | null) {
  widgetDataRemapper = fn;
}

/**
 * Duplica elementos remapeando ids, grupos e vínculos internos.
 * Vínculos de setas para elementos fora do conjunto são removidos.
 */
export function cloneElements(elements: AuroraElement[], offset: { x: number; y: number }): AuroraElement[] {
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const el of elements) idMap.set(el.id, uid());
  const mapGroup = (g: string) => {
    if (!groupMap.has(g)) groupMap.set(g, uid('g_'));
    return groupMap.get(g)!;
  };
  return elements.map((el) => {
    const copy = structuredClone(el) as AuroraElement;
    copy.id = idMap.get(el.id)!;
    copy.x += offset.x;
    copy.y += offset.y;
    copy.groupIds = el.groupIds.map(mapGroup);
    copy.seed = randomSeed();
    copy.version = 1;
    copy.updatedAt = Date.now();
    if (copy.frameId) copy.frameId = idMap.get(copy.frameId) ?? null;
    if (copy.type === 'line' || copy.type === 'arrow') {
      const remap = (b: LinearElement['startBinding']) => (b && idMap.has(b.elementId) ? { ...b, elementId: idMap.get(b.elementId)! } : null);
      copy.startBinding = remap(copy.startBinding);
      copy.endBinding = remap(copy.endBinding);
    }
    if (copy.type === 'widget' && widgetDataRemapper) copy.data = widgetDataRemapper(copy.widgetType, copy.data, idMap);
    return copy;
  });
}
