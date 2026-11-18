/**
 * Modelo de dados do Aurora Board (esquema versionado).
 *
 * Fonte única da verdade para tipos de elementos, quadros e workspaces.
 * Os tipos TypeScript são derivados dos esquemas zod, então validação de
 * importação e tipagem estática nunca divergem.
 */
import { z } from 'zod';

/** Versão atual do esquema persistido. v0.2/v0.3 do protótipo usavam `version: 2`. */
export const SCHEMA_VERSION = 3;

export const FontFamilySchema = z.enum(['hand', 'sans', 'mono', 'serif']);
export const StrokeStyleSchema = z.enum(['solid', 'dashed', 'dotted']);
export const FillStyleSchema = z.enum(['solid', 'hachure', 'cross-hatch']);
export const TextAlignSchema = z.enum(['left', 'center', 'right']);
export const VerticalAlignSchema = z.enum(['top', 'middle', 'bottom']);
export const RoundnessSchema = z.enum(['sharp', 'round']);
export const ArrowheadSchema = z.enum(['none', 'arrow', 'triangle', 'dot', 'bar']);
export const ArrowPathSchema = z.enum(['straight', 'curved', 'elbow']);

/**
 * Tipos de conexão:
 * - visual: apenas relacionamento/documentação (nunca transmite nada)
 * - context: fornece informação para outro componente (ex.: IA), mediante autorização
 * - data: transmite valores estruturados tipados entre componentes compatíveis
 * - execution: uma ação pode acionar outra, sempre com confirmação explícita
 */
export const LinkKindSchema = z.enum(['visual', 'context', 'data', 'execution']);

export const ElementStyleSchema = z.object({
  strokeColor: z.string(),
  backgroundColor: z.string(),
  fillStyle: FillStyleSchema,
  strokeWidth: z.number().min(0.5).max(32),
  strokeStyle: StrokeStyleSchema,
  /** 0 = arquiteto (limpo), 1 = artista, 2 = cartunista */
  roughness: z.number().min(0).max(3),
  opacity: z.number().min(0).max(100),
  roundness: RoundnessSchema,
  fontFamily: FontFamilySchema,
  fontSize: z.number().min(6).max(400),
  textAlign: TextAlignSchema,
  verticalAlign: VerticalAlignSchema,
  /** cor do texto; vazio = usa a cor do contorno */
  textColor: z.string(),
});

const PointSchema = z.tuple([z.number(), z.number()]);

export const BindingSchema = z.object({
  elementId: z.string(),
  /** Ponto normalizado [0..1] no espaço local do elemento; null = automático (borda mais próxima). */
  fixedPoint: PointSchema.nullable(),
});

const BaseElementShape = {
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  angle: z.number(),
  style: ElementStyleSchema,
  /** Grupos aninhados: do mais interno (índice 0) para o mais externo (último). */
  groupIds: z.array(z.string()),
  frameId: z.string().nullable(),
  locked: z.boolean(),
  seed: z.number().int(),
  version: z.number().int(),
  updatedAt: z.number(),
  /** Texto vinculado (dentro de formas, rótulo de setas, conteúdo de textos). */
  text: z.string(),
};

export const ShapeElementSchema = z.object({
  ...BaseElementShape,
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'sticky', 'frame']),
});

export const TextElementSchema = z.object({
  ...BaseElementShape,
  type: z.literal('text'),
  /** true = largura acompanha o conteúdo; false = quebra de linha na largura definida. */
  autoSize: z.boolean(),
});

export const ConnectionSchema = z.object({
  kind: LinkKindSchema,
  /** Relação semântica livre para conexões visuais (ex.: "dependência", "referência"). */
  relation: z.string(),
});

export const LinearElementSchema = z.object({
  ...BaseElementShape,
  type: z.enum(['line', 'arrow']),
  /** Pontos relativos a (x, y). O primeiro é sempre [0, 0]. */
  points: z.array(PointSchema).min(2),
  startBinding: BindingSchema.nullable(),
  endBinding: BindingSchema.nullable(),
  startArrowhead: ArrowheadSchema,
  endArrowhead: ArrowheadSchema,
  path: ArrowPathSchema,
  /** Curvatura (apenas para path = curved), em pixels perpendiculares ao segmento. */
  bend: z.number(),
  connection: ConnectionSchema,
});

export const FreedrawElementSchema = z.object({
  ...BaseElementShape,
  type: z.literal('freedraw'),
  /** Pontos relativos a (x, y) com pressão opcional. */
  points: z.array(z.tuple([z.number(), z.number(), z.number()])),
  simulatePressure: z.boolean(),
});

export const ImageElementSchema = z.object({
  ...BaseElementShape,
  type: z.literal('image'),
  assetId: z.string(),
});

