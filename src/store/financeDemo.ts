/**
 * Quadro de exemplo “Demonstração — Finanças Visuais” (dados fictícios). Sempre cria um quadro NOVO;
 * nunca altera quadros existentes.
 */
import type { AuroraElement, LinearElement } from '../core/schema';
import { createLinear, createText, createWidget } from '../core/elements';
import { WIDGET } from '../core/widgetIds';
import { createValueData } from '../core/valueTile';
import { sanitizePeriod } from '../core/financePeriod';
import { periodLabel } from '../core/scalar';
import { addElements, createBoard, setSelection, zoomToFit } from './actions';
import { getState, setState } from './editor';
import { emptyHistory } from '../core/history';

export const FINANCE_DEMO_NAME = 'Demonstração — Finanças Visuais';

type Role = 'income' | 'expense';
const MONTHS: { period: string; values: [string, number, Role, string?][] }[] = [
  { period: '2027-01', values: [['Salário', 3000, 'income'], ['Financiamento', 712, 'expense', 'Moradia'], ['Alimentação', 500, 'expense', 'Mercado'], ['Outros gastos', 300, 'expense']] },
  { period: '2027-02', values: [['Salário', 3000, 'income'], ['Freela', 800, 'income'], ['Financiamento', 712, 'expense', 'Moradia'], ['Alimentação', 560, 'expense', 'Mercado'], ['Viagem', 900, 'expense', 'Lazer']] },
  { period: '2027-03', values: [['Salário', 3000, 'income'], ['Financiamento', 712, 'expense', 'Moradia'], ['Alimentação', 480, 'expense', 'Mercado'], ['Outros gastos', 250, 'expense']] },
];

function link(a: AuroraElement, b: AuroraElement, sourcePort: string, targetPort: string, variable: string): LinearElement {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: '#5addaa', strokeStyle: 'dashed' }, 'data');
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  l.connection = { ...l.connection, sourcePort, targetPort, variable };
  return l;
}

export function buildFinanceDemoElements(): AuroraElement[] {
  const els: AuroraElement[] = [];
  const title = createText(0, -150, 'Finanças visuais — exemplo com dados fictícios', { fontSize: 28, fontFamily: 'sans' });
  const hint = createText(0, -105, 'Valores → meses → fórmulas e gráfico. Altere um valor (duplo clique) e veja tudo recalcular.', { fontSize: 16, fontFamily: 'sans', strokeColor: '#8ea3bf' });
  els.push(title, hint);
  const months = MONTHS.map((m, i) => {
    const x = i * 540;
    const month = createWidget(WIDGET.financePeriod, '1.0.0', periodLabel(m.period), x + 250, 60, 220, 150, sanitizePeriod({ period: m.period, currency: 'BRL' }));
    month.style.strokeColor = '#f3c577';
    els.push(month);
    m.values.forEach(([name, reais, role, category], k) => {
      const v = createWidget(WIDGET.value, '1.0.0', name, x, k * 88, 176, 76, createValueData({ amountCents: reais * 100, financialRole: role, category: category ?? '' }));
      els.push(v, link(v, month, 'value', 'entries', name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '_')));
    });
    return month;
  });
  const names = ['janeiro', 'fevereiro', 'marco'];
  const y0 = 560;
  const total = createWidget(WIDGET.formula, '1.0.0', 'Saldo do trimestre', 250, y0, 230, 96, { expression: '=SOMA(janeiro, fevereiro, marco)' });
  const avg = createWidget(WIDGET.formula, '1.0.0', 'Média mensal', 790, y0, 230, 96, { expression: '=MEDIA(janeiro, fevereiro, marco)' });
  const proj = createWidget(WIDGET.formula, '1.0.0', 'Projeção 12 meses', 1330, y0, 230, 96, { expression: '=media * 12' });
  const reserve = createWidget(WIDGET.value, '1.0.0', 'Reserva', 1700, y0 - 120, 150, 76, createValueData({ valueType: 'percentage', numericValue: '20' }));
  const saving = createWidget(WIDGET.formula, '1.0.0', 'Guardar por mês', 1700, y0, 230, 96, { expression: '=salario * reserva' });
  const diff = createWidget(WIDGET.formula, '1.0.0', 'Fev − Jan', 250, y0 + 150, 230, 96, { expression: '=fevereiro - janeiro' });
  const chart = createWidget(WIDGET.chart, '1.0.0', 'Saldos por mês', 1700, -60, 380, 260, { mode: 'sources', chartType: 'bar' });
  const flow = createWidget(WIDGET.chart, '1.0.0', 'Receitas × despesas', 2120, -60, 380, 330, { mode: 'income-expense', chartType: 'bar' });
  chart.style.strokeColor = flow.style.strokeColor = '#b998ff';
  els.push(total, avg, proj, reserve, saving, diff, chart, flow);
  months.forEach((m, i) => {
    els.push(link(m, total, 'balance', 'in', names[i]), link(m, avg, 'balance', 'in', names[i]), link(m, chart, 'summary', 'series', names[i]), link(m, flow, 'summary', 'series', names[i]));
    if (i < 2) els.push(link(m, diff, 'balance', 'in', names[i]));
  });
  els.push(link(avg, proj, 'result', 'in', 'media'));
  const salary = els.find((e) => e.type === 'widget' && e.title === 'Salário')!;
  els.push(link(salary, saving, 'value', 'in', 'salario'), link(reserve, saving, 'value', 'in', 'reserva'));
  return els;
}

/** Cria e abre o quadro de demonstração (novo quadro; o histórico começa limpo). */
export async function createFinanceDemoBoard() {
  await createBoard(FINANCE_DEMO_NAME, 'Exemplo com dados fictícios: valores conectados a meses, fórmulas e gráficos.');
  addElements(buildFinanceDemoElements(), false);
  const s = getState();
  setState({ history: { ...s.history, [s.boardId]: emptyHistory() } });
  setSelection([]);
  zoomToFit();
}
