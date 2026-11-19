import { BarChart3 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeChart, type ChartData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney, type Currency } from '../../core/finance';
import type { LedgerValue } from './finance';
import { Segmented } from '../../ui/primitives';
import { isPeriodSummary, type PeriodSummary } from '../../core/financePeriod';
import { periodLabel, readScalar, scalarDec, type Scalar } from '../../core/scalar';
import { decToNumber, formatDec, decFromNumber } from '../../core/decimal';
import type { InputValue } from '../../core/dataflow';
import { measureLine } from '../../core/text';
import { currentFlow } from './financeShared';

const COLORS = ['#6ca7ff', '#b998ff', '#5addaa', '#f3c577', '#f59abf', '#63d7dd', '#f8a277', '#9cb1cf'];
const INCOME = '#5addaa', EXPENSE = '#fb8590';

export interface Series { label: string; value: number; color: string; secondary?: number; group?: 'income' | 'expense' | 'balance' | 'value'; kind?: 'money' | 'number' | 'percent' }

export interface ChartExtra { periods?: PeriodSummary[]; scalars?: { label: string; value: Scalar }[] }

/** Monta as séries. Valores monetários vêm de centavos inteiros; aqui só viram reais para desenhar. */
export function buildSeries(data: ChartData, ledgers: LedgerValue[], numbers: { label: string; value: number }[], extra: ChartExtra = {}): { series: Series[]; currency?: string; warning?: string } {
  const periods = [...(extra.periods ?? [])].sort((a, b) => a.period.localeCompare(b.period));
  const scalars = extra.scalars ?? [];
  const currencies = new Set<Currency>([...ledgers.map((l) => l.currency), ...periods.map((p) => p.currency), ...scalars.flatMap((s) => (s.value.t === 'money' ? [s.value.currency] : []))]);
  const warning = currencies.size > 1 ? 'Valores em moedas diferentes: nada é convertido; compare só a mesma moeda.' : undefined;
  const currency = currencies.size ? [...currencies][0] : undefined;
  const plabel = (p: PeriodSummary) => (p.label && p.label !== periodLabel(p.period) ? p.label : periodLabel(p.period, 'short'));
  if (data.mode === 'categories') {
    const map = new Map<string, number>();
    for (const l of ledgers) for (const c of l.byCategory) map.set(c.category, (map.get(c.category) ?? 0) + c.expenseCents);
    for (const p of periods) for (const c of p.byCategory) map.set(c.category, (map.get(c.category) ?? 0) + c.expenseCents);
    const series = [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value: value / 100, color: COLORS[i % COLORS.length], kind: 'money' as const }));
    return { series, currency, warning };
  }
  if (data.mode === 'income-expense') {
    return {
      series: [
        ...ledgers.flatMap((l) => [
          { label: `${l.source} · receitas`, value: l.summary.incomeCents / 100, color: INCOME, group: 'income' as const, kind: 'money' as const },
          { label: `${l.source} · despesas`, value: l.summary.expenseCents / 100, color: EXPENSE, group: 'expense' as const, kind: 'money' as const },
        ]),
        ...periods.flatMap((p) => [
          { label: `${plabel(p)} · receitas`, value: p.incomeCents / 100, color: INCOME, group: 'income' as const, kind: 'money' as const },
          { label: `${plabel(p)} · despesas`, value: p.expenseCents / 100, color: EXPENSE, group: 'expense' as const, kind: 'money' as const },
        ]),
      ],
      currency,
      warning,
    };
  }
  let i = 0;
  const next = () => COLORS[i++ % COLORS.length];
  return {
    series: [
      ...ledgers.map((l) => ({ label: l.source, value: l.summary.balanceCents / 100, color: next(), group: 'balance' as const, kind: 'money' as const })),
      ...periods.map((p) => ({ label: plabel(p), value: p.balanceCents / 100, color: next(), group: 'balance' as const, kind: 'money' as const })),
      ...numbers.map((n) => ({ label: n.label, value: n.value, color: next(), group: 'value' as const, kind: 'number' as const })),
      ...scalars.map((s) => ({
        label: s.label,
        value: s.value.t === 'money' ? s.value.cents / 100 : decToNumber(scalarDec(s.value) * (s.value.t === 'percent' ? 100n : 1n)),
        color: next(),
        group: 'value' as const,
        kind: s.value.t,
      })),
    ],
    currency,
    warning,
  };
}

