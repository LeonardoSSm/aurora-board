/**
 * Plugins de terceiros: registrados por MANIFESTO e executados isolados (iframe sandbox + CSP).
 *
 * - O HTML do plugin vem sempre do manifesto (nunca dos dados do quadro).
 * - O quadro guarda apenas o "estado" do plugin (JSON ≤ 100 KB), validado pelo host.
 * - O plugin não acessa o DOM, o IndexedDB nem a rede do app; não há allow-same-origin.
 */
import { Puzzle } from 'lucide-react';
import { getWidget, PluginManifestSchema, registerWidget, type WidgetPlugin } from './registry';
import { sanitizeSandbox, type SandboxData } from '../core/widgetData';
import { SandboxFrame } from './builtin/sandbox';

export function registerSandboxedPlugin(manifestRaw: unknown): WidgetPlugin<SandboxData> {
  const m = PluginManifestSchema.parse(manifestRaw);
  if (getWidget(m.id)) throw new Error(`Já existe um widget com id "${m.id}".`);
  if (m.id.startsWith('aurora.')) throw new Error('O prefixo "aurora." é reservado a widgets nativos.');
  const plugin: WidgetPlugin<SandboxData> = {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: Puzzle,
    version: m.version,
    category: 'Integrações',
    status: 'experimental',
    statusNote: 'Plugin de terceiros executado em sandbox isolada.',
    accent: '#9cb1cf',
    permissions: m.permissions,
    defaultSize: m.defaultSize,
    inputs: m.inputs,
    outputs: m.outputs,
    createData: () => ({ html: '', state: null }),
    sanitize: (raw) => ({ html: '', state: sanitizeSandbox(raw).state }),
    compute: (d) => Object.fromEntries(m.outputs.map((o) => [o.id, (d.state as Record<string, unknown> | null)?.[o.id] ?? null])),
    summarize: (d) => `${m.name}: ${JSON.stringify(d.state).slice(0, 500)}`,
    Component: function ThirdParty({ data, update, element }) {
      return <SandboxFrame html={m.html} state={data.state} title={element.title} onState={(state) => update({ state }, { coalesce: true })} />;
    },
  };
  registerWidget(plugin);
  return plugin;
}
