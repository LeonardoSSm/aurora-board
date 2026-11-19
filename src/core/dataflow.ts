/**
 * Motor de fluxo de dados entre widgets.
 *
 * - Apenas conexões com `connection.kind === 'data'` e ancoradas nas duas pontas transmitem valores.
 *   Setas visuais, de contexto e de execução nunca calculam nada.
 * - Portas: se a conexão tem `sourcePort`/`targetPort`, usa exatamente essas (porta inexistente ou tipo
 *   incompatível = conexão inválida, com status). Sem portas explícitas, resolução LEGADA: o primeiro par
 *   compatível (entradas do destino × saídas da origem), igual às versões anteriores.
 * - Ciclos são detectados (Tarjan) e suas conexões ficam desativadas, com aviso — nunca há laço infinito.
 * - O cálculo é puro e síncrono. O `compute` de um widget pode devolver `$issues` para marcar conexões
 *   específicas (moeda incompatível, duplicidade, competência).
 * - Reaproveitamento: com o resultado anterior, um nó cujo elemento e entradas não mudaram mantém o mesmo
 *   objeto de saídas (sem novo cálculo e sem re-render dos dependentes).
 */
import type { AuroraElement, LinearElement, WidgetElement } from './schema';
import { isLinear, isWidget } from './schema';
import { slugVariable } from './scalar';

export type ValueType = string;

export interface PortDef {
  id: string;
  label: string;
  type: ValueType;
  /** Entradas: tipos aceitos além de `type` (ex.: ['money', 'number', 'percent']). */
  accepts?: ValueType[];
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
  /** Porta de saída de origem. */
  fromPort?: string;
  /** Nome lógico estável da conexão (variável de fórmula). */
  variable?: string;
}

export type EdgeStatus = 'ok' | 'incompatible' | 'cycle' | 'unbound' | 'not-widget' | 'missing-port' | 'currency' | 'duplicate' | 'period';

export interface EdgeResult {
  edgeId: string;
  status: EdgeStatus;
  fromPort?: PortDef;
  toPort?: PortDef;
  message: string;
  /** A porta foi escolhida explicitamente (true) ou pela resolução automática (false). */
  explicit?: boolean;
}

export interface DataflowResult {
  inputs: Map<string, Record<string, InputValue[]>>;
  outputs: Map<string, Record<string, unknown>>;
  edges: Map<string, EdgeResult>;
  /** Elemento usado em cada nó no cálculo (para reaproveitamento). */
  nodes?: Map<string, WidgetElement>;
}

export interface ComputeIssue { edgeId: string; status: Extract<EdgeStatus, 'currency' | 'duplicate' | 'period' | 'incompatible'>; message: string }
export const ISSUES_KEY = '$issues';

export function typesCompatible(out: ValueType, inp: ValueType): boolean {
  return inp === 'any' || out === inp;
}

export function portAccepts(input: PortDef, outType: ValueType): boolean {
  return typesCompatible(outType, input.type) || !!input.accepts?.includes(outType);
}

export function findPortPair(src: DataflowNodeSpec, dst: DataflowNodeSpec): { from: PortDef; to: PortDef } | null {
  for (const to of dst.inputs) for (const from of src.outputs) if (portAccepts(to, from.type)) return { from, to };
  return null;
}

/**
 * Sugestão para conexões NOVAS: percorre as entradas do destino e, para cada uma, prefere a saída do tipo
 * principal da entrada e depois os tipos aceitos, na ordem declarada (ex.: Finanças → Fórmula usa o saldo em
 * dinheiro, não o número legado). Conexões antigas sem portas continuam com `findPortPair`.
 */
export function suggestPorts(src: DataflowNodeSpec, dst: DataflowNodeSpec): { from: PortDef; to: PortDef } | null {
  for (const to of dst.inputs) {
    if (to.type === 'any') { if (src.outputs[0]) return { from: src.outputs[0], to }; continue; }
    for (const type of [to.type, ...(to.accepts ?? [])]) {
      const from = src.outputs.find((o) => o.type === type);
      if (from) return { from, to };
    }
  }
  return null;
}

