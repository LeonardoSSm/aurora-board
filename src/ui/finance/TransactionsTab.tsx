/** Transações: busca e filtros, classificação local, pares sugeridos, lançamento manual e exportação CSV. */
import { useMemo, useState } from 'react';
import type { MovementKind } from '../../finance/model';
import { KIND_LABELS, MOVEMENT_KINDS } from '../../finance/model';
import { matchesFilter, type LedgerFilter } from '../../finance/reports';
import { acceptPair, addManualTransaction, classifyTransaction, deleteManualTransaction, pairSuggestions, unlink, useFinance } from '../../finance/store';
import { toCsv } from '../../finance/csv';
import { parseMoney } from '../../core/finance';
import { downloadText } from '../../persistence/exportImport';
import { confirmDialog, toast } from '../../store/ui';
import { brl, btnCls, Card, EmptyState, inputCls, OriginBadge, primaryCls, todayISO } from './common';

const PAGE = 200;

export function TransactionsTab({ accountId }: { accountId: string | null }) {
  const s = useFinance();
  const [f, setF] = useState<LedgerFilter>({ accountIds: accountId ? [accountId] : undefined });
  const [limit, setLimit] = useState(PAGE);
  const [manual, setManual] = useState<{ accountId: string; date: string; description: string; amount: string; kind: MovementKind | '' } | null>(null);
  const accName = useMemo(() => new Map(s.accounts.map((a) => [a.id, a.name])), [s.accounts]);
  const mockAccounts = useMemo(() => new Set(s.accounts.filter((a) => a.providerRef?.providerId === 'mock').map((a) => a.id)), [s.accounts]);
  const list = useMemo(() => s.transactions.filter((t) => matchesFilter(t, f)).sort((a, b) => b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id)), [s.transactions, f]);
  const total = useMemo(() => list.reduce((n, t) => n + t.amountCents, 0), [list]);
  const suggestions = useMemo(() => pairSuggestions().filter((p) => !p.confident), [s.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const txById = useMemo(() => new Map(s.transactions.map((t) => [t.id, t])), [s.transactions]);
  const set = (p: Partial<LedgerFilter>) => { setF((x) => ({ ...x, ...p })); setLimit(PAGE); };

  const exportCsv = () => {
    const rows: (string | number)[][] = [['Data', 'Conta', 'Descrição', 'Valor', 'Moeda', 'Tipo', 'Categoria', 'Status', 'Origem']];
    for (const t of list) rows.push([t.postedDate, accName.get(t.accountId) ?? '', t.description, (t.amountCents / 100).toFixed(2).replace('.', ','), t.currency, KIND_LABELS[t.local.kind], t.local.category, t.status === 'pending' ? 'Pendente' : 'Contabilizada', t.source.kind]);
    downloadText(`movimentacoes-${todayISO()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    toast(`${list.length} movimentação(ões) exportada(s). O arquivo contém dados financeiros: guarde com cuidado.`, 'success', 6000);
  };

  const saveManual = async () => {
    if (!manual) return;
    const cents = parseMoney(manual.amount);
    if (cents === null || cents === 0) { toast('Valor inválido. Use negativo para saída (ex.: -45,90).', 'error'); return; }
    try {
      await addManualTransaction(manual.accountId, { date: manual.date, description: manual.description, amountCents: cents, kind: manual.kind || undefined });
      setManual(null);
      toast('Lançamento manual adicionado.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!s.accounts.length) return <EmptyState title="Nenhuma conta ainda">Cadastre uma conta em “Contas” e importe um extrato para ver as movimentações.</EmptyState>;

  return (
    <div className="flex flex-col gap-3" data-testid="finance-transactions">
      <Card>
        <div className="flex flex-wrap gap-1.5 items-center text-[11px]">
          <input className={`${inputCls} w-44`} placeholder="Buscar descrição…" aria-label="Buscar" value={f.text ?? ''} onChange={(e) => set({ text: e.target.value || undefined })} />
          <select className={inputCls} aria-label="Conta" value={f.accountIds?.[0] ?? ''} onChange={(e) => set({ accountIds: e.target.value ? [e.target.value] : undefined })}>
            <option value="">Todas as contas</option>{s.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input className={inputCls} type="date" aria-label="De" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />
          <input className={inputCls} type="date" aria-label="Até" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
          <select className={inputCls} aria-label="Categoria" value={f.categories?.[0] ?? ''} onChange={(e) => set({ categories: e.target.value ? [e.target.value] : undefined })}>
            <option value="">Todas as categorias</option>{s.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <select className={inputCls} aria-label="Tipo" value={f.kinds?.[0] ?? ''} onChange={(e) => set({ kinds: e.target.value ? [e.target.value as MovementKind] : undefined })}>
            <option value="">Todos os tipos</option>{MOVEMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
          <select className={inputCls} aria-label="Origem" value={f.origin ?? ''} onChange={(e) => set({ origin: (e.target.value || undefined) as LedgerFilter['origin'] })}>
            <option value="">Todas as origens</option><option value="csv">CSV</option><option value="ofx">OFX</option><option value="provider">Conector</option><option value="manual">Manual</option><option value="backup">Backup</option>
          </select>
          <select className={inputCls} aria-label="Status" value={f.status ?? ''} onChange={(e) => set({ status: (e.target.value || undefined) as LedgerFilter['status'] })}>
            <option value="">Todos os status</option><option value="posted">Contabilizadas</option><option value="pending">Pendentes</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-[11px]">
          <span className="text-muted" data-testid="tx-count">{list.length} movimentação(ões) · soma {brl(total)}</span>
          <span className="flex gap-1.5">
            <button className={btnCls} onClick={() => setManual({ accountId: f.accountIds?.[0] ?? s.accounts[0].id, date: todayISO(), description: '', amount: '', kind: '' })}>Lançamento manual</button>
            <button className={btnCls} disabled={!list.length} onClick={exportCsv}>Exportar CSV</button>
          </span>
        </div>
        {manual && (
          <div className="mt-2 flex flex-wrap gap-1.5 items-center text-[11px]" data-testid="manual-form">
            <select className={inputCls} aria-label="Conta do lançamento" value={manual.accountId} onChange={(e) => setManual({ ...manual, accountId: e.target.value })}>{s.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <input className={inputCls} type="date" aria-label="Data do lançamento" value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} />
            <input className={inputCls} placeholder="Descrição" aria-label="Descrição do lançamento" value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
            <input className={`${inputCls} w-28`} placeholder="-45,90" aria-label="Valor do lançamento" value={manual.amount} onChange={(e) => setManual({ ...manual, amount: e.target.value })} />
            <select className={inputCls} aria-label="Tipo do lançamento" value={manual.kind} onChange={(e) => setManual({ ...manual, kind: e.target.value as MovementKind })}><option value="">Tipo automático</option>{MOVEMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>
            <button className={primaryCls} onClick={() => void saveManual()}>Adicionar</button>
            <button className={btnCls} onClick={() => setManual(null)}>Cancelar</button>
          </div>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card title={`Possíveis transferências / pagamentos de fatura (${suggestions.length})`} testid="pair-suggestions">
          <ul className="flex flex-col gap-1 text-[11px]">
            {suggestions.slice(0, 20).map((p) => {
              const d = txById.get(p.debitId), c = txById.get(p.creditId);
              if (!d || !c) return null;
              return (
                <li key={`${p.debitId}-${p.creditId}`} className="flex items-center justify-between gap-2 border-b border-line/40 py-1">
                  <span className="min-w-0 truncate">{brl(-d.amountCents)} · {accName.get(d.accountId)} “{d.description}” ({d.postedDate}) → {accName.get(c.accountId)} “{c.description}” ({c.postedDate}) <span className="text-soft">— {p.reason}</span></span>
                  <button className={btnCls} onClick={() => void acceptPair(p)}>Confirmar par</button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {!list.length ? <EmptyState title="Nenhuma movimentação com estes filtros" /> : (
        <div className="rounded-xl border border-line overflow-auto max-h-[60vh]" data-scrollable>
          <table className="w-full text-[11px]" data-testid="tx-table">
            <thead className="sticky top-0 bg-panel text-soft"><tr><th className="text-left p-1.5">Data</th><th className="text-left">Conta</th><th className="text-left">Descrição</th><th className="text-right">Valor</th><th className="text-left pl-2">Tipo</th><th className="text-left">Categoria</th><th /></tr></thead>
            <tbody>
              {list.slice(0, limit).map((t) => (
                <tr key={t.id} className="border-t border-line/40 align-middle" data-testid="tx-row" data-kind={t.local.kind}>
                  <td className="p-1.5 whitespace-nowrap">{t.postedDate.split('-').reverse().join('/')}{t.status === 'pending' && <span className="ml-1 text-warn" title="Pendente">◷</span>}</td>
                  <td className="whitespace-nowrap max-w-[120px] truncate">{accName.get(t.accountId)}</td>
                  <td className="max-w-[260px] truncate" title={t.memo ? `${t.description} — ${t.memo}` : t.description}>{t.description} {t.installment && <span className="text-soft">{t.installment.index}/{t.installment.count}</span>}</td>
                  <td className={`text-right whitespace-nowrap font-semibold ${t.amountCents < 0 ? 'text-danger' : 'text-ok'}`}>{brl(t.amountCents, t.currency)}</td>
                  <td className="pl-2">
                    <select className="bg-transparent border border-line/60 rounded px-1 h-6" aria-label="Tipo de movimento" value={t.local.kind} onChange={(e) => void classifyTransaction(t.id, { kind: e.target.value as MovementKind })}>
                      {MOVEMENT_KINDS.map((k) => <option key={k} value={k} className="bg-panel">{KIND_LABELS[k]}</option>)}
                    </select>
                    {t.local.linkId && <button className="ml-1 text-[10px] text-accent underline" title="Desfazer par" onClick={() => void unlink(t.local.linkId!)}>par</button>}
                  </td>
                  <td>
                    <select className="bg-transparent border border-line/60 rounded px-1 h-6 max-w-[130px]" aria-label="Categoria da movimentação" value={t.local.category} onChange={(e) => void classifyTransaction(t.id, { category: e.target.value })}>
                      {!s.categories.some((c) => c.name === t.local.category) && <option value={t.local.category}>{t.local.category}</option>}
                      {s.categories.map((c) => <option key={c.id} value={c.name} className="bg-panel">{c.name}</option>)}
                    </select>
                  </td>
                  <td className="pr-1.5 whitespace-nowrap text-right">
                    <OriginBadge origin={t.source.kind} mock={mockAccounts.has(t.accountId)} />
                    {t.source.kind === 'manual' && <button className="ml-1 text-soft hover:text-danger" aria-label="Excluir lançamento manual" onClick={async () => { if (await confirmDialog('Excluir lançamento manual', `“${t.description}” será removido. Lançamentos importados só saem revertendo a importação.`, 'Excluir', true)) await deleteManualTransaction(t.id); }}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > limit && <div className="p-2 text-center"><button className={btnCls} onClick={() => setLimit((l) => l + PAGE * 5)}>Mostrar mais ({list.length - limit} restantes)</button></div>}
        </div>
      )}
    </div>
  );
}
