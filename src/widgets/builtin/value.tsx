/** Value Tile (`aurora.value`): bloco pequeno de dinheiro, número ou porcentagem, editável no próprio quadro. */
import { useEffect, useMemo, useState } from 'react';
import { Coins, Hash, Percent, TrendingDown, TrendingUp } from 'lucide-react';
import type { WidgetElement } from '../../core/schema';
import type { WidgetPlugin } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import {
  createValueData,
  formatValueTile,
  parseValueInput,
  ROLE_COLORS,
  sanitizeValue,
  valueEditText,
  valueOutput,
  VALUE_SIZES,
  VALUE_TYPE_LABEL,
  type TileDisplayMode,
  type ValueTileData,
} from '../../core/valueTile';
import { CURRENCIES, periodLabel, ROLE_LABEL, type FinancialRole } from '../../core/scalar';
import type { CardModel } from '../../core/financeCard';
import { CARD_FG } from '../../core/financeCard';
import { setWidgetEditing } from '../../store/actions';
import { Field, Label, Segmented, Select } from '../../ui/primitives';
import { CardView, cardSVG, InlineEditor, inlineInput, MODE_OPTIONS, patchWidget, useIsEditing } from './financeShared';

export function valueModel(el: WidgetElement, d: ValueTileData): CardModel {
  const isMoney = d.valueType === 'money';
  const roleColor = isMoney ? ROLE_COLORS[d.financialRole] : '#8fb4ff';
  const caption = isMoney
    ? [ROLE_LABEL[d.financialRole], d.category, d.period ? periodLabel(d.period, 'short') : ''].filter(Boolean).join(' · ')
    : VALUE_TYPE_LABEL[d.valueType];
  const rows = d.displayMode === 'detailed'
    ? [
        ...(isMoney ? [{ label: 'Moeda', value: d.currency }] : []),
        ...(isMoney ? [{ label: 'Competência', value: d.period ? periodLabel(d.period, 'short') : 'Do mês conectado' }] : []),
        ...(d.note ? [{ label: 'Obs.', value: d.note }] : []),
      ]
    : [];
  return {
    title: el.title,
    value: formatValueTile(d),
    valueColor: isMoney && d.financialRole !== 'neutral' ? roleColor : CARD_FG,
    caption: d.displayMode === 'compact' ? undefined : caption,
    rows,
    accent: d.accentColor || roleColor,
    valueRole: 'value',
  };
}

function setRole(id: string, role: FinancialRole, d: ValueTileData) {
  patchWidget(id, sanitizeValue, () => ({ data: { financialRole: role, amountCents: Math.abs(d.amountCents), valueType: 'money' as const } }));
}

