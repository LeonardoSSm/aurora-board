/** Month Tile (`aurora.finance-period`): competência financeira que soma os valores conectados. */
import { useMemo } from 'react';
import { CalendarRange } from 'lucide-react';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import type { WidgetPlugin } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney } from '../../core/finance';
import { computePeriod, PERIOD_SIZES, sanitizePeriod, type FinancePeriodData, type PeriodReport } from '../../core/financePeriod';
import { CURRENCIES, currentPeriod, moneyValue, percentValue, periodLabel, shiftPeriod } from '../../core/scalar';
import { formatDec, parseDec } from '../../core/decimal';
import { CARD_FG, type CardModel } from '../../core/financeCard';
import { createWidget } from '../../core/elements';
import { ISSUES_KEY, type InputValue } from '../../core/dataflow';
import { addElements, openWidgetInspector } from '../../store/actions';
import { getState } from '../../store/editor';
import { Button, Field, Label, Segmented, Select } from '../../ui/primitives';
import { CardView, cardSVG, currentFlow, MODE_OPTIONS, patchWidget } from './financeShared';
import type { TileDisplayMode } from '../../core/valueTile';

const REPORT_KEY = '$report';

function periodInputs(inputs: Record<string, InputValue[]>) {
  return [...(inputs.occurrences ?? []), ...(inputs.entries ?? [])].map((i) => ({ value: i.value, edgeId: i.edgeId, sourceId: i.sourceId, sourceTitle: i.sourceTitle }));
}

export function commitmentText(c: string | null): string {
  if (c === null) return '— (sem receitas)';
  return `${formatDec((parseDec(c) ?? 0n) * 100n, 2)}%`;
}

export function periodModel(el: WidgetElement, d: FinancePeriodData, r: PeriodReport): CardModel {
  const s = r.summary;
  const f = (c: number) => formatMoney(c, d.currency);
  const rows: CardModel['rows'] = [];
  if (d.showIncome) rows.push({ label: 'Receitas', value: f(s.incomeCents), color: '#5addaa', role: 'income' });
  if (d.showExpenses) rows.push({ label: 'Despesas', value: f(s.expenseCents), color: '#fb8590', role: 'expenses' });
  if (d.showCommitment) rows.push({ label: 'Comprometido', value: commitmentText(s.commitment), role: 'commitment' });
  if (d.displayMode === 'detailed') {
    rows.push({ label: 'Lançamentos', value: String(s.count), role: 'count' });
    if (s.neutralCents) rows.push({ label: 'Neutros (fora do saldo)', value: f(s.neutralCents) });
    if (d.showCategories) for (const c of s.byCategory.slice(0, 4)) rows.push({ label: `· ${c.category}`, value: f(c.expenseCents || c.incomeCents), color: c.expenseCents ? '#fb8590' : '#5addaa' });
  }
  const issue = r.issues[0];
  return {
    title: el.title,
    value: d.displayMode === 'compact' ? `${periodLabel(d.period, 'short')} · ${f(s.balanceCents)}` : f(s.balanceCents),
    valueColor: s.balanceCents < 0 ? '#fb8590' : CARD_FG,
    caption: d.showBalance ? (s.count ? 'Saldo previsto' : 'Saldo · conecte valores com uma conexão de Dados') : undefined,
    rows,
    accent: '#f3c577',
    status: issue ? { text: r.issues.length > 1 ? `⚠ ${r.issues.length} avisos — ${issue.message}` : `⚠ ${issue.message}`, color: '#f3c577' } : undefined,
    valueRole: 'balance',
  };
}

function reportOf(el: WidgetElement, d: FinancePeriodData, outputs: Record<string, unknown>): PeriodReport {
  return (outputs[REPORT_KEY] as PeriodReport | undefined) ?? computePeriod(d, [], el.title);
}

