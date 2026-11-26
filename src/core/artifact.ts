import { uid } from './elements';
import { digest, emptyBridge, sanitizeBridge, type BridgePort } from './htmlBridge';
import { isLinear, type AuroraElement } from './schema';
import type { SandboxData } from './widgetData';

export const MAX_ARTIFACT_HTML = 32_000;
export const MAX_ARTIFACT_HISTORY = 5;
export const ARTIFACT_SIZE = { width: 520, height: 420 };

export interface ArtifactPorts { inputs: BridgePort[]; outputs: BridgePort[] }
export interface ArtifactRevision extends ArtifactPorts {
  number: number;
  origin: 'ai' | 'manual' | 'restore' | 'example';
  at: number;
  html: string;
}
export interface ArtifactMetadata {
  version: 1;
  number: number;
  revisionId: string;
  origin: ArtifactRevision['origin'];
  at: number;
  history: ArtifactRevision[];
}

type Fields = Record<string, unknown>;
const fields = (raw: unknown): Fields => raw && typeof raw === 'object' ? raw as Fields : {};

function revisionInfo(raw: Fields) {
  const { number, origin, at } = raw;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > 1_000_000 ||
      (origin !== 'ai' && origin !== 'manual' && origin !== 'restore' && origin !== 'example') ||
      typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return { number, origin, at } satisfies Pick<ArtifactRevision, 'number' | 'origin' | 'at'>;
}

export function sanitizeArtifact(raw: unknown): ArtifactMetadata | undefined {
  const o = fields(raw);
  const current = revisionInfo(o);
  if (o.version !== 1 || !current || typeof o.revisionId !== 'string' || !/^[a-z0-9]{8,32}$/.test(o.revisionId)) return;
  const history = (Array.isArray(o.history) ? o.history.slice(-MAX_ARTIFACT_HISTORY) : []).flatMap((candidate) => {
    const d = fields(candidate);
    const info = revisionInfo(d);
    if (!info || info.number >= current.number || typeof d.html !== 'string' || d.html.length > MAX_ARTIFACT_HTML) return [];
    return [{ ...info, html: d.html, ...artifactPorts(sanitizeBridge(d)) }];
  });
  return { version: 1, revisionId: o.revisionId, ...current, history };
}

export function artifactPorts(bridge?: ArtifactPorts): ArtifactPorts {
  return { inputs: bridge?.inputs ?? [], outputs: bridge?.outputs ?? [] };
}

export function reviseArtifact(previous: SandboxData, html: string, ports: ArtifactPorts, origin: ArtifactRevision['origin'], run: boolean): SandboxData {
  const artifact = previous.artifact;
  const at = Date.now();
  const last = previous.html.trim() && previous.html.length <= MAX_ARTIFACT_HTML
    ? [{ number: artifact?.number ?? 1, origin: artifact?.origin ?? 'manual' as const, at: artifact?.at ?? at, html: previous.html, ...artifactPorts(previous.bridge) }]
    : [];
  return {
    ...previous,
    html,
    bridge: { ...emptyBridge(), ...ports },
    activation: { state: run ? 'allowed' : 'blocked', source: previous.activation?.source ?? 'artifact', at },
    artifact: { version: 1, number: (artifact?.number ?? (last.length ? 1 : 0)) + 1, revisionId: uid(), origin, at, history: [...(artifact?.history ?? []), ...last].slice(-MAX_ARTIFACT_HISTORY) },
  };
}

/** Stable on moves, renames and value changes. Includes any attached data edge in either direction. */
const edgeCache = new WeakMap<AuroraElement[], Map<string, string>>();
export function artifactEdges(elements: AuroraElement[], id: string): string {
  let index = edgeCache.get(elements);
  if (!index) {
    const byId = new Map<string, string[]>();
    for (const e of elements) {
      if (!isLinear(e) || e.connection.kind !== 'data') continue;
      const from = e.startBinding?.elementId;
      const to = e.endBinding?.elementId;
      const edge = JSON.stringify([e.id, from, e.connection.sourcePort, to, e.connection.targetPort, e.connection.variable]);
      for (const node of new Set([from, to])) {
        if (!node) continue;
        const list = byId.get(node) ?? [];
        list.push(edge);
        byId.set(node, list);
      }
    }
    index = new Map([...byId].map(([node, edges]) => [node, JSON.stringify(edges.sort())]));
    edgeCache.set(elements, index);
  }
  return index.get(id) ?? '[]';
}

export function artifactConfiguration(data: SandboxData, edges: string): string {
  return digest(JSON.stringify([data.artifact?.revisionId, data.html, artifactPorts(data.bridge), data.activation, edges]));
}

/** Static checks add feedback. Only the runtime sandbox governs what scripts can do. */
export function artifactCodeError(html: string): string | null {
  if (!html.trim() || html.length > MAX_ARTIFACT_HTML || html.includes('\0') || !/<[a-z][\w-]*(?:\s|\/?>)/i.test(html)) {
    return `Use HTML válido e autocontido de até ${MAX_ARTIFACT_HTML.toLocaleString('pt-BR')} caracteres.`;
  }
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  let count = 0;
  const pending = [template.content];
  for (const tree of pending) {
    for (const node of tree.querySelectorAll('*')) {
      if (++count > 1_500) return 'O HTML excede 1.500 elementos.';
      if (node instanceof HTMLTemplateElement) pending.push(node.content);
      if (node.matches('base, iframe, frame, frameset, embed, object, link, meta[http-equiv], script[src]')) return 'O HTML deve ser autocontido, sem frames, recursos externos ou redirecionamentos.';
      for (const { name, value } of node.attributes) {
        if ((name === 'src' || name === 'poster' || name === 'href' || name === 'xlink:href') &&
            value.trim() && !/^(?:#|data:(?:image|audio|video)\/)/i.test(value.trim())) {
          return 'Use referências locais (#…) ou mídia embutida. APIs HTTPS usam aurora.request().';
        }
        if (name === 'srcset' || name === 'ping' || name === 'action' || name === 'formaction') return 'Remova atributos que enviam dados ou carregam recursos externos.';
      }
    }
  }
  return null;
}
