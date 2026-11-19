/**
 * “Minhas contas” — gestão financeira pessoal independente do canvas.
 * Visão geral, contas, cartões, transações, importações, conectores, regras e privacidade.
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { AccountType, FinancialAccount } from '../../finance/model';
import { ACCOUNT_TYPE_LABELS, isCardAccount } from '../../finance/model';
import { accountBalance, cardSummary, consolidate, recurring, summarizeFlows } from '../../finance/reports';
import { createAccount, deleteAccountData, ensureFinanceLoaded, revertImport, updateAccount, useFinance } from '../../finance/store';
import { parseMoney } from '../../core/finance';
import { currentPeriod, periodLabel } from '../../core/scalar';
import { confirmDialog, promptDialog, toast } from '../../store/ui';
import { closeFinanceHub, useFinanceUI, type FinanceTab } from './uiState';
import { brl, btnCls, Card, dangerCls, EmptyState, inputCls, lastDay, MonthPicker, OriginBadge, primaryCls, Stat, todayISO } from './common';
import { ImportWizard } from './ImportWizard';
import { TransactionsTab } from './TransactionsTab';
import { ConnectorsTab, TestBanner } from './ConnectorsTab';
import { PrivacyTab, RulesTab } from './PrivacyTab';
import { divRound, formatDec, ONE } from '../../core/decimal';

const TABS: [FinanceTab, string][] = [
  ['overview', 'Visão geral'], ['accounts', 'Contas'], ['cards', 'Cartões'], ['transactions', 'Transações'],
  ['imports', 'Importações'], ['connectors', 'Conectores'], ['rules', 'Regras e categorias'], ['privacy', 'Privacidade e backups'],
];

export function FinanceHub() {
  const ui = useFinanceUI();
  const status = useFinance((s) => s.status);
  const error = useFinance((s) => s.error);
  const hasMock = useFinance((s) => s.accounts.some((a) => a.providerRef?.providerId === 'mock'));
  const [importing, setImporting] = useState(false);
  useEffect(() => { if (ui.open) void ensureFinanceLoaded(); }, [ui.open]);
  useEffect(() => { if (ui.importAccountId) setImporting(true); }, [ui.importAccountId]);
  useEffect(() => {
    if (!ui.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !importing) closeFinanceHub(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui.open, importing]);
  if (!ui.open) return null;
  const setTab = (tab: FinanceTab) => { useFinanceUI.setState({ tab }); setImporting(false); };
  return (
    <div className="fixed inset-0 z-40 bg-black/55 flex items-stretch justify-center p-0 md:p-6" role="dialog" aria-modal="true" aria-label="Minhas contas" data-testid="finance-hub" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !importing && !(e.target as HTMLElement).closest?.('[role="dialog"] [role="dialog"]')) closeFinanceHub(); }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="w-full max-w-[1200px] bg-[#0b1320] md:rounded-2xl border border-line shadow-[0_20px_60px_#000c] flex flex-col min-h-0">
        <header className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
          <div className="w-7 h-7 rounded-lg grid place-items-center bg-gradient-to-br from-[#2b9aa3] to-[#367ce8] text-white text-sm">R$</div>
          <h1 className="text-[14px] font-extrabold tracking-tight">Minhas contas</h1>
          <span className="text-[10px] text-soft hidden md:inline">Dados locais deste navegador · nada é enviado a servidores</span>
          <div className="flex-1" />
          <button className={primaryCls} data-testid="open-import" onClick={() => { setImporting(true); }}>Importar extrato</button>
          <button aria-label="Fechar Minhas contas" className="p-1.5 rounded-lg hover:bg-panel-3 text-muted" onClick={closeFinanceHub}><X size={16} /></button>
        </header>
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <nav className="md:w-48 shrink-0 border-b md:border-b-0 md:border-r border-line p-2 flex md:flex-col gap-1 overflow-x-auto" aria-label="Seções">
            {TABS.map(([id, label]) => (
              <button key={id} data-testid={`finance-tab-${id}`} onClick={() => setTab(id)} className={`text-left whitespace-nowrap text-[12px] px-2.5 py-1.5 rounded-lg ${ui.tab === id && !importing ? 'bg-panel-3 text-fg font-semibold' : 'text-muted hover:text-fg hover:bg-panel-3/50'}`}>{label}</button>
            ))}
          </nav>
          <main className="flex-1 min-w-0 overflow-auto p-4 flex flex-col gap-3" data-scrollable>
            {hasMock && <TestBanner />}
            {status === 'loading' || status === 'idle' ? <div className="text-muted text-[13px]">Carregando dados financeiros locais…</div>
              : status === 'error' ? <div className="rounded-lg border border-danger/50 p-3 text-danger text-[13px]" role="alert">{error} Nenhum dado foi apagado.</div>
              : importing ? <ImportWizard initialAccountId={ui.importAccountId} onClose={() => { setImporting(false); useFinanceUI.setState({ importAccountId: null }); }} />
              : ui.tab === 'overview' ? <Overview onImport={() => setImporting(true)} />
              : ui.tab === 'accounts' ? <Accounts onImport={(id) => { useFinanceUI.setState({ importAccountId: id }); setImporting(true); }} />
              : ui.tab === 'cards' ? <Cards />
              : ui.tab === 'transactions' ? <TransactionsTab accountId={ui.accountId} />
              : ui.tab === 'imports' ? <Imports />
              : ui.tab === 'connectors' ? <ConnectorsTab />
              : ui.tab === 'rules' ? <RulesTab />
              : <PrivacyTab />}
          </main>
        </div>
      </div>
    </div>
  );
}

function Overview({ onImport }: { onImport: () => void }) {
  const s = useFinance();
  const [period, setPeriod] = useState(currentPeriod());
  const today = todayISO();
  const filter = { from: `${period}-01`, to: lastDay(period) };
  const flows = useMemo(() => summarizeFlows(s.transactions, s.accounts, filter), [s.transactions, s.accounts, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const cons = useMemo(() => consolidate(s.accounts, s.transactions, 'BRL', today), [s.accounts, s.transactions, today]);
  const rec = useMemo(() => recurring(s.transactions).slice(0, 6), [s.transactions]);
  if (!s.accounts.length) {
    return <EmptyState title="Comece pelas suas contas" action={<><button className={primaryCls} onClick={onImport}>Importar extrato (CSV/OFX)</button><button className={btnCls} onClick={() => useFinanceUI.setState({ tab: 'accounts' })}>Cadastrar conta</button></>}>Cadastre uma conta ou importe um extrato do seu banco. Os dados ficam só neste navegador; o quadro pode consultá-los com o bloco “Consulta bancária”.</EmptyState>;
  }
  const expenseTotal = flows.netExpenseCents + flows.feeCents + flows.interestPaidCents;
  const income = flows.incomeCents + flows.reimbursementCents + flows.interestEarnedCents;
  const commitment = income > 0 ? `${formatDec(divRound(BigInt(expenseTotal) * 100n * ONE, BigInt(income)), 1)}%` : '— (sem receitas)';
  const lastImport = [...s.imports].filter((i) => i.origin !== 'manual').sort((a, b) => b.createdAt - a.createdAt)[0];
  return (
    <div className="flex flex-col gap-3" data-testid="finance-overview">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <MonthPicker value={period} onChange={setPeriod} />
        <span className="text-[11px] text-soft">Última importação: {lastImport ? new Date(lastImport.createdAt).toLocaleString('pt-BR') : 'nenhuma'}</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Saldo consolidado" value={cons.included.length ? brl(cons.totalCents) : '—'} tone={cons.complete ? undefined : 'warn'} hint={cons.complete ? 'Estimado a partir dos saldos informados' : `Incompleto: ${cons.missing.length} conta(s) sem saldo informado`} testid="ov-consolidated" />
        <Stat label={`Receitas · ${periodLabel(period, 'short')}`} value={brl(income)} tone="ok" testid="ov-income" />
        <Stat label="Despesas (consumo líquido)" value={brl(expenseTotal)} tone="danger" hint={flows.refundCents ? `Estornos abatidos: ${brl(flows.refundCents)}` : undefined} testid="ov-expense" />
        <Stat label="Resultado" value={brl(flows.resultCents)} tone={flows.resultCents < 0 ? 'danger' : 'ok'} hint={`Comprometimento: ${commitment}`} testid="ov-result" />
        <Stat label="Transferências entre contas" value={brl(flows.transferOutCents)} hint="Fora de receitas e despesas" testid="ov-transfers" />
        <Stat label="Pagamentos de fatura" value={brl(flows.cardPaymentCents)} hint="Não contam de novo como despesa" testid="ov-cardpay" />
        <Stat label="Tarifas e juros" value={brl(flows.feeCents + flows.interestPaidCents)} />
        <Stat label="Movimentações" value={String(flows.count)} hint={flows.pendingCount ? `${flows.pendingCount} pendente(s)` : undefined} />
      </div>
      {flows.warnings.length > 0 && <div className="flex flex-col gap-0.5">{flows.warnings.map((w, i) => <div key={i} className="text-[11px] text-warn" data-testid="ov-warning">⚠ {w}</div>)}</div>}
      <Card title="Saldos por conta">
        <table className="w-full text-[12px]" data-testid="ov-accounts">
          <thead className="text-soft text-[10px] uppercase"><tr><th className="text-left">Conta</th><th className="text-right">Informado</th><th className="text-right">Estimado hoje</th><th className="text-right">Fluxo no mês</th><th className="text-left pl-3">Origem</th></tr></thead>
          <tbody>
            {s.accounts.filter((a) => a.status === 'active').map((a) => {
              const b = accountBalance(a, s.transactions, filter, today);
              return (
                <tr key={a.id} className="border-t border-line/40" data-testid="ov-account-row">
                  <td className="py-1"><button className="hover:underline text-left" onClick={() => useFinanceUI.setState({ tab: 'transactions', accountId: a.id })}>{a.name}</button> <span className="text-soft text-[10px]">{ACCOUNT_TYPE_LABELS[a.type]} {a.maskedNumber}</span></td>
                  <td className="text-right">{b.reported ? <span title={`em ${b.reported.asOf}`}>{brl(b.reported.cents, a.currency)}</span> : <span className="text-soft">—</span>}</td>
                  <td className="text-right" title={b.note} data-testid="ov-estimated">{b.estimatedCents === null ? <span className="text-soft">sem âncora</span> : <>{brl(b.estimatedCents, a.currency)}{b.basis !== 'reported' && <span className="text-soft text-[10px]"> (est.)</span>}</>}{b.stale && <span className="text-warn text-[10px]" title="Sem movimentações depois do saldo informado: pode estar desatualizado"> ⚠ desatualizado</span>}</td>
                  <td className={`text-right ${b.flowCents < 0 ? 'text-danger' : 'text-ok'}`}>{brl(b.flowCents, a.currency)}</td>
                  <td className="pl-3"><OriginBadge origin={a.origin} mock={a.providerRef?.providerId === 'mock'} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="text-[10px] text-soft mt-1">“Informado” é a fotografia da fonte numa data; “Estimado” soma as movimentações posteriores; “Fluxo” é só a soma das movimentações do mês — não é saldo.</div>
      </Card>
      <div className="grid md:grid-cols-2 gap-3">
        <Card title="Despesas por categoria">
          {flows.byCategory.filter((c) => c.expenseCents > 0).length ? (
            <ul className="text-[12px]">{flows.byCategory.filter((c) => c.expenseCents > 0).slice(0, 10).map((c) => (
              <li key={c.category} className="flex justify-between border-b border-line/30 py-0.5"><span>{c.category}</span><span className="text-danger">{brl(c.expenseCents)}</span></li>
            ))}</ul>
          ) : <div className="text-[11px] text-soft">Sem despesas no mês.</div>}
        </Card>
        <Card title="Pagamentos recorrentes prováveis">
          {rec.length ? <ul className="text-[12px]">{rec.map((r, i) => <li key={i} className="flex justify-between border-b border-line/30 py-0.5"><span className="truncate">{r.description}</span><span className="text-soft">{brl(r.amountCents)} · {r.months} meses</span></li>)}</ul> : <div className="text-[11px] text-soft">Nenhuma recorrência detectada (mesma descrição e valor em 3 meses).</div>}
        </Card>
      </div>
    </div>
  );
}

function AccountForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ institution: '', name: '', type: 'checking' as AccountType, currency: 'BRL' as 'BRL' | 'USD' | 'EUR', number: '', opening: '', openingDate: todayISO(), limit: '', closingDay: '', dueDay: '' });
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    const opening = f.opening.trim() ? parseMoney(f.opening) : null;
    if (f.opening.trim() && opening === null) return setError('Saldo inicial inválido.');
    const limit = f.limit.trim() ? parseMoney(f.limit) : null;
    try {
      await createAccount({
        institutionName: f.institution || 'Instituição', name: f.name || ACCOUNT_TYPE_LABELS[f.type], type: f.type, currency: f.currency, number: f.number,
        openingBalance: opening !== null ? { cents: opening, date: f.openingDate } : undefined,
        card: f.type === 'credit_card' ? { limitCents: limit ?? undefined, closingDay: Number(f.closingDay) || undefined, dueDay: Number(f.dueDay) || undefined } : undefined,
      });
      onDone();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Card title="Nova conta" testid="account-form">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-[11px]">
        <input className={inputCls} placeholder="Instituição (ex.: Banco X)" aria-label="Instituição" value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} />
        <input className={inputCls} placeholder="Nome da conta" aria-label="Nome da conta" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className={inputCls} aria-label="Tipo de conta" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as AccountType })}>{(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}</select>
        <select className={inputCls} aria-label="Moeda" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value as 'BRL' })}><option>BRL</option><option>USD</option><option>EUR</option></select>
        <input className={inputCls} placeholder="Últimos dígitos (opcional)" aria-label="Últimos dígitos" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value.replace(/\D/g, '').slice(-4) })} />
        <input className={inputCls} placeholder="Saldo inicial (opcional)" aria-label="Saldo inicial" value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value })} />
        <input className={inputCls} type="date" aria-label="Data do saldo inicial" value={f.openingDate} onChange={(e) => setF({ ...f, openingDate: e.target.value })} />
        {f.type === 'credit_card' && <>
          <input className={inputCls} placeholder="Limite (opcional)" aria-label="Limite" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
          <input className={inputCls} placeholder="Dia do fechamento" aria-label="Dia do fechamento" value={f.closingDay} onChange={(e) => setF({ ...f, closingDay: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
          <input className={inputCls} placeholder="Dia do vencimento" aria-label="Dia do vencimento" value={f.dueDay} onChange={(e) => setF({ ...f, dueDay: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
        </>}
      </div>
      <div className="text-[10px] text-soft mt-1">Só os 4 últimos dígitos são guardados. Nunca informe senhas ou códigos do banco — o Aurora Board não pede.</div>
      {error && <div className="text-[11px] text-danger mt-1">{error}</div>}
      <div className="flex gap-1.5 mt-2"><button className={primaryCls} data-testid="account-save" onClick={() => void save()}>Salvar conta</button><button className={btnCls} onClick={onDone}>Cancelar</button></div>
    </Card>
  );
}

function Accounts({ onImport }: { onImport: (id: string) => void }) {
  const s = useFinance();
  const [adding, setAdding] = useState(false);
  const inst = (a: FinancialAccount) => s.institutions.find((i) => i.id === a.institutionId)?.name ?? '';
  const count = (id: string) => s.transactions.filter((t) => t.accountId === id).length;
  return (
    <div className="flex flex-col gap-3" data-testid="finance-accounts">
      {adding ? <AccountForm onDone={() => setAdding(false)} /> : <div><button className={primaryCls} data-testid="add-account" onClick={() => setAdding(true)}>Adicionar conta</button></div>}
      {!s.accounts.length && !adding && <EmptyState title="Nenhuma conta cadastrada">Adicione contas correntes, poupança, contas de pagamento, investimentos ou cartões. Cada conta guarda só os 4 últimos dígitos.</EmptyState>}
      {s.accounts.map((a) => (
        <Card key={a.id} testid="account-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[14px] font-bold">{a.name} <span className="text-soft text-[11px] font-normal">{a.maskedNumber}</span> {a.status === 'archived' && <span className="text-warn text-[10px]">arquivada</span>}</div>
              <div className="text-[11px] text-muted">{inst(a)} · {ACCOUNT_TYPE_LABELS[a.type]} · {a.currency} · {count(a.id)} movimentação(ões) · <OriginBadge origin={a.origin} mock={a.providerRef?.providerId === 'mock'} /></div>
              {a.reportedBalance && <div className="text-[11px] text-fg-2">Saldo informado: {brl(a.reportedBalance.cents, a.currency)} em {a.reportedBalance.asOf.slice(0, 10).split('-').reverse().join('/')}</div>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button className={btnCls} onClick={() => onImport(a.id)}>Importar extrato</button>
              <button className={btnCls} onClick={() => useFinanceUI.setState({ tab: 'transactions', accountId: a.id })}>Histórico</button>
              <button className={btnCls} onClick={async () => { const n = await promptDialog('Renomear conta', '', a.name); if (n) await updateAccount(a.id, { name: n }); }}>Renomear</button>
              <button className={btnCls} onClick={async () => {
                const v = await promptDialog('Saldo informado', 'Informe o saldo que o banco mostra hoje (ex.: 1.234,56). Ele ancora o saldo estimado.', '', '0,00');
                if (v === null) return;
                const c = parseMoney(v);
                if (c === null) { toast('Valor inválido.', 'error'); return; }
                await updateAccount(a.id, { reportedBalance: { cents: c, asOf: todayISO(), origin: 'manual' } });
              }}>Informar saldo</button>
              <button className={btnCls} onClick={() => void updateAccount(a.id, { status: a.status === 'active' ? 'archived' : 'active' })}>{a.status === 'active' ? 'Arquivar' : 'Reativar'}</button>
              <button className={dangerCls} onClick={async () => { if (await confirmDialog('Excluir dados locais da conta', `“${a.name}” e ${count(a.id)} movimentação(ões) serão apagadas deste navegador. Não há como desfazer. Isso não altera nada na instituição.`, 'Excluir', true)) { await deleteAccountData(a.id); toast('Conta excluída deste navegador.', 'success'); } }}>Excluir dados locais</button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Cards() {
  const s = useFinance();
  const cards = s.accounts.filter(isCardAccount);
  if (!cards.length) return <EmptyState title="Nenhum cartão">Cadastre um cartão de crédito em Contas (tipo “Cartão de crédito”) e importe a fatura (CSV/OFX).</EmptyState>;
  return (
    <div className="flex flex-col gap-3" data-testid="finance-cards">
      {cards.map((c) => {
        const cs = cardSummary(c, s.transactions);
        const flows = summarizeFlows(s.transactions, s.accounts, { accountIds: [c.id] }, c.currency);
        return (
          <Card key={c.id} title={`${c.name} ${c.maskedNumber}`} testid="card-summary">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <Stat label="Compras" value={brl(cs.purchasesCents, c.currency)} tone="danger" testid="card-purchases" />
              <Stat label="Estornos" value={brl(cs.refundsCents, c.currency)} tone="ok" testid="card-refunds" />
              <Stat label="Pagamentos de fatura" value={brl(cs.paymentsCents, c.currency)} testid="card-payments" />
              <Stat label="Saldo devedor" value={cs.debtCents === null ? '—' : brl(cs.debtCents, c.currency)} hint={cs.debtCents === null ? 'Sem saldo informado' : cs.debtCents < 0 ? 'Crédito a seu favor' : 'Estimado'} testid="card-debt" />
              <Stat label="Limite" value={cs.limitCents === undefined ? '—' : brl(cs.limitCents, c.currency)} hint="Não entra em saldos" />
              <Stat label="Limite disponível" value={cs.availableLimitCents === undefined ? '—' : brl(cs.availableLimitCents, c.currency)} hint="Informado pela fonte" />
              <Stat label="Juros e tarifas" value={brl(cs.interestCents + cs.feesCents, c.currency)} />
              <Stat label="Fechamento / vencimento" value={`${c.card?.closingDay ?? '—'} / ${c.card?.dueDay ?? '—'}`} hint={cs.installmentsCount ? `${cs.installmentsCount} compra(s) parcelada(s)` : undefined} />
            </div>
            <div className="grid md:grid-cols-2 gap-3 mt-3">
              <div>
                <div className="text-[10px] uppercase font-bold text-soft mb-1">Faturas (mês de vencimento estimado{c.card?.closingDay ? '' : ' — informe o fechamento para precisão'})</div>
                <table className="w-full text-[11px]"><tbody>{cs.bills.slice(-6).map((b) => <tr key={b.month} className="border-t border-line/30"><td>{periodLabel(b.month, 'short')}</td><td className="text-right text-danger">{brl(b.purchasesCents, c.currency)}</td><td className="text-right text-ok">{b.refundsCents ? `−${brl(b.refundsCents, c.currency)}` : ''}</td><td className="text-right text-soft">{b.paymentsCents ? `pago ${brl(b.paymentsCents, c.currency)}` : ''}</td></tr>)}</tbody></table>
              </div>
              <div>
                <div className="text-[10px] uppercase font-bold text-soft mb-1">Despesas por categoria</div>
                <ul className="text-[11px]">{flows.byCategory.filter((x) => x.expenseCents > 0).slice(0, 8).map((x) => <li key={x.category} className="flex justify-between"><span>{x.category}</span><span className="text-danger">{brl(x.expenseCents, c.currency)}</span></li>)}</ul>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Imports() {
  const s = useFinance();
  const list = [...s.imports].filter((i) => i.origin !== 'manual').sort((a, b) => b.createdAt - a.createdAt);
  const accName = new Map(s.accounts.map((a) => [a.id, a.name]));
  if (!list.length) return <EmptyState title="Nenhuma importação ainda">Use “Importar extrato” no topo. Cada importação fica registrada aqui e pode ser revertida.</EmptyState>;
  return (
    <div className="rounded-xl border border-line overflow-auto" data-testid="finance-imports" data-scrollable>
      <table className="w-full text-[11px]">
        <thead className="bg-panel text-soft"><tr><th className="text-left p-1.5">Quando</th><th className="text-left">Arquivo/fonte</th><th className="text-left">Conta</th><th>Lidas</th><th>Aceitas</th><th>Duplicadas</th><th>Ignoradas</th><th>Conflitos</th><th>Inválidas</th><th>Atualizadas</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {list.map((i) => (
            <tr key={i.id} className="border-t border-line/40 text-center" data-testid="import-row" data-status={i.status}>
              <td className="text-left p-1.5 whitespace-nowrap">{new Date(i.createdAt).toLocaleString('pt-BR')}</td>
              <td className="text-left truncate max-w-[180px]" title={[...i.warnings, ...i.errors].join('\n')}>{i.fileName ?? i.origin.toUpperCase()} <span className="text-soft">({i.origin})</span></td>
              <td className="text-left">{accName.get(i.accountId) ?? '—'}</td>
              <td>{i.counts.read}</td><td data-testid="import-row-accepted">{i.counts.accepted}</td><td>{i.counts.duplicate}</td><td>{i.counts.ignored}</td><td>{i.counts.conflict}</td><td className={i.counts.invalid ? 'text-warn' : ''}>{i.counts.invalid}</td><td>{i.counts.updated}</td>
              <td className={i.status === 'reverted' ? 'text-soft' : 'text-ok'}>{i.status === 'reverted' ? 'Revertida' : 'Gravada'}</td>
              <td className="pr-1.5">{i.status === 'committed' && <button className={btnCls} data-testid="revert-import" onClick={async () => { if (await confirmDialog('Reverter importação', `Remove as ${i.counts.accepted} movimentação(ões) criadas por esta importação e restaura as que ela atualizou. Classificações feitas nelas também saem.`, 'Reverter', true)) { const r = await revertImport(i.id); toast(`Revertida: ${r.removed} removida(s), ${r.restored} restaurada(s).`, 'success'); } }}>Reverter</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
