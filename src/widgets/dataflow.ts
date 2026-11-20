/** Cálculo memoizado do fluxo de dados para o quadro ativo. */
import { getState, setState, useEditor } from '../store/editor';
import type { AuroraElement } from '../core/schema';
import { isLinear } from '../core/schema';
import { computeDataflow, type DataflowResult } from '../core/dataflow';
import { dataflowSpec } from './registry';

let lastTokens: unknown[] = [];
let lastResult: DataflowResult = { inputs: new Map(), outputs: new Map(), edges: new Map() };

function tokensOf(elements: AuroraElement[]): unknown[] {
  const out: unknown[] = [];
  for (const e of elements) {
    if (e.type === 'widget') out.push(e.id, e.widgetType, e.data, e.title);
    else if (isLinear(e) && e.connection.kind === 'data') out.push(e.id, e.startBinding?.elementId, e.endBinding?.elementId, e.connection.sourcePort, e.connection.targetPort, e.connection.variable);
  }
  return out;
}

let lastElements: AuroraElement[] | null = null;

/**
 * Cada widget consulta o fluxo de dados (2 seletores por widget) a cada mudança de estado.
 * O array de elementos é imutável: mesma referência = mesmo resultado, sem percorrer nada.
 * (Antes: O(elementos × widgets) por quadro — ~1,3 milhão de operações com 5.000 elementos.)
 */
let lastExternal = 0;

/**
 * `dataflowVersion` (editor) muda quando dados EXTERNOS ao quadro mudam (ciclo F1: o razão financeiro local).
 * Nesse caso o cálculo é refeito sem reaproveitar saídas: o elemento de uma consulta bancária não mudou, mas
 * o resultado dela sim.
 */
export function getDataflow(elements: AuroraElement[]): DataflowResult {
  const external = getState().dataflowVersion;
  if (elements === lastElements && external === lastExternal) return lastResult;
  lastElements = elements;
  const tokens = tokensOf(elements);
  if (external === lastExternal && tokens.length === lastTokens.length && tokens.every((t, i) => t === lastTokens[i])) return lastResult;
  const reuse = external === lastExternal;
  lastExternal = external;
  lastTokens = tokens;
  lastResult = computeDataflow(elements, dataflowSpec, reuse ? lastResult : undefined);
  return lastResult;
}

/** Avisa o fluxo de dados de que uma fonte externa mudou (recalcula e re-renderiza os dependentes). */
export function bumpExternalData() {
  setState({ dataflowVersion: getState().dataflowVersion + 1 });
}

export function useDataflow(): DataflowResult {
  const elements = useEditor((s) => s.elements);
  useEditor((s) => s.dataflowVersion);
  return getDataflow(elements);
}
