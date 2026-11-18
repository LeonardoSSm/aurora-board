/** Cálculo memoizado do fluxo de dados para o quadro ativo. */
import { useEditor } from '../store/editor';
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
    else if (isLinear(e) && e.connection.kind === 'data') out.push(e.id, e.startBinding?.elementId, e.endBinding?.elementId);
  }
  return out;
}

export function getDataflow(elements: AuroraElement[]): DataflowResult {
  const tokens = tokensOf(elements);
  if (tokens.length === lastTokens.length && tokens.every((t, i) => t === lastTokens[i])) return lastResult;
  lastTokens = tokens;
  lastResult = computeDataflow(elements, dataflowSpec);
  return lastResult;
}

export function useDataflow(): DataflowResult {
  const elements = useEditor((s) => s.elements);
  return getDataflow(elements);
}
