/**
 * Consulta bancária (`aurora.bank-query`) — liga o razão financeiro local ao canvas.
 *
 * Guarda no quadro só a consulta (contas, métrica, categoria, período, apresentação e a autorização de IA).
 * Saídas: `value`/`income`/`expenses` (money, com membros para deduplicação), `occurrences`
 * (finance.occurrences com chaves `bank:tx:<id>`) e `monthly` (finance.periods, para gráficos).
 */
import { useEffect, useMemo } from 'react';
import { Landmark } from 'lucide-react';
import type { WidgetElement } from '../../core/schema';
import type { WidgetPlugin } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney } from '../../core/finance';
import { CURRENCIES, currentPeriod, periodLabel } from '../../core/scalar';
import { CARD_FG, type CardModel } from '../../core/financeCard';
import { ensureFinanceLoaded, getFinance, grantAI, revokeAI, useFinance } from '../../finance/store';
import { DEFAULT_AI_SHARE, METRIC_LABELS, queryOutputs, rangeLabel, runBankQuery, sanitizeBankQuery, type BankMetric, type BankQueryData, type BankQueryResult } from '../../finance/query';
import { buildFinanceAIText, grantKey, shareAuthorized, shareDigest } from '../../finance/aiShare';
import { ACCOUNT_TYPE_LABELS } from '../../finance/model';
import { bumpExternalData } from '../dataflow';
import { Button, Field, Label, Segmented, Select } from '../../ui/primitives';
import { CardView, cardSVG, currentFlow, MODE_OPTIONS, patchWidget } from './financeShared';
import { openFinanceHub } from '../../ui/finance/uiState';
import { confirmDialog } from '../../store/ui';
import type { TileDisplayMode } from '../../core/valueTile';

const REPORT_KEY = '$bank';
export const BANK_SIZES: Record<TileDisplayMode, { width: number; height: number }> = {
  compact: { width: 170, height: 56 },
  normal: { width: 230, height: 120 },
  detailed: { width: 270, height: 220 },
};

// Ponte: qualquer mudança no razão recalcula o fluxo de dados (e só ela; o quadro não é alterado).
let bridged = false;
function bridge() {
  if (bridged) return;
  bridged = true;
  useFinance.subscribe((s, p) => { if (s.version !== p.version) bumpExternalData(); });
}

function resultOf(d: BankQueryData, outputs: Record<string, unknown>): BankQueryResult {
  return (outputs[REPORT_KEY] as BankQueryResult | undefined) ?? runBankQuery(getFinance(), d);
}

export function bankModel(el: WidgetElement, d: BankQueryData, r: BankQueryResult): CardModel {
  const f = (c: number) => formatMoney(c, d.currency);
  const accent = '#63d7dd';
  if (r.status !== 'ok') {
    return { title: el.title, value: r.status === 'loading' ? '…' : '—', valueColor: '#8ea3bf', caption: `${METRIC_LABELS[d.metric]} · ${rangeLabel(d)}`, rows: [], accent, status: { text: r.message, color: r.status === 'loading' ? '#8ea3bf' : '#f3c577' }, valueRole: 'value' };
  }
  const fl = r.flows!;
  const rows: CardModel['rows'] = [];
  if (d.displayMode !== 'compact') {
    if (d.metric === 'result' || d.displayMode === 'detailed') {
      rows.push({ label: 'Receitas', value: f(fl.incomeCents + fl.reimbursementCents + fl.interestEarnedCents), color: '#5addaa', role: 'income' });
      rows.push({ label: 'Despesas', value: f(fl.netExpenseCents + fl.feeCents + fl.interestPaidCents), color: '#fb8590', role: 'expenses' });
    }
    if (d.displayMode === 'detailed') {
      if (fl.refundCents) rows.push({ label: 'Estornos', value: f(fl.refundCents) });
      if (fl.transferOutCents) rows.push({ label: 'Transferências (fora)', value: f(fl.transferOutCents) });
      rows.push({ label: 'Movimentações', value: String(fl.count), role: 'count' });
    }
  }
  const warn = fl.warnings.find((w) => !/pendente/.test(w)) ?? (r.valueCents === null ? r.balanceNote : undefined);
  const value = r.valueCents === null ? '—' : f(r.valueCents);
  return {
    title: el.title,
    value: d.displayMode === 'compact' ? `${value}` : value,
    valueColor: d.metric === 'income' ? '#5addaa' : d.metric === 'expense' || d.metric === 'fees' ? '#fb8590' : (r.valueCents ?? 0) < 0 ? '#fb8590' : CARD_FG,
    caption: `${METRIC_LABELS[d.metric]}${d.category ? ` · ${d.category}` : ''} · ${rangeLabel(d)}${fl.pendingCount ? ' · inclui pendentes' : ''}`,
    rows,
    accent,
    status: warn ? { text: `⚠ ${warn}`, color: '#f3c577' } : undefined,
    valueRole: 'value',
  };
}

