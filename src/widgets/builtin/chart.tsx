import { BarChart3 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeChart, type ChartData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney } from '../../core/finance';
import type { LedgerValue } from './finance';
import { Segmented } from '../../ui/primitives';

const COLORS = ['#6ca7ff', '#b998ff', '#5addaa', '#f3c577', '#f59abf', '#63d7dd', '#f8a277', '#9cb1cf'];

interface Series { label: string; value: number; color: string; secondary?: number }

export function buildSeries(data: ChartData, ledgers: LedgerValue[], numbers: { label: string; value: number }[]): { series: Series[]; currency?: string; warning?: string } {
  const currencies = new Set(ledgers.map((l) => l.currency));
  const warning = currencies.size > 1 ? 'Lançamentos em moedas diferentes: valores não são convertidos.' : undefined;
  const currency = ledgers[0]?.currency;
  if (data.mode === 'categories') {
    const map = new Map<string, number>();
    for (const l of ledgers) for (const c of l.byCategory) map.set(c.category, (map.get(c.category) ?? 0) + c.expenseCents);
    const series = [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value: value / 100, color: COLORS[i % COLORS.length] }));
    return { series, currency, warning };
  }
  if (data.mode === 'income-expense') {
    return {
      series: ledgers.flatMap((l) => [
        { label: `${l.source} · receitas`, value: l.summary.incomeCents / 100, color: '#5addaa' },
        { label: `${l.source} · despesas`, value: l.summary.expenseCents / 100, color: '#fb8590' },
      ]),
      currency,
      warning,
    };
  }
  return {
    series: [
      ...ledgers.map((l, i) => ({ label: l.source, value: l.summary.balanceCents / 100, color: COLORS[i % COLORS.length] })),
      ...numbers.map((n, i) => ({ label: n.label, value: n.value, color: COLORS[(i + ledgers.length) % COLORS.length] })),
    ],
    currency,
    warning,
  };
}

export const chartPlugin: WidgetPlugin<ChartData> = {
  id: WIDGET.chart,
  name: 'Gráfico',
  description: 'Visualiza dados recebidos por conexões de dados (ex.: blocos financeiros).',
  icon: BarChart3,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#b998ff',
  permissions: [],
  defaultSize: { width: 380, height: 300 },
  inputs: [
    { id: 'ledger', label: 'Lançamentos', type: 'finance.ledger' },
    { id: 'value', label: 'Valor', type: 'number' },
  ],
  outputs: [],
  createData: () => ({ mode: 'categories', chartType: 'bar' }),
  sanitize: sanitizeChart,
  summarize: (d) => `Gráfico (${d.mode}, ${d.chartType}).`,
  Component: function Chart({ data, update, inputs }) {
    const ledgers = (inputs.ledger ?? []).map((v) => v.value as LedgerValue).filter(Boolean);
    const numbers = (inputs.value ?? []).filter((v) => typeof v.value === 'number').map((v) => ({ label: v.sourceTitle, value: v.value as number }));
    const { series, currency, warning } = buildSeries(data, ledgers, numbers);
    const fmt = (v: number) => (currency ? formatMoney(Math.round(v * 100), currency as 'BRL', 'compact') : new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v));
    const max = Math.max(1, ...series.map((s) => Math.abs(s.value)));
    const total = series.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;

    return (
      <div className="flex flex-col gap-2 h-full">
        <div className="flex flex-wrap gap-1.5 justify-between">
          <Segmented
            value={data.mode}
            onChange={(mode) => update({ mode })}
            options={[
              { value: 'categories', label: 'Categorias' },
              { value: 'income-expense', label: 'Rec × Desp' },
              { value: 'sources', label: 'Saldos' },
            ]}
          />
          <Segmented value={data.chartType} onChange={(chartType) => update({ chartType })} options={[{ value: 'bar', label: 'Barras' }, { value: 'donut', label: 'Rosca' }]} />
        </div>
        {!ledgers.length && !numbers.length ? (
          <div className="flex-1 grid place-items-center text-center text-[12px] text-soft px-4">
            Conecte um bloco de Finanças a este gráfico com uma conexão do tipo “Dados” (ferramenta Conectar → Dados).
          </div>
        ) : !series.length ? (
          <div className="text-[12px] text-soft">Sem valores para este modo.</div>
        ) : data.chartType === 'bar' ? (
          <div className="flex flex-col gap-1.5" data-testid="chart-bars">
            {series.map((s) => (
              <div key={s.label} className="text-[11px]">
                <div className="flex justify-between text-fg-2"><span className="truncate">{s.label}</span><span className={s.value < 0 ? 'text-danger' : ''}>{fmt(s.value)}</span></div>
                <div className="h-2.5 rounded bg-panel-3 overflow-hidden">
                  <div className="h-full rounded" style={{ width: `${(Math.abs(s.value) / max) * 100}%`, background: s.value < 0 ? '#fb8590' : s.color }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-3 items-center">
            <svg viewBox="-1.1 -1.1 2.2 2.2" className="w-32 h-32 shrink-0 -rotate-90">
              {(() => {
                let acc = 0;
                return series.filter((s) => s.value > 0).map((s) => {
                  const frac = s.value / total;
                  const a0 = acc * 2 * Math.PI, a1 = (acc + frac) * 2 * Math.PI;
                  acc += frac;
                  const large = frac > 0.5 ? 1 : 0;
                  const d = frac >= 0.9999
                    ? 'M 1 0 A 1 1 0 1 1 -1 0 A 1 1 0 1 1 1 0'
                    : `M ${Math.cos(a0)} ${Math.sin(a0)} A 1 1 0 ${large} 1 ${Math.cos(a1)} ${Math.sin(a1)}`;
                  return <path key={s.label} d={d} fill="none" stroke={s.color} strokeWidth={0.38} />;
                });
              })()}
            </svg>
            <div className="flex flex-col gap-1 text-[11px] min-w-0">
              {series.filter((s) => s.value > 0).map((s) => (
                <div key={s.label} className="flex items-center gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
                  <span className="truncate">{s.label}</span>
                  <span className="text-soft ml-auto">{Math.round((s.value / total) * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {warning && <div className="text-[11px] text-warn">⚠ {warning}</div>}
      </div>
    );
  },
};
