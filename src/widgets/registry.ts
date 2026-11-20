/**
 * Registro de widgets/plugins — contrato estável para componentes funcionais no canvas.
 *
 * Plugins nativos rodam no mesmo contexto (código revisado do projeto).
 * Plugins de terceiros devem ser registrados por manifesto e rodar ISOLADOS em iframe
 * com sandbox (ver SandboxFrame e registerSandboxedPlugin), comunicando-se só por postMessage.
 */
import type { ComponentType } from 'react';
import '../core/zodSetup';
import { z } from 'zod';
import type { AuroraElement, LinearElement, WidgetElement } from '../core/schema';
import type { DataflowNodeSpec, InputValue, PortDef } from '../core/dataflow';
import { setWidgetDataRemapper } from '../core/elements';

export type WidgetStatus = 'ready' | 'needs-config' | 'planned' | 'experimental';

export const PermissionSchema = z.enum([
  'ai:send-context',
  'network:link-preview',
  'clipboard:write',
  'storage:assets',
  'sandbox:scripts',
  'external:google-calendar',
  'external:google-drive',
  'external:github',
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const PERMISSION_LABELS: Record<Permission, string> = {
  'ai:send-context': 'Enviar contexto autorizado a um provedor de IA',
  'network:link-preview': 'Buscar pré-visualização de links (via servidor local)',
  'clipboard:write': 'Copiar para a área de transferência',
  'storage:assets': 'Guardar arquivos no armazenamento local',
  'sandbox:scripts': 'Executar scripts em iframe isolado (sem acesso ao app)',
  'external:google-calendar': 'Acessar Google Calendar (OAuth)',
  'external:google-drive': 'Acessar Google Drive (OAuth)',
  'external:github': 'Acessar GitHub (OAuth/token)',
};

export interface WidgetHostApi {
  toast(message: string, kind?: 'info' | 'success' | 'error' | 'warning'): void;
  confirm(title: string, message: string, confirmLabel?: string, danger?: boolean): Promise<boolean>;
  getElements(): AuroraElement[];
  getElement(id: string): AuroraElement | undefined;
  /** Adiciona elementos ao quadro (com histórico). */
  addElements(elements: AuroraElement[], select?: boolean): void;
  /** Conexões (setas ancoradas) ligadas a este widget. */
  connections(): LinearElement[];
  updateElement(id: string, patch: Partial<AuroraElement>): void;
  updateWidgetData(id: string, updater: (data: unknown) => unknown): void;
  /** Adiciona elementos e altera dados de widgets numa única entrada de histórico. */
  applyBatch(elements: AuroraElement[], updates: { id: string; update: (data: unknown) => unknown }[], select?: boolean): void;
  putAsset(file: File | Blob, name?: string): Promise<string>;
  getAssetURL(id: string): Promise<string | null>;
}

export interface WidgetProps<D> {
  element: WidgetElement;
  data: D;
  update: (updater: Partial<D> | ((d: D) => D), opts?: { coalesce?: boolean }) => void;
  selected: boolean;
  inputs: Record<string, InputValue[]>;
  outputs: Record<string, unknown>;
  api: WidgetHostApi;
}

export interface WidgetAction<D> {
  id: string;
  label: string;
  /** Se presente, exige confirmação explícita antes de executar. */
  confirm?: string;
  run: (props: WidgetProps<D>) => void | Promise<void>;
}

export interface WidgetPlugin<D = unknown> {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  version: string;
  category: 'Produtividade' | 'Dados' | 'Mídia' | 'IA' | 'Desenvolvimento' | 'Integrações';
  status: WidgetStatus;
  statusNote?: string;
  accent: string;
  permissions: Permission[];
  defaultSize: { width: number; height: number };
  minSize?: { width: number; height: number };
  inputs: PortDef[];
  outputs: PortDef[];
  createData(): D;
  sanitize(raw: unknown): D;
  compute?(data: D, inputs: Record<string, InputValue[]>, element: WidgetElement): Record<string, unknown>;
  /** Resumo textual (contexto para IA, exportação SVG, busca). */
  summarize(data: D, element: WidgetElement): string;
  /**
   * Ciclo F1: conteúdo enviado à IA quando difere do resumo. `allowed: false` impede o envio (ex.: dados
   * financeiros sem autorização confirmada no próprio bloco), mesmo com conexão de contexto/dados.
   */
  aiContext?(data: D, element: WidgetElement): { allowed: boolean; text: string; reason?: string };
  Component: ComponentType<WidgetProps<D>>;
  /** Configurações exibidas no painel de propriedades quando o widget está selecionado sozinho. */
  Inspector?: ComponentType<WidgetProps<D>>;
  actions?: WidgetAction<D>[];
  /**
   * Moldura: 'standard' (cabeçalho, título, estado) ou 'bare' (o componente ocupa a área inteira,
   * sem cabeçalho; o corpo não captura o ponteiro — clicar e arrastar move o elemento).
   */
  frame?: 'standard' | 'bare';
  /** Moldura conforme os dados (ex.: assistente no visual “Personagem” usa 'bare'). Tem prioridade sobre `frame`. */
  frameFor?(data: D): 'standard' | 'bare';
  /** Variações prontas exibidas na biblioteca (clique insere, arrastar posiciona). */
  presets?: WidgetPreset<D>[];
  /** Título da seção da biblioteca para os presets (padrão: nome do widget). */
  librarySection?: string;
  /** Ao inserir (biblioteca), já entra na edição rápida do bloco. */
  editOnInsert?: boolean;
  /** Oculta a entrada genérica do widget na biblioteca (quando os presets já cobrem os casos). */
  hideInLibrary?: boolean;
  /** Duplo clique no widget (fora de modo de edição de grupo). */
  onDoubleClick?(element: WidgetElement): void;
  /** Itens extras no menu de contexto (as ações genéricas continuam). */
  menuItems?(element: WidgetElement, data: D): WidgetMenuItem[];
  /** Conteúdo SVG fiel para exportação (coordenadas locais 0..width × 0..height). Sem isso, exporta um resumo. */
  exportSVG?(data: D, element: WidgetElement): string | Promise<string>;
  /** Ao copiar/duplicar: troca ids de outros elementos citados nos dados (mapa antigo → novo). */
  remapIds?(data: D, idMap: ReadonlyMap<string, string>): D;
  /** Portas que dependem dos dados do elemento (ex.: tipo do valor). Sem isso, `inputs`/`outputs` fixos. */
  ports?(data: D): { inputs: PortDef[]; outputs: PortDef[] };
}

export interface WidgetPreset<D = unknown> {
  id: string;
  name: string;
  description?: string;
  keywords?: string[];
  /** Ícone da biblioteca (ex.: logo). */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Campos aplicados sobre `createData()`. */
  data: Partial<D>;
  size?: { width: number; height: number };
  /** Título inicial do elemento (padrão: `name`). */
  title?: string;
  accent?: string;
}

export interface WidgetMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

/** Integrações futuras listadas na biblioteca, claramente marcadas como não implementadas. */
export interface PlannedIntegration {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  permissions: Permission[];
  activation: string;
}

const widgets = new Map<string, WidgetPlugin<any>>();

setWidgetDataRemapper((type, data, idMap) => {
  const p = widgets.get(type);
  return p?.remapIds ? p.remapIds(p.sanitize(data), idMap) : data;
});
const planned: PlannedIntegration[] = [];

export function registerWidget<D>(plugin: WidgetPlugin<D>) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(plugin.id)) throw new Error(`Id de plugin inválido: ${plugin.id}`);
  widgets.set(plugin.id, plugin as WidgetPlugin<any>);
}

