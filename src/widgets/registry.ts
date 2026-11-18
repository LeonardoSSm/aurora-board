/**
 * Registro de widgets/plugins — contrato estável para componentes funcionais no canvas.
 *
 * Plugins nativos rodam no mesmo contexto (código revisado do projeto).
 * Plugins de terceiros devem ser registrados por manifesto e rodar ISOLADOS em iframe
 * com sandbox (ver SandboxFrame e registerSandboxedPlugin), comunicando-se só por postMessage.
 */
import type { ComponentType } from 'react';
import { z } from 'zod';
import type { AuroraElement, LinearElement, WidgetElement } from '../core/schema';
import type { DataflowNodeSpec, InputValue, PortDef } from '../core/dataflow';

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
  Component: ComponentType<WidgetProps<D>>;
  Inspector?: ComponentType<WidgetProps<D>>;
  actions?: WidgetAction<D>[];
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

export function widgetData<D>(el: WidgetElement): D {
  const p = widgets.get(el.widgetType);
  return (p ? p.sanitize(el.data) : el.data) as D;
}

export function dataflowSpec(widgetType: string): DataflowNodeSpec | undefined {
  const p = widgets.get(widgetType);
  if (!p) return undefined;
  return {
    inputs: p.inputs,
    outputs: p.outputs,
    compute: p.compute ? (el, inputs) => p.compute!(p.sanitize(el.data), inputs, el) : undefined,
  };
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