function ValueEditor({ element, data }: { element: WidgetElement; data: ValueTileData }) {
  const [title, setTitle] = useState(element.title);
  const [text, setText] = useState(() => valueEditText(data));
  const [error, setError] = useState('');
  const commit = () => {
    const r = parseValueInput(text, data);
    if (!r.ok) { setError(r.error); return false; }
    patchWidget(element.id, sanitizeValue, () => ({ data: r.patch, title: title.trim() || element.title }));
    return true;
  };
  return (
    <InlineEditor onCommit={commit}>
      <input aria-label="Nome do valor" className={inlineInput} value={title} placeholder="Nome (ex.: Salário)" onChange={(e) => setTitle(e.target.value)} />
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-soft w-9 shrink-0 text-right">{data.valueType === 'money' ? data.currency : data.valueType === 'percentage' ? '%' : '#'}</span>
        <input
          aria-label="Valor"
          autoFocus
          inputMode="decimal"
          className={`${inlineInput} font-semibold tabular-nums`}
          value={text}
          onFocus={(e) => e.target.select()}
          onChange={(e) => { setText(e.target.value); setError(''); }}
        />
      </div>
      {data.valueType === 'money' && (
        <div className="flex gap-1" role="radiogroup" aria-label="Classificação">
          {(['income', 'expense', 'neutral'] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={data.financialRole === r}
              onClick={() => setRole(element.id, r, data)}
              className={`flex-1 h-6 rounded border text-[11px] ${data.financialRole === r ? 'border-accent text-fg bg-[#2c3a6e]' : 'border-line text-soft'}`}
            >
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      {error ? <div className="text-[11px] text-danger" role="alert">{error}</div> : <div className="text-[10px] text-soft">Enter confirma · Esc cancela</div>}
    </InlineEditor>
  );
}

function Inspector({ element, data }: { element: WidgetElement; data: ValueTileData }) {
  const id = element.id;
  const set = (p: Partial<ValueTileData>, key?: string) => patchWidget(id, sanitizeValue, () => ({ data: p }), key ? `value:${key}:${id}` : undefined);
  const [text, setText] = useState(() => valueEditText(data));
  const [error, setError] = useState('');
  useEffect(() => setText(valueEditText(data)), [data.amountCents, data.numericValue, data.valueType]); // eslint-disable-line react-hooks/exhaustive-deps
  const [y, m] = data.period ? data.period.split('-') : ['', ''];
  return (
    <div className="flex flex-col text-[12px]" data-testid="value-inspector">
      <Label>Valor</Label>
      <Field
        aria-label="Valor no painel"
        value={text}
        inputMode="decimal"
        onChange={(e) => { setText(e.target.value); setError(''); }}
        onBlur={() => { const r = parseValueInput(text, data); if (r.ok) set(r.patch); else setError(r.error); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {error && <div className="text-[11px] text-danger mt-1">{error}</div>}
      <Label>Tipo</Label>
      <Segmented label="Tipo do valor" value={data.valueType} onChange={(v) => set({ valueType: v })} options={[{ value: 'money', label: 'Dinheiro' }, { value: 'number', label: 'Número' }, { value: 'percentage', label: '%' }]} />
      {data.valueType === 'money' && (
        <>
          <Label>Classificação</Label>
          <Segmented label="Classificação financeira" value={data.financialRole} onChange={(r) => setRole(id, r, data)} options={(['income', 'expense', 'neutral'] as const).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          <Label>Moeda</Label>
          <Segmented label="Moeda" value={data.currency} onChange={(c) => set({ currency: c })} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          <Label>Competência (opcional)</Label>
          <div className="flex gap-1.5 items-center">
            <Select aria-label="Mês da competência" value={m} onChange={(e) => set({ period: e.target.value ? `${y || new Date().getFullYear()}-${e.target.value}` : '' })}>
              <option value="">Do mês conectado</option>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((mm) => <option key={mm} value={mm}>{periodLabel(`2000-${mm}`).replace(' 2000', '')}</option>)}
            </Select>
            {data.period && <Field aria-label="Ano da competência" type="number" min={1900} max={2200} value={y} onChange={(e) => /^\d{4}$/.test(e.target.value) && set({ period: `${e.target.value}-${m}` })} className="!w-20" />}
          </div>
          <Label>Categoria</Label>
          <Field aria-label="Categoria" value={data.category} placeholder="Ex.: Moradia" onChange={(e) => set({ category: e.target.value }, 'cat')} onKeyDown={(e) => e.stopPropagation()} />
        </>
      )}
      <Label>Observação</Label>
      <Field aria-label="Observação" value={data.note} onChange={(e) => set({ note: e.target.value }, 'note')} onKeyDown={(e) => e.stopPropagation()} />
      <Label>Modo visual</Label>
      <Segmented<TileDisplayMode> label="Modo visual" value={data.displayMode} onChange={(mode) => patchWidget(id, sanitizeValue, () => ({ data: { displayMode: mode }, size: VALUE_SIZES[mode] }))} options={MODE_OPTIONS} />
      <Label>Cor de destaque</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label="Cor de destaque" value={data.accentColor || (data.valueType === 'money' ? ROLE_COLORS[data.financialRole] : '#8fb4ff')} onChange={(e) => set({ accentColor: e.target.value }, 'accent')} className="w-8 h-8 rounded border border-line bg-transparent" />
        {data.accentColor && <button className="text-[11px] text-accent hover:underline" onClick={() => set({ accentColor: '' })}>Padrão</button>}
      </div>
    </div>
  );
}

const preset = (id: string, name: string, icon: typeof Coins, data: Partial<ValueTileData>, description: string) => ({
  id, name, icon, description, keywords: ['valor', 'número', 'dinheiro', 'finanças'], data: createValueData(data), size: VALUE_SIZES.normal, title: name,
});

export const valuePlugin: WidgetPlugin<ValueTileData> = {
  id: WIDGET.value,
  name: 'Valor',
  description: 'Bloco de valor: dinheiro (receita, despesa ou neutro), número ou porcentagem. Duplo clique edita.',
  icon: Coins,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#8fb4ff',
  permissions: [],
  defaultSize: VALUE_SIZES.normal,
  inputs: [],
  outputs: [{ id: 'value', label: 'Valor', type: 'money' }],
  ports: (d) => ({ inputs: [], outputs: [{ id: 'value', label: 'Valor', type: d.valueType === 'money' ? 'money' : d.valueType === 'percentage' ? 'percent' : 'number' }] }),
  frame: 'bare',
  editOnInsert: true,
  librarySection: 'Finanças visuais',
  hideInLibrary: true,
  presets: [
    preset('income', 'Receita', TrendingUp, { financialRole: 'income' }, 'Dinheiro que entra (ex.: salário).'),
    preset('expense', 'Despesa', TrendingDown, { financialRole: 'expense' }, 'Dinheiro que sai (ex.: financiamento).'),
    preset('money', 'Valor', Coins, {}, 'Valor monetário neutro.'),
    preset('number', 'Número', Hash, { valueType: 'number', numericValue: '0' }, 'Número genérico.'),
    preset('percent', 'Porcentagem', Percent, { valueType: 'percentage', numericValue: '0' }, 'Ex.: reserva de 20%.'),
  ],
  createData: () => createValueData(),
  sanitize: sanitizeValue,
  compute: (d, _inputs, el) => ({ value: valueOutput(d, { key: el.id, label: el.title }) }),
  summarize: (d, el) => `${el.title}: ${formatValueTile(d)}${d.valueType === 'money' ? ` (${ROLE_LABEL[d.financialRole].toLowerCase()})` : ''}`,
  Component: function ValueTile({ element, data, selected }) {
    const editing = useIsEditing(element.id);
    const model = useMemo(() => valueModel(element, data), [element, data]);
    return (
      <>
        <CardView element={element} model={model} mode={data.displayMode} selected={selected} testid="value-tile" />
        {editing && <ValueEditor element={element} data={data} />}
      </>
    );
  },
  Inspector: ({ element, data }) => <Inspector element={element} data={data} />,
  onDoubleClick: (el) => setWidgetEditing(el.id),
  menuItems: (el, d) => [
    { id: 'edit', label: 'Editar valor', run: () => setWidgetEditing(el.id) },
    ...(d.valueType === 'money'
      ? (['income', 'expense', 'neutral'] as const).filter((r) => r !== d.financialRole).map((r) => ({ id: `role-${r}`, label: `Marcar como ${ROLE_LABEL[r].toLowerCase()}`, run: () => setRole(el.id, r, d) }))
      : []),
  ],
  exportSVG: (d, el) => cardSVG(valueModel(el, d), el, d.displayMode),
};

