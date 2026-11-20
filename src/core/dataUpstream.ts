/** Navegação no grafo de conexões de DADOS (puro): quem alimenta um bloco, direta e indiretamente. */
import type { AuroraElement } from './schema';
import { isLinear } from './schema';

/** Ids de todos os blocos a montante (por conexões de dados), em ordem de descoberta. */
export function dataUpstream(elements: AuroraElement[], id: string): string[] {
  const upstream = new Map<string, string[]>();
  for (const e of elements) {
    if (!isLinear(e) || e.connection.kind !== 'data' || !e.startBinding || !e.endBinding) continue;
    upstream.set(e.endBinding.elementId, [...(upstream.get(e.endBinding.elementId) ?? []), e.startBinding.elementId]);
  }
  const seen = new Set<string>([id]);
  const out: string[] = [];
  const queue = [...(upstream.get(id) ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(upstream.get(cur) ?? []));
  }
  return out;
}

/** Conexões de dados que chegam diretamente ao bloco: `origem:porta→porta`. */
export function directInputEdges(elements: AuroraElement[], id: string): string[] {
  const out: string[] = [];
  for (const e of elements) {
    if (!isLinear(e) || e.connection.kind !== 'data' || e.endBinding?.elementId !== id || !e.startBinding) continue;
    out.push(`${e.startBinding.elementId}:${e.connection.sourcePort ?? ''}>${e.connection.targetPort ?? ''}`);
  }
  return out;
}