export function registerPlanned(p: PlannedIntegration) {
  if (!planned.some((x) => x.id === p.id)) planned.push(p);
}

export function getWidget(id: string): WidgetPlugin<any> | undefined {
  return widgets.get(id);
}

export function listWidgets(): WidgetPlugin<any>[] {
  return [...widgets.values()];
}

export function listPlanned(): PlannedIntegration[] {
  return planned;
}

/** Tipo de arrasto da biblioteca para um preset: `<pluginId>#<presetId>`. */
export function presetDragType(pluginId: string, presetId: string) {
  return `${pluginId}#${presetId}`;
}

export function findWidgetPreset(type: string): { plugin: WidgetPlugin<any>; preset: WidgetPreset<any> } | null {
  const i = type.indexOf('#');
  if (i < 0) return null;
  const plugin = widgets.get(type.slice(0, i));
  const preset = plugin?.presets?.find((p) => p.id === type.slice(i + 1));
  return plugin && preset ? { plugin, preset } : null;
}

export function widgetData<D>(el: WidgetElement): D {
  const p = widgets.get(el.widgetType);
  return (p ? p.sanitize(el.data) : el.data) as D;
}

/** Especificação de fluxo de dados; com o elemento, usa as portas que dependem dos dados (`ports`). */
export function dataflowSpec(widgetType: string, el?: WidgetElement): DataflowNodeSpec | undefined {
  const p = widgets.get(widgetType);
  if (!p) return undefined;
  const ports = el && p.ports ? p.ports(p.sanitize(el.data)) : null;
  return {
    inputs: ports?.inputs ?? p.inputs,
    outputs: ports?.outputs ?? p.outputs,
    compute: p.compute ? (e, inputs) => p.compute!(p.sanitize(e.data), inputs, e) : undefined,
  };
}

/** Política de IA de um elemento: null = sem política própria (usa o resumo). */
export function aiPolicyOf(el: AuroraElement): { allowed: boolean; text: string; reason?: string } | null {
  if (el.type !== 'widget') return null;
  const p = widgets.get(el.widgetType);
  if (!p?.aiContext) return null;
  try {
    return p.aiContext(p.sanitize(el.data), el);
  } catch {
    return { allowed: false, text: '', reason: 'Não foi possível preparar o conteúdo com segurança.' };
  }
}

export function summarizeElement(el: AuroraElement): string {
  if (el.type === 'widget') {
    const p = widgets.get(el.widgetType);
    if (!p) return `[Widget desconhecido: ${el.widgetType}]`;
    try {
      return p.summarize(p.sanitize(el.data), el);
    } catch {
      return '';
    }
  }
  return el.text;
}

/* ------------------------------------------------------------------ */
/* Manifesto de plugins de terceiros (isolados)                        */
/* ------------------------------------------------------------------ */

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Use formato reverso, ex.: com.empresa.widget'),
  name: z.string().min(1).max(60),
  description: z.string().max(300),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  permissions: z.array(PermissionSchema),
  /** Documento HTML completo executado em iframe sandbox (sem allow-same-origin). */
  html: z.string().max(500_000),
  defaultSize: z.object({ width: z.number().min(120).max(2000), height: z.number().min(80).max(2000) }),
  inputs: z.array(z.object({ id: z.string(), label: z.string(), type: z.string() })).default([]),
  outputs: z.array(z.object({ id: z.string(), label: z.string(), type: z.string() })).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