function readInputs(inputs: Record<string, InputValue[]>) {
  const ledgers = (inputs.ledger ?? []).map((v) => v.value as LedgerValue).filter(Boolean);
  const numbers = (inputs.value ?? []).filter((v) => typeof v.value === 'number' && Number.isFinite(v.value)).map((v) => ({ label: v.sourceTitle, value: v.value as number }));
  const periods: PeriodSummary[] = [];
  const scalars: { label: string; value: Scalar }[] = [];
  for (const v of [...(inputs.value ?? []).filter((x) => typeof x.value !== 'number'), ...(inputs.series ?? [])]) {
    if (isPeriodSummary(v.value)) periods.push(v.value);
    else {
      const s = readScalar(v.value);
      if (s) scalars.push({ label: v.sourceTitle, value: s });
    }
  }
  return { ledgers, numbers, periods, scalars };
}

function formatter(series: Series[], currency?: string) {
  const allMoney = series.every((s) => s.kind === 'money' || s.kind === undefined);
  return (s: Series | number) => {
    const v = typeof s === 'number' ? s : s.value;
    const kind = typeof s === 'number' ? (allMoney ? 'money' : 'number') : s.kind ?? 'money';
    if (kind === 'money' && currency) return formatMoney(Math.round(v * 100), currency as Currency, 'compact');
    if (kind === 'percent') return `${formatDec(decFromNumber(v) ?? 0n, 2)}%`;
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v);
  };
}