/** Cria meses ao lado (anterior/seguinte/sequência), livres para mover depois. */
export function createMonths(id: string, offsets: number[]) {
  const src = getState().elements.find((e) => e.id === id);
  if (!src || src.type !== 'widget') return;
  const d = sanitizePeriod(src.data);
  const gap = 24;
  const made: AuroraElement[] = offsets.map((o, i) => {
    const period = shiftPeriod(d.period, o);
    const col = offsets.length > 1 ? i % 6 : 0, row = offsets.length > 1 ? Math.floor(i / 6) : 0;
    const x = o < 0 && offsets.length === 1 ? src.x - src.width - gap : src.x + (src.width + gap) * (col + 1);
    const el = createWidget(WIDGET.financePeriod, '1.0.0', periodLabel(period), x, src.y + row * (src.height + gap), src.width, src.height, { ...d, period });
    el.style.strokeColor = '#f3c577';
    return el;
  });
  addElements(made, true);
}

function Inspector({ element, data }: { element: WidgetElement; data: FinancePeriodData }) {
  const id = element.id;
  const set = (p: Partial<FinancePeriodData>) =>
    patchWidget(id, (r) => sanitizePeriod(r), (cur, el) => {
      const next = { ...cur, ...p };
      // Título automático acompanha a troca de mês; título personalizado é preservado.
      const auto = el.title === periodLabel(cur.period) || !el.title.trim();
      return { data: p, title: auto && next.period !== cur.period ? periodLabel(next.period) : undefined };
    });
  const [y, m] = data.period.split('-');
  const flow = currentFlow(id);
  const r = reportOf(element, data, flow.outputs);
  return (
    <div className="flex flex-col text-[12px]" data-testid="period-inspector">
      <Label>Competência</Label>
      <div className="flex gap-1.5">
        <Select aria-label="Mês" value={m} onChange={(e) => set({ period: `${y}-${e.target.value}` })} className="flex-1">
          {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((mm) => <option key={mm} value={mm}>{periodLabel(`2000-${mm}`).replace(' 2000', '')}</option>)}
        </Select>
        <Field aria-label="Ano" type="number" min={1900} max={2200} value={y} onChange={(e) => /^\d{4}$/.test(e.target.value) && set({ period: `${e.target.value}-${m}` })} className="!w-20" />
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Button onClick={() => createMonths(id, [-1])}>‹ Mês anterior</Button>
        <Button onClick={() => createMonths(id, [1])}>Mês seguinte ›</Button>
        <Button onClick={() => createMonths(id, Array.from({ length: 11 }, (_, i) => i + 1))} title="Cria os próximos 11 meses (total de 12) ao lado">+ 12 meses</Button>
      </div>
      <Label>Moeda</Label>
      <Segmented label="Moeda do mês" value={data.currency} onChange={(c) => set({ currency: c })} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
      <Label>Modo visual</Label>
      <Segmented<TileDisplayMode> label="Modo visual" value={data.displayMode} onChange={(mode) => patchWidget(id, (x) => sanitizePeriod(x), () => ({ data: { displayMode: mode }, size: PERIOD_SIZES[mode] }))} options={MODE_OPTIONS} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px] text-fg-2">
        {([['showIncome', 'Receitas'], ['showExpenses', 'Despesas'], ['showBalance', 'Saldo'], ['showCommitment', 'Comprometido'], ['showCategories', 'Categorias']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={data[k]} onChange={(e) => set({ [k]: e.target.checked })} /> {label}</label>
        ))}
      </div>
      <Label>Lançamentos considerados ({r.entries.length})</Label>
      {r.entries.length === 0 ? (
        <div className="text-[11px] text-soft">Conecte Valores (ou um bloco Finanças) a este mês com uma conexão do tipo Dados.</div>
      ) : (
        <ul className="text-[11px] flex flex-col gap-0.5" data-testid="period-entries">
          {r.entries.map((e) => (
            <li key={e.key} className="flex justify-between gap-2">
              <span className="truncate">{e.label}</span>
              <span className={e.role === 'income' ? 'text-ok' : e.role === 'expense' ? 'text-danger' : 'text-soft'}>{e.role === 'expense' ? '−' : e.role === 'income' ? '+' : ''}{formatMoney(e.cents, data.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {r.issues.length > 0 && (
        <ul className="mt-2 text-[11px] text-warn flex flex-col gap-0.5" data-testid="period-issues">
          {r.issues.map((i, k) => <li key={k}>⚠ {i.message}</li>)}
        </ul>
      )}
    </div>
  );
}

export const financePeriodPlugin: WidgetPlugin<FinancePeriodData> = {
  id: WIDGET.financePeriod,
  name: 'Mês financeiro',
  description: 'Competência (mês) que soma receitas e despesas conectadas e calcula saldo e comprometimento.',
  icon: CalendarRange,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#f3c577',
  permissions: [],
  defaultSize: PERIOD_SIZES.normal,
  inputs: [
    { id: 'occurrences', label: 'Lançamentos (Finanças)', type: 'finance.occurrences' },
    { id: 'entries', label: 'Valores', type: 'money', accepts: ['scalar'] },
  ],
  outputs: [
    { id: 'summary', label: 'Resumo do mês', type: 'finance.period' },
    { id: 'balance', label: 'Saldo', type: 'money' },
    { id: 'income', label: 'Receitas', type: 'money' },
    { id: 'expenses', label: 'Despesas', type: 'money' },
    { id: 'commitment', label: 'Comprometimento', type: 'percent' },
  ],
  frame: 'bare',
  librarySection: 'Finanças visuais',
  hideInLibrary: true,
  presets: [{ id: 'current', name: 'Mês', description: 'Competência do mês atual (troque no painel).', icon: CalendarRange, keywords: ['mês', 'período', 'competência', 'finanças'], data: sanitizePeriod({ period: currentPeriod() }), size: PERIOD_SIZES.normal, title: periodLabel(currentPeriod()) }],
  createData: () => sanitizePeriod({ period: currentPeriod() }),
  sanitize: (raw) => sanitizePeriod(raw, currentPeriod()),
  compute: (d, inputs, el) => {
    const r = computePeriod(d, periodInputs(inputs), el.title);
    const s = r.summary;
    const meta = (k: string, role: 'income' | 'expense' | 'neutral', label: string) => ({ role, key: `${el.id}:${k}`, label: `${label} · ${el.title}`, period: d.period });
    return {
      summary: s,
      balance: moneyValue(s.balanceCents, d.currency, meta('balance', 'neutral', 'Saldo')),
      income: moneyValue(s.incomeCents, d.currency, meta('income', 'income', 'Receitas')),
      expenses: moneyValue(s.expenseCents, d.currency, meta('expenses', 'expense', 'Despesas')),
      commitment: s.commitment === null ? undefined : percentValue(parseDec(s.commitment) ?? 0n),
      [ISSUES_KEY]: r.issues,
      [REPORT_KEY]: r,
    };
  },
  summarize: (d, el) => {
    const { outputs } = currentFlow(el.id);
    const s = reportOf(el, d, outputs).summary;
    const f = (c: number) => formatMoney(c, d.currency);
    return `${el.title} (${d.period}): receitas ${f(s.incomeCents)}, despesas ${f(s.expenseCents)}, saldo ${f(s.balanceCents)}, comprometido ${commitmentText(s.commitment)}.`;
  },
  Component: function PeriodTile({ element, data, outputs, selected }) {
    const r = reportOf(element, data, outputs);
    const model = useMemo(() => periodModel(element, data, r), [element, data, r]);
    return <CardView element={element} model={model} mode={data.displayMode} selected={selected} testid="period-tile" />;
  },
  Inspector: ({ element, data }) => <Inspector element={element} data={data} />,
  onDoubleClick: (el) => openWidgetInspector(el.id),
  menuItems: (el) => [
    { id: 'edit', label: 'Editar mês', run: () => openWidgetInspector(el.id) },
    { id: 'next', label: 'Criar mês seguinte', run: () => createMonths(el.id, [1]) },
    { id: 'prev', label: 'Criar mês anterior', run: () => createMonths(el.id, [-1]) },
    { id: 'year', label: 'Gerar próximos 11 meses', run: () => createMonths(el.id, Array.from({ length: 11 }, (_, i) => i + 1)) },
  ],
  exportSVG: (d, el) => cardSVG(periodModel(el, d, reportOf(el, d, currentFlow(el.id).outputs)), el, d.displayMode),
};
