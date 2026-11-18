import { useMemo, useState } from 'react';
import { CircleDollarSign, Trash2 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import {
  computeFinance,
  emptyFinance,
  formatMoney,
  parseMoney,
  sanitizeFinance,
  type Currency,
  type FinanceData,
  type FinanceEntry,
  type FinanceSummary,
  type MoneyFormat,
} from '../../core/finance';
import { WIDGET } from '../../core/widgetIds';
import { uid } from '../../core/elements';
import { Empty } from '../../ui/primitives';
import type { InputValue } from '../../core/dataflow';

export interface LedgerValue {
  source: string;
  currency: Currency;
  summary: FinanceSummary;
  byCategory: { category: string; incomeCents: number; expenseCents: number }[];
}

function summariesFrom(inputs: InputValue[] | undefined): FinanceSummary[] {
  return (inputs ?? []).map((v) => v.value as FinanceSummary).filter((v) => v && typeof v.balanceCents === 'number');
}

function months(data: FinanceData): string[] {
  const set = new Set<string>();
  for (const e of data.entries) {
    if (!e.date) continue;
    const n = Math.max(1, e.installments);
    const [y, m] = e.date.split('-').map(Number);
    for (let i = 0; i < n; i++) {
      const mm = m - 1 + i;
      set.add(`${y + Math.floor(mm / 12)}-${String((mm % 12) + 1).padStart(2, '0')}`);
    }
  }
  return [...set].sort();
}

function monthLabel(p: string) {
  const [y, m] = p.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
}

export const financePlugin: WidgetPlugin<FinanceData> = {
  id: WIDGET.finance,
  name: 'Finanças',
  description: 'Receitas, despesas, categorias, vencimentos e parcelas, com saldo calculado.',
  icon: CircleDollarSign,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#5addaa',
  permissions: [],
  defaultSize: { width: 360, height: 420 },
  inputs: [{ id: 'in', label: 'Saldo recebido', type: 'finance.summary' }],
  outputs: [
    { id: 'summary', label: 'Resumo (saldo)', type: 'finance.summary' },
    { id: 'ledger', label: 'Lançamentos', type: 'finance.ledger' },
    { id: 'balance', label: 'Saldo (número)', type: 'number' },
  ],
  createData: () => emptyFinance('BRL'),
  sanitize: sanitizeFinance,
  compute: (d, inputs, el) => {
    const r = computeFinance(d, summariesFrom(inputs.in), el.title);
    const ledger: LedgerValue = { source: el.title, currency: d.currency, summary: r.summary, byCategory: r.byCategory };
    return { summary: r.summary, ledger, balance: r.summary.balanceCents / 100 };
  },
  summarize: (d, el) => {
    const r = computeFinance(d, [], el.title);
    const f = (c: number) => formatMoney(c, d.currency);
    return [
      `Moeda ${d.currency}; período ${d.period === 'all' ? 'todos' : d.period}.`,
      `Receitas ${f(r.summary.incomeCents)}; despesas ${f(r.summary.expenseCents)}; saldo (sem entradas conectadas) ${f(r.summary.balanceCents)}.`,
      ...r.occurrences.slice(0, 60).map((o) => `${o.kind === 'income' ? '+' : '-'} ${o.description} ${f(o.amountCents)} [${o.category}]${o.date ? ` venc. ${o.date}` : ''}${o.count > 1 ? ` (${o.index}/${o.count})` : ''}${o.paid ? ' pago' : ''}`),
    ].join('\n');
  },
  Component: function Finance({ data, update, inputs, element }) {
    const report = useMemo(() => computeFinance(data, summariesFrom(inputs.in), element.title), [data, inputs.in, element.title]);
    const [adding, setAdding] = useState(false);
    const [view, setView] = useState<'list' | 'categories'>('list');
    const fmt = (c: number) => formatMoney(c, data.currency, data.format);
    const s = report.summary;
    const monthList = months(data);

    return (
      <div className="flex flex-col gap-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Saldo previsto</div>
          <div data-testid="finance-balance" className={`text-[26px] font-bold tracking-tight leading-tight ${s.balanceCents < 0 ? 'text-danger' : 'text-[#d9f3e7]'}`}>
            {fmt(s.balanceCents)}
          </div>
          <div className="grid grid-cols-3 gap-1.5 mt-1.5 text-[11px]">
            <Stat label="Receitas" value={fmt(s.incomeCents)} cls="text-ok" testid="finance-income" />
            <Stat label="Despesas" value={fmt(s.expenseCents)} cls="text-danger" testid="finance-expense" />
            <Stat label="Realizado" value={fmt(s.realizedCents)} cls="text-fg-2" testid="finance-realized" />
          </div>
          {report.inputs.length > 0 && (
            <div className="mt-1.5 text-[11px] text-ok">
              {report.inputs.map((i) => (
                <div key={i.source}>⇢ Recebido de “{i.source}”: {fmt(i.cents)}</div>
              ))}
            </div>
          )}
          {report.warnings.map((w) => (
            <div key={w} className="mt-1 text-[11px] text-warn">⚠ {w}</div>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          <select aria-label="Período" value={data.period} onChange={(e) => update({ period: e.target.value })} className="h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px]">
            <option value="all">Todo o período</option>
            {monthList.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            <option value={new Date().toISOString().slice(0, 7)}>Mês atual</option>
          </select>
          <select aria-label="Moeda" value={data.currency} onChange={(e) => update({ currency: e.target.value as Currency })} className="h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px]">
            <option value="BRL">BRL</option><option value="USD">USD</option><option value="EUR">EUR</option>
          </select>
          <select aria-label="Formato" value={data.format} onChange={(e) => update({ format: e.target.value as MoneyFormat })} className="h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px]">
            <option value="currency">R$ 1.234,56</option><option value="compact">Compacto</option><option value="plain">1.234,56</option>
          </select>
          <button className={`h-7 px-2 rounded-md border text-[11px] ${view === 'categories' ? 'border-accent text-accent' : 'border-line text-muted'}`} onClick={() => setView(view === 'list' ? 'categories' : 'list')}>
            {view === 'list' ? 'Por categoria' : 'Lançamentos'}
          </button>
        </div>

        {view === 'categories' ? (
          <div className="flex flex-col gap-1">
            {report.byCategory.map((c) => (
              <div key={c.category} className="flex justify-between text-[12px] border-b border-line/50 py-1">
                <span>{c.category}</span>
                <span>
                  {c.incomeCents > 0 && <span className="text-ok mr-2">+{fmt(c.incomeCents)}</span>}
                  {c.expenseCents > 0 && <span className="text-danger">−{fmt(c.expenseCents)}</span>}
                </span>
              </div>
            ))}
            {!report.byCategory.length && <Empty>Sem lançamentos no período.</Empty>}
          </div>
        ) : (
          <ul className="flex flex-col" data-testid="finance-entries">
            {report.occurrences.map((o) => (
              <li key={`${o.entryId}-${o.index}`} className="group flex items-center gap-2 py-1.5 border-b border-line/50 text-[12px]">
                <input
                  type="checkbox"
                  title="Pago / recebido"
                  aria-label="Pago"
                  checked={o.paid}
                  disabled={o.count > 1 && o.index > 1}
                  onChange={(e) => update((d) => ({ ...d, entries: d.entries.map((x) => (x.id === o.entryId ? { ...x, paid: e.target.checked } : x)) }))}
                  className="accent-ok"
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-fg">{o.description || '(sem descrição)'}{o.count > 1 && <span className="text-soft"> · {o.index}/{o.count}</span>}</div>
                  <div className="text-[10px] text-soft truncate">{o.category}{o.date ? ` · ${o.date.split('-').reverse().join('/')}` : ''}</div>
                </div>
                <strong className={`whitespace-nowrap ${o.kind === 'income' ? 'text-ok' : 'text-danger'}`}>{o.kind === 'income' ? '+' : '−'}{fmt(o.amountCents)}</strong>
                <button aria-label="Remover lançamento" className="text-soft hover:text-danger opacity-0 group-hover:opacity-100" onClick={() => update((d) => ({ ...d, entries: d.entries.filter((x) => x.id !== o.entryId) }))}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
            {!report.occurrences.length && <Empty>Nenhum lançamento {data.period !== 'all' ? 'neste período' : 'ainda'}.</Empty>}
          </ul>
        )}

        {adding ? (
          <EntryForm
            onCancel={() => setAdding(false)}
            onSave={(entry) => {
              update((d) => ({ ...d, entries: [...d.entries, entry] }));
              setAdding(false);
            }}
          />
        ) : (
          <button data-testid="finance-add" onClick={() => setAdding(true)} className="h-8 rounded-lg border border-dashed border-line text-accent text-xs hover:bg-panel-3">＋ Lançamento</button>
        )}
      </div>
    );
  },
};

function Stat({ label, value, cls, testid }: { label: string; value: string; cls: string; testid: string }) {
  return (
    <div className="rounded-md bg-[#0f1826] border border-line/60 px-1.5 py-1 min-w-0">
      <div className="text-[9px] uppercase text-soft font-bold">{label}</div>
      <div className={`truncate font-semibold ${cls}`} data-testid={testid}>{value}</div>
    </div>
  );
}

function EntryForm({ onSave, onCancel }: { onSave: (e: FinanceEntry) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<'income' | 'expense'>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [date, setDate] = useState('');
  const [installments, setInstallments] = useState(1);
  const [mode, setMode] = useState<'split' | 'repeat'>('split');
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState('');
  const submit = () => {
    const cents = parseMoney(amount);
    if (!description.trim()) return setError('Informe a descrição.');
    if (cents === null || cents === 0) return setError('Valor inválido. Ex.: 1.234,56');
    if (installments > 1 && !date) return setError('Parcelas exigem a data do primeiro vencimento.');
    onSave({
      id: uid(),
      description: description.trim(),
      // Valor negativo digitado vira despesa automaticamente.
      kind: cents < 0 ? 'expense' : kind,
      amountCents: Math.abs(cents),
      category: category.trim(),
      date,
      paid,
      installments: Math.max(1, Math.min(360, installments)),
      installmentMode: mode,
    });
  };
  const input = 'h-8 px-2 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[12px] min-w-0';
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2 bg-panel" onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}>
      <div className="flex gap-1">
        {(['income', 'expense'] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={`flex-1 h-7 rounded-md border text-[11px] font-semibold ${kind === k ? (k === 'income' ? 'border-ok text-ok bg-ok/10' : 'border-danger text-danger bg-danger/10') : 'border-line text-muted'}`}>
            {k === 'income' ? 'Receita' : 'Despesa'}
          </button>
        ))}
      </div>
      <input autoFocus data-testid="finance-desc" className={input} placeholder="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid grid-cols-2 gap-1.5">
        <input data-testid="finance-amount" className={input} inputMode="decimal" placeholder="Valor (ex.: 1.234,56)" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input className={input} placeholder="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} />
        <input className={input} type="date" aria-label="Vencimento" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="flex items-center gap-1">
          <input className={`${input} w-14`} type="number" min={1} max={360} aria-label="Parcelas" value={installments} onChange={(e) => setInstallments(Number(e.target.value) || 1)} />
          <span className="text-[11px] text-muted">parcela(s)</span>
        </div>
      </div>
      {installments > 1 && (
        <select className={input} value={mode} onChange={(e) => setMode(e.target.value as 'split' | 'repeat')}>
          <option value="split">Valor total dividido em {installments} parcelas</option>
          <option value="repeat">Valor por parcela ({installments}×)</option>
        </select>
      )}
      <label className="flex items-center gap-1.5 text-[11px] text-muted">
        <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="accent-ok" /> Já pago / recebido
      </label>
      {error && <div className="text-[11px] text-danger">{error}</div>}
      <div className="flex justify-end gap-1.5">
        <button onClick={onCancel} className="h-7 px-2 text-[11px] text-muted hover:text-fg">Cancelar</button>
        <button data-testid="finance-save" onClick={submit} className="h-7 px-3 rounded-md bg-[#3174db] text-white text-[11px] font-semibold">Adicionar</button>
      </div>
    </div>
  );
}
