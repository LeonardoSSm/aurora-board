/** Aparência padrão de cada tipo de conexão (usada pelo editor, pelo painel e pelo quadro de demonstração). */
import type { LinkKind, StrokeStyle } from './schema';

const CONNECTION_COLORS: Record<LinkKind, { stroke: string; dash: StrokeStyle }> = {
  visual: { stroke: '#8fa6c8', dash: 'solid' },
  context: { stroke: '#c0a0ff', dash: 'dashed' },
  data: { stroke: '#5addaa', dash: 'solid' },
  execution: { stroke: '#f3a35c', dash: 'dashed' },
};

export function connectionStyle(kind: LinkKind) {
  return CONNECTION_COLORS[kind];
}