function Inspector({ element, data }: { element: WidgetElement; data: BankQueryData }) {
  const fin = useFinance();
  const id = element.id;
  const set = (p: Partial<BankQueryData>) => patchWidget(id, (r) => sanitizeBankQuery(r, currentPeriod()), () => ({ data: p }));
  const r = useMemo(() => runBankQuery(fin, data), [fin, data]);
  const payload = useMemo(() => buildFinanceAIText(data, r, fin, element.title), [data, r, fin, element.title]);
  const authorized = shareAuthorized(data, id, fin);
  const changed = data.aiShare.mode !== 'none' && !!data.aiShare.confirmedDigest && !authorized;
  const share = (p: Partial<BankQueryData['aiShare']>) => set({ aiShare: { ...data.aiShare, ...p } });
  const [y, m] = data.period.split('-');
  const accounts = fin.accounts.filter((a) => a.status === 'active' || data.accountIds.includes(a.id));
  return (
    <div className="flex flex-col text-[12px]" data-testid="bank-inspector">
      {fin.status !== 'ready' ? <div className="text-[11px] text-soft">Carregando dados locais…</div> : null}
      {data.ledgerId && fin.status === 'ready' && data.ledgerId !== fin.ledgerId && (
        <div className="text-[11px] text-warn">Esta consulta aponta para dados financeiros de outro navegador. <button className="underline" onClick={() => set({ ledgerId: fin.ledgerId, accountIds: [] })}>Usar os dados deste navegador</button></div>
      )}
      <Label>Contas</Label>
      {!accounts.length ? (
        <div className="text-[11px] text-soft">Nenhuma conta. <button className="text-accent underline" onClick={() => openFinanceHub('accounts')}>Abrir Minhas contas</button></div>
      ) : (
        <div className="flex flex-col gap-0.5" data-testid="bank-accounts">
          <label className="flex items-center gap-1.5 text-[11px]"><input type="checkbox" className="accent-accent" checked={!data.accountIds.length} onChange={(e) => e.target.checked && set({ accountIds: [] })} /> Todas as contas ativas</label>
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5 text-[11px]">
              <input type="checkbox" className="accent-accent" checked={data.accountIds.includes(a.id)} onChange={(e) => set({ accountIds: e.target.checked ? [...data.accountIds, a.id] : data.accountIds.filter((x) => x !== a.id) })} />
              <span className="truncate">{a.name}</span><span className="text-soft text-[10px]">{ACCOUNT_TYPE_LABELS[a.type]}</span>
            </label>
          ))}
        </div>
      )}
      <Label>Métrica</Label>
      <Select aria-label="Métrica" value={data.metric} onChange={(e) => set({ metric: e.target.value as BankMetric })}>
        {(Object.keys(METRIC_LABELS) as BankMetric[]).map((k) => <option key={k} value={k}>{METRIC_LABELS[k]}</option>)}
      </Select>
      <Label>Categoria</Label>
      <Select aria-label="Categoria" value={data.category} onChange={(e) => set({ category: e.target.value })}>
        <option value="">Todas</option>
        {fin.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
      </Select>
      <Label>Período</Label>
      <Segmented label="Tipo de período" value={data.periodMode} onChange={(v) => set({ periodMode: v })} options={[{ value: 'month', label: 'Mês' }, { value: 'last-n', label: 'Últimos meses' }, { value: 'range', label: 'Intervalo' }]} />
      {data.periodMode !== 'range' ? (
        <div className="flex gap-1.5 mt-1.5">
          <Select aria-label="Mês da consulta" value={m} onChange={(e) => set({ period: `${y}-${e.target.value}` })} className="flex-1">
            {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((mm) => <option key={mm} value={mm}>{periodLabel(`2000-${mm}`).replace(' 2000', '')}</option>)}
          </Select>
          <Field aria-label="Ano da consulta" type="number" min={1900} max={2200} value={y} onChange={(e) => /^\d{4}$/.test(e.target.value) && set({ period: `${e.target.value}-${m}` })} className="!w-20" />
          {data.periodMode === 'last-n' && <Field aria-label="Quantidade de meses" type="number" min={1} max={36} value={data.months} onChange={(e) => set({ months: Number(e.target.value) || 1 })} className="!w-16" />}
        </div>
      ) : (
        <div className="flex gap-1.5 mt-1.5">
          <Field aria-label="De" type="date" value={data.from} onChange={(e) => set({ from: e.target.value })} />
          <Field aria-label="Até" type="date" value={data.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      )}
      <Label>Moeda</Label>
      <Segmented label="Moeda da consulta" value={data.currency} onChange={(c) => set({ currency: c })} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
      <Label>Modo visual</Label>
      <Segmented<TileDisplayMode> label="Modo visual" value={data.displayMode} onChange={(mode) => patchWidget(id, (x) => sanitizeBankQuery(x, currentPeriod()), () => ({ data: { displayMode: mode }, size: BANK_SIZES[mode] }))} options={MODE_OPTIONS} />
      <div className="mt-2 text-[10px] text-soft">O quadro guarda só esta consulta. Os valores vêm do razão local deste navegador e não vão no JSON do quadro.</div>

      <Label>Análise por IA</Label>
      <div className="rounded-lg border border-line/60 p-2 bg-[#0f1826] flex flex-col gap-1.5" data-testid="bank-ai-share">
        <Segmented label="Compartilhamento com IA" value={data.aiShare.mode} onChange={(mode) => { share({ mode, confirmedDigest: '', confirmedAt: 0 }); void revokeAI(id); }} options={[{ value: 'none', label: 'Nada' }, { value: 'aggregate', label: 'Resumo agregado' }, { value: 'detail', label: 'Movimentações' }]} />
        {data.aiShare.mode !== 'none' && (
          <>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] text-fg-2">
              {([['includeCategories', 'Categorias'], ['includeMonths', 'Totais por mês'], ['includeAccountNames', 'Nomes das contas'], ...(data.aiShare.mode === 'detail' ? [['includeDates', 'Datas'], ['includeDescriptions', 'Descrições']] : [])] as [keyof BankQueryData['aiShare'], string][]).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent-2" checked={data.aiShare[k] as boolean} onChange={(e) => share({ [k]: e.target.checked })} /> {label}</label>
              ))}
            </div>
            {data.aiShare.mode === 'detail' && (
              <label className="flex items-center gap-1.5 text-[11px]">Máximo de movimentações <Field aria-label="Máximo de movimentações" type="number" min={1} max={200} value={data.aiShare.maxItems} onChange={(e) => share({ maxItems: Number(e.target.value) || 1 })} className="!w-16" /></label>
            )}
            <div className="text-[10px] text-muted">Exatamente isto será enviado ao provedor de IA quando um Assistente IA conectado a este bloco for usado:</div>
            <pre data-testid="bank-ai-preview" className="max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-muted bg-[#0a111c] p-1.5 rounded" data-scrollable>{payload.text || '(nada — consulta indisponível)'}</pre>
            {authorized ? (
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-ok" data-testid="bank-ai-status">✓ Autorizado em {new Date(data.aiShare.confirmedAt).toLocaleString('pt-BR')}</span>
                <Button onClick={() => { share({ mode: 'none', confirmedDigest: '', confirmedAt: 0 }); void revokeAI(id); }}>Revogar</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {changed && <div className="text-[11px] text-warn" data-testid="bank-ai-status">A consulta mudou depois da autorização: confirme de novo.</div>}
                <Button
                  variant="primary"
                  disabled={!payload.text}
                  onClick={async () => {
                    const ok = await confirmDialog('Autorizar envio de dados financeiros', `O conteúdo mostrado na prévia (${payload.text.length} caracteres${data.aiShare.mode === 'detail' ? `, ${payload.refs.length} movimentação(ões)` : ''}) poderá ser enviado ao provedor de IA configurado sempre que um Assistente IA conectado a este bloco for usado. Nada é enviado agora. Você pode revogar a qualquer momento.`, 'Autorizar');
                    if (!ok) return;
                    // A autorização vale só neste navegador (razão local); o quadro guarda apenas o resumo para a interface.
                    const q = sanitizeBankQuery({ ...data, ledgerId: data.ledgerId || fin.ledgerId }, currentPeriod());
                    await grantAI(grantKey(id, q));
                    share({ confirmedDigest: shareDigest(q), confirmedAt: Date.now() });
                  }}
                >Autorizar este conteúdo para IA</Button>
              </div>
            )}
          </>
        )}
        {data.aiShare.mode === 'none' && <div className="text-[11px] text-soft" data-testid="bank-ai-status">Nada deste bloco é enviado à IA, mesmo conectado a um Assistente.</div>}
      </div>
      <div className="mt-2"><Button onClick={() => openFinanceHub('overview')}>Abrir Minhas contas</Button></div>
    </div>
  );
}