/** Resolve o par de portas de uma conexão (explícito ou legado). */
export function resolvePorts(
  edge: LinearElement,
  src: DataflowNodeSpec | undefined,
  dst: DataflowNodeSpec | undefined,
): { ok: true; from: PortDef; to: PortDef; explicit: boolean } | { ok: false; status: 'missing-port' | 'incompatible'; message: string } {
  const sp = edge.connection.sourcePort, tp = edge.connection.targetPort;
  if (!sp && !tp) {
    const pair = src && dst ? findPortPair(src, dst) : null;
    if (pair) return { ok: true, ...pair, explicit: false };
    const outs = src?.outputs.map((p) => p.type).join(', ') || 'nenhuma';
    const ins = dst?.inputs.map((p) => [p.type, ...(p.accepts ?? [])].join('|')).join(', ') || 'nenhuma';
    return { ok: false, status: 'incompatible', message: `Tipos incompatíveis: saídas [${outs}] → entradas [${ins}].` };
  }
  const from = sp ? src?.outputs.find((p) => p.id === sp) : undefined;
  if (sp && !from) return { ok: false, status: 'missing-port', message: `A saída “${sp}” não existe na origem.` };
  const to = tp ? dst?.inputs.find((p) => p.id === tp) : undefined;
  if (tp && !to) return { ok: false, status: 'missing-port', message: `A entrada “${tp}” não existe no destino.` };
  // Só uma ponta explícita: completa a outra com a primeira compatível.
  const f = from ?? src?.outputs.find((o) => to && portAccepts(to, o.type));
  const t = to ?? dst?.inputs.find((i) => f && portAccepts(i, f.type));
  if (!f || !t || !portAccepts(t, f.type)) {
    return { ok: false, status: 'incompatible', message: `Tipo incompatível: ${f ? `${f.label} (${f.type})` : 'saída'} → ${t ? `${t.label} (${[t.type, ...(t.accepts ?? [])].join('|')})` : 'entrada'}.` };
  }
  return { ok: true, from: f, to: t, explicit: true };
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

type GetSpec = (widgetType: string, el?: WidgetElement) => DataflowNodeSpec | undefined;

function sameInputs(a: Record<string, InputValue[]> | undefined, b: Record<string, InputValue[]>): boolean {
  if (!a) return Object.keys(b).length === 0;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of kb) {
    const la = a[k], lb = b[k];
    if (!la || la.length !== lb.length) return false;
    for (let i = 0; i < lb.length; i++) {
      const x = la[i], y = lb[i];
      if (x.value !== y.value || x.edgeId !== y.edgeId || x.sourceId !== y.sourceId || x.sourceTitle !== y.sourceTitle || x.variable !== y.variable || x.fromPort !== y.fromPort) return false;
    }
  }
  return true;
}

export function computeDataflow(elements: AuroraElement[], getSpec: GetSpec, prev?: DataflowResult): DataflowResult {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const specs = new Map<string, DataflowNodeSpec | undefined>();
  const specOf = (w: WidgetElement) => {
    if (!specs.has(w.id)) specs.set(w.id, getSpec(w.widgetType, w));
    return specs.get(w.id);
  };
  const edges = new Map<string, EdgeResult>();
  const valid: { edge: LinearElement; from: WidgetElement; to: WidgetElement; fromPort: PortDef; toPort: PortDef; explicit: boolean }[] = [];

  for (const el of elements) {
    if (!isLinear(el) || el.connection.kind !== 'data') continue;
    const s = el.startBinding && byId.get(el.startBinding.elementId);
    const t = el.endBinding && byId.get(el.endBinding.elementId);
    if (!s || !t) {
      edges.set(el.id, { edgeId: el.id, status: 'unbound', message: 'Origem ou destino ausente: conecte as duas pontas a componentes.' });
      continue;
    }
    if (!isWidget(s) || !isWidget(t)) {
      edges.set(el.id, { edgeId: el.id, status: 'not-widget', message: 'Fluxo de dados só funciona entre componentes funcionais (widgets).' });
      continue;
    }
    const r = resolvePorts(el, specOf(s), specOf(t));
    if (!r.ok) {
      edges.set(el.id, { edgeId: el.id, status: r.status, message: r.message });
      continue;
    }
    valid.push({ edge: el, from: s, to: t, fromPort: r.from, toPort: r.to, explicit: r.explicit });
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
      edges.set(v.edge.id, { edgeId: v.edge.id, status: 'cycle', fromPort: v.fromPort, toPort: v.toPort, explicit: v.explicit, message: 'Ciclo detectado: esta conexão foi desativada para evitar laço infinito.' });
      return false;
    }
    edges.set(v.edge.id, { edgeId: v.edge.id, status: 'ok', fromPort: v.fromPort, toPort: v.toPort, explicit: v.explicit, message: `${v.fromPort.label} → ${v.toPort.label}` });
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
  const nodes = new Map<string, WidgetElement>();
  while (queue.length) {
    const id = queue.shift()!;
    const w = byId.get(id) as WidgetElement;
    nodes.set(id, w);
    const fresh = inputs.get(id) ?? {};
    const prevInputs = prev?.inputs.get(id);
    const reuse = !!prev && prev.nodes?.get(id) === w && prev.outputs.has(id) && sameInputs(prevInputs, fresh);
    // Entradas estáveis: mantém o mesmo objeto se o conteúdo não mudou (evita re-render).
    const ins = prevInputs && sameInputs(prevInputs, fresh) ? prevInputs : fresh;
    if (Object.keys(ins).length) inputs.set(id, ins);
    let outs: Record<string, unknown>;
    if (reuse) outs = prev!.outputs.get(id)!;
    else {
      const spec = specOf(w);
      try {
        outs = spec?.compute ? spec.compute(w, ins) : {};
      } catch {
        outs = {};
      }
    }
    const issues = (outs as Record<string, unknown>)[ISSUES_KEY] as ComputeIssue[] | undefined;
    if (issues?.length) {
      for (const iss of issues) {
        const cur = edges.get(iss.edgeId);
        if (cur && cur.status === 'ok') edges.set(iss.edgeId, { ...cur, status: iss.status, message: iss.message });
      }
    }
    outputs.set(id, outs);
    for (const v of outAdj.get(id) ?? []) {
      const target = inputs.get(v.to.id) ?? {};
      const list = target[v.toPort.id] ?? [];
      list.push({ value: outs[v.fromPort.id], sourceId: id, sourceTitle: w.title, edgeId: v.edge.id, fromPort: v.fromPort.id, variable: v.edge.connection.variable });
      target[v.toPort.id] = list;
      inputs.set(v.to.id, target);
      indeg.set(v.to.id, indeg.get(v.to.id)! - 1);
      if (indeg.get(v.to.id) === 0) queue.push(v.to.id);
    }
  }
  return { inputs, outputs, edges, nodes };
}