function LineChart({ series, fmt }: { series: Series[]; fmt: (s: Series | number) => string }) {
  const groups = new Map<string, Series[]>();
  for (const s of series) groups.set(s.group ?? 'value', [...(groups.get(s.group ?? 'value') ?? []), s]);
  const xs = [...new Set(series.map((s) => s.label.replace(/ · (receitas|despesas)$/, '')))];
  const W = 300, H = 130, P = 8;
  const vals = series.map((s) => s.value);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = max - min || 1;
  const x = (i: number) => P + (xs.length <= 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (xs.length - 1));
  const y = (v: number) => P + ((max - v) / span) * (H - 2 * P);
  return (
    <div data-testid="chart-line">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="#2e405a" strokeWidth={1} />
        {[...groups.entries()].map(([g, list]) => {
          const color = g === 'income' ? INCOME : g === 'expense' ? EXPENSE : list[0].color;
          const pts = list.map((s) => [x(xs.indexOf(s.label.replace(/ · (receitas|despesas)$/, ''))), y(s.value)] as const);
          return (
            <g key={g}>
              <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
              {pts.map((p, k) => <circle key={k} cx={p[0]} cy={p[1]} r={3} fill={color}><title>{`${list[k].label}: ${fmt(list[k])}`}</title></circle>)}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-soft">{xs.map((l) => <span key={l} className="truncate">{l}</span>)}</div>
    </div>
  );
}

export const chartPlugin: WidgetPlugin<ChartData> = {
  id: WIDGET.chart,
  name: 'Gráfico',
  description: 'Visualiza dados recebidos por conexões de dados (Finanças, meses, fórmulas, valores).',
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
    // Ciclo 4: meses, resultados de fórmula e Value Tiles. Depois das antigas: conexões legadas não mudam.
    { id: 'series', label: 'Séries (meses e valores)', type: 'finance.period', accepts: ['money', 'number', 'percent', 'scalar'] },
  ],
  outputs: [],
  createData: () => ({ mode: 'categories', chartType: 'bar' }),
  sanitize: sanitizeChart,
  summarize: (d, el) => {
    const { ledgers, numbers, periods, scalars } = readInputs(currentFlow(el.id).inputs);
    const { series, currency } = buildSeries(d, ledgers, numbers, { periods, scalars });
    const fmt = formatter(series, currency);
    return `Gráfico (${d.mode}, ${d.chartType}).${series.length ? ' ' + series.map((s) => `${s.label}: ${fmt(s)}`).join('; ') + '.' : ''}`;
  },
  Component: function Chart({ data, update, inputs }) {
    const { ledgers, numbers, periods, scalars } = readInputs(inputs);
    const { series, currency, warning } = buildSeries(data, ledgers, numbers, { periods, scalars });
    const fmt = formatter(series, currency);
    const max = Math.max(1, ...series.map((s) => Math.abs(s.value)));
    const total = series.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
    const empty = !ledgers.length && !numbers.length && !periods.length && !scalars.length;

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
          <Segmented
            value={data.chartType}
            onChange={(chartType) => update({ chartType })}
            options={[{ value: 'bar', label: 'Barras' }, { value: 'line', label: 'Linha' }, { value: 'donut', label: 'Rosca' }, { value: 'kpi', label: 'Números' }]}
          />
        </div>
        {empty ? (
          <div className="flex-1 grid place-items-center text-center text-[12px] text-soft px-4">
            Conecte blocos de Finanças, meses, fórmulas ou valores a este gráfico com uma conexão do tipo “Dados”.
          </div>
        ) : !series.length ? (
          <div className="text-[12px] text-soft">Sem valores para este modo.</div>
        ) : data.chartType === 'kpi' ? (
          <div className="grid grid-cols-2 gap-2" data-testid="chart-kpis">
            {series.map((s) => (
              <div key={s.label} className="rounded-lg border border-line p-2">
                <div className="text-[10px] text-soft truncate">{s.label}</div>
                <div className={`text-[16px] font-bold ${s.value < 0 ? 'text-danger' : 'text-fg'}`}>{fmt(s)}</div>
              </div>
            ))}
          </div>
        ) : data.chartType === 'line' ? (
          <LineChart series={series} fmt={fmt} />
        ) : data.chartType === 'bar' ? (
          <div className="flex flex-col gap-1.5" data-testid="chart-bars">
            {series.map((s) => (
              <div key={s.label} className="text-[11px]" data-series={s.label}>
                <div className="flex justify-between text-fg-2"><span className="truncate">{s.label}</span><span className={s.value < 0 ? 'text-danger' : ''}>{fmt(s)}</span></div>
                <div className="h-2.5 rounded bg-panel-3 overflow-hidden">
                  <div className="h-full rounded" style={{ width: `${(Math.abs(s.value) / max) * 100}%`, background: s.value < 0 ? EXPENSE : s.color }} />
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
  /** Exportação: barras (ou linha de valores) desenhadas em SVG com os mesmos números da tela. */
  exportSVG: (d, el) => {
    const { ledgers, numbers, periods, scalars } = readInputs(currentFlow(el.id).inputs);
    const { series, currency, warning } = buildSeries(d, ledgers, numbers, { periods, scalars });
    const fmt = formatter(series, currency);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const font = `font-family='"Inter Variable", "Inter", system-ui, sans-serif'`;
    const w = el.width, h = el.height, pad = 14;
    let out = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="#131d2c" stroke="#2e405a"/>`;
    out += `<text x="${pad}" y="${pad + 12}" font-size="13" font-weight="700" fill="#edf3fc" ${font}>${esc(el.title)}</text>`;
    const max = Math.max(1, ...series.map((s) => Math.abs(s.value)));
    let y = pad + 34;
    const rowH = 28;
    for (const s of series) {
      if (y + rowH > h - pad - (warning ? 14 : 0)) break;
      const val = fmt(s);
      const vw = measureLine(val, { fontFamily: 'sans', fontSize: 11 });
      out += `<text x="${pad}" y="${y}" font-size="11" fill="#c5d3e6" ${font}>${esc(s.label)}</text>`;
      out += `<text x="${w - pad}" y="${y}" font-size="11" font-weight="600" text-anchor="end" fill="${s.value < 0 ? EXPENSE : '#edf3fc'}" ${font}>${esc(val)}</text>`;
      out += `<rect x="${pad}" y="${y + 5}" width="${w - pad * 2}" height="8" rx="3" fill="#1f2e44"/>`;
      out += `<rect x="${pad}" y="${y + 5}" width="${Math.max(2, ((w - pad * 2) * Math.abs(s.value)) / max)}" height="8" rx="3" fill="${s.value < 0 ? EXPENSE : s.color}"/>`;
      y += rowH;
      void vw;
    }
    if (!series.length) out += `<text x="${pad}" y="${y}" font-size="11" fill="#8ea3bf" ${font}>Sem dados conectados.</text>`;
    if (warning) out += `<text x="${pad}" y="${h - pad}" font-size="10" fill="#f3c577" ${font}>${esc('⚠ ' + warning)}</text>`;
    return out;
  },
};
