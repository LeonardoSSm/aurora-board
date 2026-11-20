/**
 * Data Hub (issue #24, D2-B) — “Criar painel HTML conectado”: cria, ao lado de um bloco “Dados importados”, um
 * bloco HTML isolado com o exemplo de dashboard e as quatro conexões de dados (linhas, colunas, resumo e
 * agrupamento). Tudo numa única entrada de histórico. Nada de rede, nada de dados copiados: o HTML recebe só as
 * saídas limitadas do bloco de dados, pelo HTML Data Bridge.
 */
import type { AuroraElement, LinearElement, WidgetElement } from '../../core/schema';
import { createLinear, createWidget } from '../../core/elements';
import { WIDGET } from '../../core/widgetIds';
import type { WidgetHostApi } from '../registry';
import { getWidget } from '../registry';
import { DATASET_DASHBOARD_BRIDGE, DATASET_DASHBOARD_HTML } from './sandboxExamples';

/** Saída do bloco de dados → entrada do dashboard. */
export const DASHBOARD_LINKS: readonly [string, string][] = [
  ['rows', 'linhas'],
  ['columns', 'colunas'],
  ['summary', 'resumo'],
  ['groups', 'grupos'],
];

export const DASHBOARD_SIZE = { width: 520, height: 460 };

/** Elementos do painel (bloco HTML + conexões), sem gravar. */
export function buildConnectedDashboard(dataset: WidgetElement): AuroraElement[] {
  const x = dataset.x + dataset.width + 120;
  const y = dataset.y;
  const html = createWidget(
    WIDGET.sandbox,
    getWidget(WIDGET.sandbox)?.version ?? '1.0.0',
    `Painel — ${dataset.title}`.slice(0, 80),
    x,
    y,
    DASHBOARD_SIZE.width,
    DASHBOARD_SIZE.height,
    { html: DATASET_DASHBOARD_HTML, state: {}, bridge: structuredClone(DATASET_DASHBOARD_BRIDGE) },
  ) as WidgetElement;
  const edges: LinearElement[] = DASHBOARD_LINKS.map(([from, to], i) => {
    const sx = dataset.x + dataset.width;
    const sy = dataset.y + (dataset.height * (i + 1)) / (DASHBOARD_LINKS.length + 1);
    const ey = y + (DASHBOARD_SIZE.height * (i + 1)) / (DASHBOARD_LINKS.length + 1);
    const l = createLinear('arrow', sx, sy, [[0, 0], [x - sx, ey - sy]], {}, 'data');
    l.startBinding = { elementId: dataset.id, fixedPoint: null };
    l.endBinding = { elementId: html.id, fixedPoint: null };
    l.connection = { ...l.connection, sourcePort: from, targetPort: to };
    return l;
  });
  return [html, ...edges];
}

export function createConnectedDashboard(dataset: WidgetElement, api: Pick<WidgetHostApi, 'addElements'>): string {
  const els = buildConnectedDashboard(dataset);
  api.addElements(els, true);
  return els[0].id;
}