/** Palavra em português usada no nome lógico quando a porta de origem não é a principal. */
const PORT_WORDS: Record<string, string> = { income: 'receitas', expenses: 'despesas', balance: 'saldo', commitment: 'comprometimento', occurrences: 'lancamentos', balanceMoney: 'saldo' };
const PRIMARY_PORTS = new Set(['value', 'result', 'summary', 'ledger']);

export function variableBase(sourceTitle: string, sourcePort?: string): string {
  return slugVariable(sourcePort && !PRIMARY_PORTS.has(sourcePort) ? `${PORT_WORDS[sourcePort] ?? sourcePort} ${sourceTitle}` : sourceTitle);
}

/**
 * Finaliza conexões de dados recém-criadas ou religadas (`edgeIds`): fixa as portas resolvidas
 * (o que o usuário vê é o que fica gravado) e atribui um nome lógico estável (`connection.variable`),
 * único por destino, derivado do título da origem NESTE momento — renomear o bloco depois não muda o nome.
 * Conexões fora de `edgeIds` (inclusive antigas, sem portas) não são tocadas. Puro: mesmo array se nada mudou.
 */
export function finalizeDataEdges(elements: AuroraElement[], edgeIds: ReadonlySet<string>, getSpec: GetSpec): AuroraElement[] {
  if (!edgeIds.size) return elements;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const usedByTarget = new Map<string, Set<string>>();
  for (const e of elements) {
    if (isLinear(e) && e.connection.kind === 'data' && e.connection.variable && e.endBinding && !edgeIds.has(e.id)) {
      const set = usedByTarget.get(e.endBinding.elementId) ?? new Set<string>();
      set.add(e.connection.variable);
      usedByTarget.set(e.endBinding.elementId, set);
    }
  }
  let changed = false;
  const out = elements.map((e) => {
    if (!edgeIds.has(e.id) || !isLinear(e) || e.connection.kind !== 'data' || !e.startBinding || !e.endBinding) return e;
    const src = byId.get(e.startBinding.elementId), dst = byId.get(e.endBinding.elementId);
    if (!src || !dst || !isWidget(src) || !isWidget(dst)) return e;
    let conn = e.connection;
    if (!conn.sourcePort || !conn.targetPort) {
      const ss = getSpec(src.widgetType, src), ds = getSpec(dst.widgetType, dst);
      const pair = !conn.sourcePort && !conn.targetPort && ss && ds ? suggestPorts(ss, ds) : null;
      const r = pair ? { ok: true as const, ...pair } : resolvePorts(e, ss, ds);
      if (r.ok) conn = { ...conn, sourcePort: r.from.id, targetPort: r.to.id };
    }
    const used = usedByTarget.get(dst.id) ?? new Set<string>();
    if (!conn.variable || used.has(conn.variable)) {
      const base = variableBase(src.title, conn.sourcePort);
      let name = base, n = 2;
      while (used.has(name)) name = `${base}_${n++}`;
      conn = { ...conn, variable: name };
    }
    used.add(conn.variable!);
    usedByTarget.set(dst.id, used);
    if (conn === e.connection) return e;
    changed = true;
    return { ...e, connection: conn };
  });
  return changed ? out : elements;
}