export const WidgetElementSchema = z.object({
  ...BaseElementShape,
  type: z.literal('widget'),
  /** Identificador do plugin (ex.: "aurora.finance"). */
  widgetType: z.string(),
  /** Versão do plugin que gravou os dados (migração por plugin). */
  widgetVersion: z.string(),
  title: z.string(),
  /** Dados próprios do plugin; validados pelo próprio plugin. */
  data: z.unknown(),
});

export const ElementSchema = z.discriminatedUnion('type', [
  ShapeElementSchema,
  TextElementSchema,
  LinearElementSchema,
  FreedrawElementSchema,
  ImageElementSchema,
  WidgetElementSchema,
]);

export const CameraSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.05).max(10) });

export const BoardSettingsSchema = z.object({
  grid: z.boolean(),
  gridSize: z.number().min(4).max(200),
  snapToGrid: z.boolean(),
  /** Encaixe em bordas/centros de outros elementos ao mover (Ctrl inverte durante o arrasto). */
  snapToObjects: z.boolean().default(true),
  /** Roda do mouse: zoom (padrão pedido) ou pan (estilo Excalidraw). Touchpad sempre faz pan. */
  wheelMode: z.enum(['zoom', 'pan']),
});

export const BoardSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  settings: BoardSettingsSchema,
  camera: CameraSchema,
  elements: z.array(ElementSchema),
  schemaVersion: z.number().int(),
});

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  boardOrder: z.array(z.string()),
});

export const AssetSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  dataURL: z.string(),
  name: z.string(),
  size: z.number(),
  createdAt: z.number(),
});

/** Formato de arquivo de exportação/backup. */
export const ExportFileSchema = z.object({
  format: z.literal('aurora-board'),
  schemaVersion: z.number().int(),
  exportedAt: z.number(),
  app: z.string(),
  workspace: WorkspaceSchema.optional(),
  boards: z.array(z.unknown()).min(1),
  assets: z.array(AssetSchema).default([]),
});

export type FontFamily = z.infer<typeof FontFamilySchema>;
export type StrokeStyle = z.infer<typeof StrokeStyleSchema>;
export type FillStyle = z.infer<typeof FillStyleSchema>;
export type TextAlign = z.infer<typeof TextAlignSchema>;
export type VerticalAlign = z.infer<typeof VerticalAlignSchema>;
export type Roundness = z.infer<typeof RoundnessSchema>;
export type Arrowhead = z.infer<typeof ArrowheadSchema>;
export type ArrowPath = z.infer<typeof ArrowPathSchema>;
export type LinkKind = z.infer<typeof LinkKindSchema>;
export type ElementStyle = z.infer<typeof ElementStyleSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type ShapeElement = z.infer<typeof ShapeElementSchema>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type LinearElement = z.infer<typeof LinearElementSchema>;
export type FreedrawElement = z.infer<typeof FreedrawElementSchema>;
export type ImageElement = z.infer<typeof ImageElementSchema>;
export type WidgetElement = z.infer<typeof WidgetElementSchema>;
export type AuroraElement = z.infer<typeof ElementSchema>;
export type ElementType = AuroraElement['type'];
export type Camera = z.infer<typeof CameraSchema>;
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type BoardMeta = Omit<Board, 'elements'>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type ExportFile = z.infer<typeof ExportFileSchema>;
export type Point = [number, number];

export const SHAPE_TYPES = ['rectangle', 'ellipse', 'diamond', 'sticky', 'frame'] as const;

export function isShape(el: AuroraElement): el is ShapeElement {
  return (SHAPE_TYPES as readonly string[]).includes(el.type);
}
export function isLinear(el: AuroraElement): el is LinearElement {
  return el.type === 'line' || el.type === 'arrow';
}
export function isText(el: AuroraElement): el is TextElement {
  return el.type === 'text';
}
export function isWidget(el: AuroraElement): el is WidgetElement {
  return el.type === 'widget';
}
export function isFreedraw(el: AuroraElement): el is FreedrawElement {
  return el.type === 'freedraw';
}
export function isImage(el: AuroraElement): el is ImageElement {
  return el.type === 'image';
}

/** Elementos que podem receber o fim de uma seta (ancoragem). */
export function isBindable(el: AuroraElement): boolean {
  return !isLinear(el) && el.type !== 'freedraw';
}

/** Elementos que suportam rotação. */
export function isRotatable(el: AuroraElement): boolean {
  return ['rectangle', 'ellipse', 'diamond', 'sticky', 'text', 'image', 'freedraw'].includes(el.type);
}

/** Elementos que aceitam texto interno via duplo clique. */
export function acceptsBoundText(el: AuroraElement): boolean {
  return ['rectangle', 'ellipse', 'diamond', 'sticky'].includes(el.type) || isLinear(el);
}