export const bankQueryPlugin: WidgetPlugin<BankQueryData> = {
  id: WIDGET.bankQuery,
  name: 'Consulta bancária',
  description: 'Receitas, despesas, resultado ou saldo das suas contas (Minhas contas), por período e categoria.',
  icon: Landmark,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#63d7dd',
  permissions: [],
  defaultSize: BANK_SIZES.normal,
  inputs: [],
  outputs: [
    { id: 'value', label: 'Valor da consulta', type: 'money' },
    { id: 'income', label: 'Receitas', type: 'money' },
    { id: 'expenses', label: 'Despesas', type: 'money' },
    { id: 'occurrences', label: 'Lançamentos (para o Mês)', type: 'finance.occurrences' },
    { id: 'monthly', label: 'Série mensal (para gráficos)', type: 'finance.periods' },
  ],
  frame: 'bare',
  librarySection: 'Finanças visuais',
  hideInLibrary: true,
  presets: [
    { id: 'expense', name: 'Despesas do banco', description: 'Consumo líquido das suas contas no mês (Minhas contas).', icon: Landmark, keywords: ['banco', 'extrato', 'despesas', 'contas'], data: { metric: 'expense', period: currentPeriod(), aiShare: DEFAULT_AI_SHARE } as Partial<BankQueryData>, size: BANK_SIZES.normal, title: 'Despesas do banco' },
    { id: 'income', name: 'Receitas do banco', description: 'Receitas externas das suas contas no mês.', icon: Landmark, keywords: ['banco', 'extrato', 'receitas', 'salário'], data: { metric: 'income', period: currentPeriod(), aiShare: DEFAULT_AI_SHARE } as Partial<BankQueryData>, size: BANK_SIZES.normal, title: 'Receitas do banco' },
    { id: 'balance', name: 'Saldo das contas', description: 'Saldo estimado (precisa de saldo informado ou inicial).', icon: Landmark, keywords: ['banco', 'saldo', 'patrimônio'], data: { metric: 'balance', period: currentPeriod(), aiShare: DEFAULT_AI_SHARE } as Partial<BankQueryData>, size: BANK_SIZES.normal, title: 'Saldo das contas' },
  ],
  createData: () => sanitizeBankQuery({ period: currentPeriod() }, currentPeriod()),
  sanitize: (raw) => sanitizeBankQuery(raw, currentPeriod()),
  compute: (d, _inputs, el) => {
    bridge();
    const s = getFinance();
    if (s.status === 'idle') void ensureFinanceLoaded();
    const r = runBankQuery(s, d);
    return { ...queryOutputs(r, d, { elementId: el.id, title: el.title }), [REPORT_KEY]: r };
  },
  // Resumo NÃO sensível (busca, exportação de texto, contexto genérico): sem valores do razão.
  summarize: (d, el) => `${el.title}: consulta bancária (${METRIC_LABELS[d.metric]}, ${rangeLabel(d)}). Valores ficam no razão local e não são incluídos neste resumo.`,
  aiContext: (d, el) => {
    if (d.aiShare.mode === 'none') return { allowed: false, text: '', reason: 'Dados bancários: compartilhamento com IA desativado neste bloco.' };
    if (!shareAuthorized(d, el.id, getFinance())) return { allowed: false, text: '', reason: 'Dados bancários: autorização para IA pendente ou desatualizada (confirme no painel do bloco).' };
    const r = runBankQuery(getFinance(), d);
    const p = buildFinanceAIText(d, r, getFinance(), el.title);
    return p.text ? { allowed: true, text: p.text } : { allowed: false, text: '', reason: 'Dados bancários indisponíveis neste navegador.' };
  },
  Component: function BankTile({ element, data, outputs, selected, update }) {
    const status = useFinance((s) => s.status);
    const ledgerId = useFinance((s) => s.ledgerId);
    useEffect(() => { bridge(); void ensureFinanceLoaded(); }, []);
    // Vincula a consulta ao razão deste navegador na primeira vez (em outro navegador, fica “indisponível”).
    useEffect(() => { if (status === 'ready' && !data.ledgerId && ledgerId) update({ ledgerId }, { coalesce: true }); }, [status, ledgerId, data.ledgerId, update]);
    const r = resultOf(data, outputs);
    const model = useMemo(() => bankModel(element, data, r), [element, data, r]);
    return <CardView element={element} model={model} mode={data.displayMode} selected={selected} testid="bank-tile" />;
  },
  Inspector: ({ element, data }) => <Inspector element={element} data={data} />,
  menuItems: () => [{ id: 'hub', label: 'Abrir Minhas contas', run: () => openFinanceHub('overview') }],
  exportSVG: (d, el) => cardSVG(bankModel(el, d, resultOf(d, currentFlow(el.id).outputs)), el, d.displayMode),
};
