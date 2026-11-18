/**
 * Motor de fluxo de dados entre widgets.
 *
 * - Apenas conexões com `connection.kind === 'data'` e ancoradas nas duas pontas transmitem valores.
 * - Cada conexão é validada por tipo: uma saída do widget de origem precisa ser compatível com uma entrada do destino.
 * - Ciclos são detectados (Tarjan) e suas conexões ficam desativadas, com aviso — nunca há laço infinito.
 * - O cálculo é puro e síncrono: nenhuma ação externa é executada aqui.
 */
import type { AuroraElement, LinearElement, WidgetElement } from './schema';
import { isLinear, isWidget } from './schema';

export type ValueType = string;

export interface PortDef {
  id: string;
  label: string;
  type: ValueType;
}

export interface DataflowNodeSpec {
  inputs: PortDef[];
  outputs: PortDef[];
  /** Calcula as saídas a partir dos dados e entradas recebidas. */
  compute?: (el: WidgetElement, inputs: Record<string, InputValue[]>) => Record<string, unknown>;
}

export interface InputValue {
  value: unknown;
  sourceId: string;
  sourceTitle: string;
  edgeId: string;
}

export type EdgeStatus = 'ok' | 'incompatible' | 'cycle' | 'unbound' | 'not-widget';

export interface EdgeResult {
  edgeId: string;
  status: EdgeStatus;
  fromPort?: PortDef;
  toPort?: PortDef;
  message: string;
}

export interface DataflowResult {
  inputs: Map<string, Record<string, InputValue[]>>;
  outputs: Map<string, Record<string, unknown>>;
  edges: Map<string, EdgeResult>;
}

export function typesCompatible(out: ValueType, inp: ValueType): boolean {
  return inp === 'any' || out === inp;
}

export function findPortPair(src: DataflowNodeSpec, dst: DataflowNodeSpec): { from: PortDef; to: PortDef } | null {
  for (const to of dst.inputs) for (const from of src.outputs) if (typesCompatible(from.type, to.type)) return { from, to };
  return null;
}

function tarjan(nodes: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [], out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return out;
}

export function computeDataflow(elements: AuroraElement[], getSpec: (widgetType: string) => DataflowNodeSpec | undefined): DataflowResult {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const edges = new Map<string, EdgeResult>();
  const valid: { edge: LinearElement; from: WidgetElement; to: WidgetElement; fromPort: PortDef; toPort: PortDef }[] = [];

  for (const el of elements) {
    if (!isLinear(el) || el.connection.kind !== 'data') continue;
    const s = el.startBinding && byId.get(el.startBinding.elementId);
    const t = el.endBinding && byId.get(el.endBinding.elementId);
    if (!s || !t) {
      edges.set(el.id, { edgeId: el.id, status: 'unbound', message: 'Conecte as duas pontas a componentes para transmitir dados.' });
      continue;
    }
    if (!isWidget(s) || !isWidget(t)) {
      edges.set(el.id, { edgeId: el.id, status: 'not-widget', message: 'Fluxo de dados só funciona entre componentes funcionais (widgets).' });
      continue;
    }
    const ss = getSpec(s.widgetType), ts = getSpec(t.widgetType);
    const pair = ss && ts ? findPortPair(ss, ts) : null;
    if (!pair) {
      const outs = ss?.outputs.map((p) => p.type).join(', ') || 'nenhuma';
      const ins = ts?.inputs.map((p) => p.type).join(', ') || 'nenhuma';
      edges.set(el.id, { edgeId: el.id, status: 'incompatible', message: `Tipos incompatíveis: saídas [${outs}] → entradas [${ins}].` });
      continue;
    }
    valid.push({ edge: el, from: s, to: t, fromPort: pair.from, toPort: pair.to });
  }

  // Detecção de ciclos.
  const nodeIds = [...new Set(valid.flatMap((v) => [v.from.id, v.to.id]))];
  const adj = new Map<string, string[]>();
  for (const v of valid) adj.set(v.from.id, [...(adj.get(v.from.id) ?? []), v.to.id]);
  const compOf = new Map<string, number>();
  const comps = tarjan(nodeIds, adj);
  comps.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));
  const cyclic = (v: (typeof valid)[number]) =>
    v.from.id === v.to.id || (compOf.get(v.from.id) === compOf.get(v.to.id) && comps[compOf.get(v.from.id)!].length > 1);
  const acyclic = valid.filter((v) => {
    if (cyclic(v)) {
      edges.set(v.edge.id, { edgeId: v.edge.id, status: 'cycle', fromPort: v.fromPort, toPort: v.toPort, message: 'Ciclo detectado: esta conexão foi desativada para evitar laço infinito.' });
      return false;
    }
    edges.set(v.edge.id, { edgeId: v.edge.id, status: 'ok', fromPort: v.fromPort, toPort: v.toPort, message: `${v.fromPort.label} → ${v.toPort.label}` });
    return true;
  });

  // Ordenação topológica (Kahn) e avaliação.
  const widgets = elements.filter(isWidget);
  const indeg = new Map<string, number>(widgets.map((w) => [w.id, 0]));
  const outAdj = new Map<string, typeof acyclic>();
  for (const v of acyclic) {
    indeg.set(v.to.id, (indeg.get(v.to.id) ?? 0) + 1);
    outAdj.set(v.from.id, [...(outAdj.get(v.from.id) ?? []), v]);
  }
  const queue = widgets.filter((w) => !indeg.get(w.id)).map((w) => w.id);
  const inputs = new Map<string, Record<string, InputValue[]>>();
  const outputs = new Map<string, Record<string, unknown>>();
  while (queue.length) {
    const id = queue.shift()!;
    const w = byId.get(id) as WidgetElement;
    const spec = getSpec(w.widgetType);
    const ins = inputs.get(id) ?? {};
    let outs: Record<string, unknown> = {};
    try {
      outs = spec?.compute ? spec.compute(w, ins) : {};
    } catch {
      outs = {};
    }
    outputs.set(id, outs);
    for (const v of outAdj.get(id) ?? []) {
      const target = inputs.get(v.to.id) ?? {};
      const list = target[v.toPort.id] ?? [];
      list.push({ value: outs[v.fromPort.id], sourceId: id, sourceTitle: w.title, edgeId: v.edge.id });
      target[v.toPort.id] = list;
      inputs.set(v.to.id, target);
      indeg.set(v.to.id, indeg.get(v.to.id)! - 1);
      if (indeg.get(v.to.id) === 0) queue.push(v.to.id);
    }
  }
  return { inputs, outputs, edges };
}
