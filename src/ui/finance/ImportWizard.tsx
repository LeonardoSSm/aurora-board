/**
 * Importação de extrato: arquivo → formato → conta → mapeamento (CSV) → prévia/conciliação → confirmar.
 * NADA é gravado antes de “Confirmar importação”; cancelar em qualquer etapa não deixa rastro.
 */
import { useState } from 'react';
import type { FinancialAccount, AccountType } from '../../finance/model';
import { ACCOUNT_TYPE_LABELS } from '../../finance/model';
import { CSV_LIMITS, parseCsvStatement, StatementError, type CsvMapping, type Delimiter, type FieldRole } from '../../finance/csv';
import { decodeStatementBytes, looksLikeOfx, parseOfxStatements } from '../../finance/ofx';
import type { ParsedStatement } from '../../finance/drafts';
import type { ImportPlan, PlanItem } from '../../finance/importPlan';
import { commitImportPlan, createAccount, prepareImport, useFinance } from '../../finance/store';
import { toast } from '../../store/ui';
import { brl, btnCls, Card, inputCls, primaryCls } from './common';

type CsvParsed = ReturnType<typeof parseCsvStatement>;

const ROLE_LABELS: [FieldRole, string][] = [
  ['date', 'Data'], ['description', 'Descrição'], ['amount', 'Valor (com sinal)'], ['credit', 'Crédito'], ['debit', 'Débito'],
  ['id', 'ID da transação'], ['reference', 'Documento'], ['balance', 'Saldo (ignorado)'], ['category', 'Categoria'], ['type', 'Tipo'], ['status', 'Status'], ['operationDate', 'Data da operação'], ['memo', 'Observação'],
];

const STATUS_LABEL: Record<PlanItem['status'], string> = { new: 'Nova', duplicate: 'Já importada', conflict: 'Conflito', 'pending-update': 'Pendente → contabilizada', 'possible-duplicate': 'Possível duplicidade' };

export function ImportWizard({ initialAccountId, onClose }: { initialAccountId?: string | null; onClose: () => void }) {
  const accounts = useFinance((s) => s.accounts);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [format, setFormat] = useState<'csv' | 'ofx' | null>(null);
  const [text, setText] = useState('');
  const [csv, setCsv] = useState<CsvParsed | null>(null);
  const [ofx, setOfx] = useState<ParsedStatement[]>([]);
  const [ofxIndex, setOfxIndex] = useState(0);
  const [accountId, setAccountId] = useState(initialAccountId ?? '');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [newAcc, setNewAcc] = useState<{ institution: string; name: string; type: AccountType } | null>(null);

  const statement: ParsedStatement | null = format === 'csv' ? csv : format === 'ofx' ? ofx[ofxIndex] ?? null : null;

  const readFile = async (f: File) => {
    setError(''); setPlan(null); setCsv(null); setOfx([]); setFormat(null);
    setFileName(f.name);
    if (f.size > CSV_LIMITS.maxBytes) { setError(`Arquivo grande demais (limite de ${CSV_LIMITS.maxBytes / 1024 / 1024} MB). Nada foi importado.`); return; }
    if (f.size === 0) { setError('Arquivo vazio.'); return; }
    try {
      const t = decodeStatementBytes(await f.arrayBuffer());
      setText(t);
      if (/\.(ofx|qfx)$/i.test(f.name) || looksLikeOfx(t)) {
        const st = parseOfxStatements(t);
        setOfx(st); setOfxIndex(0); setFormat('ofx');
        const a = st[0].account;
        const match = accounts.find((x) => a?.maskedNumber && x.maskedNumber === a.maskedNumber);
        if (match) setAccountId(match.id);
        else if (!accountId) setNewAcc({ institution: a?.institutionName ?? '', name: a?.kind === 'card' ? 'Cartão' : 'Conta corrente', type: a?.kind === 'card' ? 'credit_card' : 'checking' });
      } else {
        setCsv(parseCsvStatement(t)); setFormat('csv');
      }
    } catch (e) {
      setError(e instanceof StatementError ? e.message : 'Não foi possível ler o arquivo com segurança. Nada foi importado.');
    }
  };

  const remap = (patch: Partial<CsvMapping>, delimiter?: Delimiter) => {
    if (!csv) return;
    setPlan(null);
    try {
      setCsv(parseCsvStatement(text, { delimiter: delimiter ?? csv.delimiter, mapping: delimiter ? undefined : { ...csv.mapping, ...patch } }));
      setError('');
    } catch (e) { setError(e instanceof StatementError ? e.message : 'Mapeamento inválido.'); }
  };
  const setColumn = (role: FieldRole, value: string) => {
    if (!csv) return;
    const columns = { ...csv.mapping.columns };
    if (value === '') delete columns[role]; else columns[role] = Number(value);
    remap({ columns });
  };

  const review = () => {
    if (!statement || !accountId) return;
    try { setPlan(prepareImport(accountId, statement)); setError(''); } catch (e) { setError((e as Error).message); }
  };

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const r = await commitImportPlan(plan, { origin: format === 'ofx' ? 'ofx' : 'csv', fileName, reportedBalance: format === 'ofx' && statement?.reportedBalance ? { ...statement.reportedBalance, origin: 'ofx' } : undefined });
      toast(`Importação concluída: ${r.added} nova(s), ${r.session.counts.duplicate} duplicada(s)${r.updated ? `, ${r.updated} pendente(s) atualizada(s)` : ''}${r.paired ? `, ${r.paired} par(es) conciliado(s)` : ''}.`, 'success', 6000);
      onClose();
    } catch (e) {
      setError(`Falha ao gravar: ${(e as Error).message} Nada foi importado.`);
    } finally { setBusy(false); }
  };

  const createNew = async () => {
    if (!newAcc) return;
    try {
      const acc = await createAccount({ institutionName: newAcc.institution || 'Instituição', name: newAcc.name || 'Conta', type: newAcc.type, number: statement?.account?.maskedNumber?.replace(/\D/g, '') });
      setAccountId(acc.id); setNewAcc(null);
    } catch (e) { setError((e as Error).message); }
  };

  const selected = accounts.find((a) => a.id === accountId);
  const includeToggle = (i: number, v: boolean) => setPlan((p) => (p ? { ...p, items: p.items.map((it, j) => (j === i ? { ...it, include: v } : it)) } : p));
  const toImport = plan ? plan.items.filter((i) => i.include && i.status !== 'duplicate').length : 0;

  return (
    <div className="flex flex-col gap-3" data-testid="import-wizard">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">Importar extrato</h2>
        <button className={btnCls} onClick={onClose} data-testid="import-cancel">Cancelar</button>
      </div>
      <div className="text-[11px] text-muted">Importação manual de arquivo (CSV ou OFX) exportado pelo seu banco — não é uma conexão Open Finance. O arquivo é lido só neste navegador; nada é enviado para a internet.</div>

      <Card title="1 · Arquivo">
        <input type="file" accept=".csv,.ofx,.qfx,.txt,text/csv" data-testid="import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} className="text-[12px]" />
        {format && <div className="mt-1 text-[11px] text-ok">Formato: {format.toUpperCase()}{format === 'csv' && csv ? ` · delimitador “${csv.delimiter === '\t' ? 'tab' : csv.delimiter}”` : ''}</div>}
        {format === 'ofx' && ofx.length > 1 && (
          <select className={`${inputCls} mt-1`} value={ofxIndex} onChange={(e) => { setOfxIndex(Number(e.target.value)); setPlan(null); }} aria-label="Extrato do arquivo">
            {ofx.map((s, i) => <option key={i} value={i}>{s.account?.kind === 'card' ? 'Cartão' : 'Conta'} {s.account?.maskedNumber} ({s.drafts.length} mov.)</option>)}
          </select>
        )}
      </Card>

      {error && <div className="rounded-lg border border-danger/50 bg-danger/10 p-2 text-[12px] text-danger" role="alert" data-testid="import-error">{error}</div>}

      {statement && (
        <Card title="2 · Conta de destino">
          <div className="flex flex-wrap gap-2 items-center">
            <select className={inputCls} value={accountId} aria-label="Conta de destino" data-testid="import-account" onChange={(e) => { setAccountId(e.target.value); setPlan(null); }}>
              <option value="">Escolha a conta…</option>
              {accounts.filter((a) => a.status === 'active').map((a: FinancialAccount) => <option key={a.id} value={a.id}>{a.name} {a.maskedNumber} · {ACCOUNT_TYPE_LABELS[a.type]}</option>)}
            </select>
            <button className={btnCls} onClick={() => setNewAcc({ institution: statement.account?.institutionName ?? '', name: '', type: statement.account?.kind === 'card' ? 'credit_card' : 'checking' })}>Nova conta</button>
          </div>
          {statement.account && <div className="text-[11px] text-soft mt-1">No arquivo: {statement.account.institutionName ?? 'instituição não informada'} · {statement.account.kind === 'card' ? 'cartão' : 'conta'} {statement.account.maskedNumber}</div>}
          {selected && statement.account?.maskedNumber && selected.maskedNumber && selected.maskedNumber !== statement.account.maskedNumber && (
            <div className="text-[11px] text-warn mt-1" data-testid="import-account-mismatch">⚠ O arquivo é da conta {statement.account.maskedNumber}, mas a conta escolhida é {selected.maskedNumber}. Confira para não misturar contas.</div>
          )}
          {newAcc && (
            <div className="mt-2 flex flex-wrap gap-2 items-center" data-testid="import-new-account">
              <input className={inputCls} placeholder="Instituição" aria-label="Instituição" value={newAcc.institution} onChange={(e) => setNewAcc({ ...newAcc, institution: e.target.value })} />
              <input className={inputCls} placeholder="Nome da conta" aria-label="Nome da nova conta" value={newAcc.name} onChange={(e) => setNewAcc({ ...newAcc, name: e.target.value })} />
              <select className={inputCls} aria-label="Tipo da nova conta" value={newAcc.type} onChange={(e) => setNewAcc({ ...newAcc, type: e.target.value as AccountType })}>
                {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
              </select>
              <button className={primaryCls} onClick={() => void createNew()}>Criar conta</button>
            </div>
          )}
        </Card>
      )}

      {format === 'csv' && csv && (
        <Card title="3 · Mapeamento das colunas">
          <div className="flex flex-wrap gap-2 text-[11px] items-center mb-2">
            <label>Delimitador <select className={inputCls} value={csv.delimiter} onChange={(e) => remap({}, e.target.value as Delimiter)} aria-label="Delimitador">
              <option value=";">;</option><option value=",">,</option><option value={'\t'}>tab</option><option value="|">|</option></select></label>
            <label>Decimal <select className={inputCls} value={csv.mapping.decimalSep} onChange={(e) => remap({ decimalSep: e.target.value as ',' | '.' })} aria-label="Separador decimal"><option value=",">vírgula (1.234,56)</option><option value=".">ponto (1,234.56)</option></select></label>
            <label>Datas <select className={inputCls} value={csv.mapping.dateOrder} onChange={(e) => remap({ dateOrder: e.target.value as 'dmy' | 'mdy' })} aria-label="Ordem das datas"><option value="dmy">dia/mês/ano</option><option value="mdy">mês/dia/ano</option></select></label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={csv.mapping.invertSign} onChange={(e) => remap({ invertSign: e.target.checked })} /> Inverter sinal (ex.: fatura com compras positivas)</label>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-[11px]">
            {ROLE_LABELS.map(([role, label]) => (
              <label key={role} className="flex flex-col gap-0.5">
                <span className="text-soft">{label}</span>
                <select className={inputCls} value={csv.mapping.columns[role] ?? ''} onChange={(e) => setColumn(role, e.target.value)} aria-label={`Coluna: ${label}`}>
                  <option value="">—</option>
                  {(csv.header ?? csv.preview[0] ?? []).map((h, i) => <option key={i} value={i}>{csv.header ? h || `Coluna ${i + 1}` : `Coluna ${i + 1} (${h.slice(0, 16)})`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-2 overflow-auto max-h-32 text-[10px] text-muted" data-scrollable>
            <table className="w-full"><tbody>{csv.preview.slice(0, 4).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="pr-2 whitespace-nowrap">{c.slice(0, 30)}</td>)}</tr>)}</tbody></table>
          </div>
        </Card>
      )}

      {statement && (
        <div className="flex items-center gap-2">
          <button className={primaryCls} disabled={!accountId} onClick={review} data-testid="import-review">Revisar ({statement.drafts.length} movimentações)</button>
          {!accountId && <span className="text-[11px] text-soft">Escolha a conta de destino.</span>}
        </div>
      )}

      {plan && statement && (
        <Card title="4 · Prévia e conciliação" testid="import-preview">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-[11px]" data-testid="import-summary">
            <div>Conta: <b>{selected?.name}</b> {selected?.maskedNumber}</div>
            <div>Período: <b>{plan.range ? `${plan.range.from.split('-').reverse().join('/')} a ${plan.range.to.split('-').reverse().join('/')}` : '—'}</b></div>
            <div>Movimentações: <b data-testid="import-count">{plan.items.length}</b></div>
            <div>Entradas: <b className="text-ok">{brl(plan.totals.inCents, plan.currency)}</b></div>
            <div>Saídas: <b className="text-danger">{brl(plan.totals.outCents, plan.currency)}</b></div>
            <div>Novas: <b data-testid="import-new">{plan.totals.newCount}</b></div>
            <div>Já importadas: <b data-testid="import-dup">{plan.totals.duplicateCount}</b></div>
            <div>Possíveis duplicidades: <b data-testid="import-possible">{plan.totals.possibleDuplicateCount}</b></div>
            <div>Conflitos: <b>{plan.totals.conflictCount}</b></div>
            <div>Pendentes atualizadas: <b>{plan.totals.pendingUpdateCount}</b></div>
            <div>Inválidas: <b className={plan.invalid.length ? 'text-warn' : ''} data-testid="import-invalid">{plan.invalid.length}</b></div>
            <div>Ignoradas: <b>{plan.ignored.length}</b></div>
            {statement.reportedBalance && <div className="col-span-2">Saldo informado pelo banco: <b>{brl(statement.reportedBalance.cents, plan.currency)}</b> em {statement.reportedBalance.asOf.split('-').reverse().join('/')}</div>}
          </div>
          <div className="text-[10px] text-soft mt-1">Transferências entre suas contas e pagamentos de fatura são conciliados depois de confirmar (pares inequívocos automaticamente; os demais aparecem como sugestão em Transações).</div>
          {plan.invalid.length > 0 && (
            <details className="mt-2 text-[11px] text-warn"><summary>Linhas inválidas ({plan.invalid.length}) — não serão importadas</summary>
              <ul className="max-h-24 overflow-auto" data-scrollable>{plan.invalid.slice(0, 100).map((r, i) => <li key={i}>Linha {r.line}: {r.reason}</li>)}</ul></details>
          )}
          {plan.warnings.map((w, i) => <div key={i} className="text-[11px] text-warn mt-1">⚠ {w}</div>)}
          <div className="mt-2 max-h-72 overflow-auto rounded border border-line/60" data-scrollable>
            <table className="w-full text-[11px]" data-testid="import-items">
              <thead className="sticky top-0 bg-panel text-soft"><tr><th className="p-1">Incluir</th><th className="text-left">Data</th><th className="text-left">Descrição</th><th className="text-right">Valor</th><th className="text-left pl-2">Situação</th></tr></thead>
              <tbody>
                {plan.items.slice(0, 500).map((it, i) => (
                  <tr key={i} className="border-t border-line/40" data-status={it.status}>
                    <td className="text-center"><input type="checkbox" aria-label={`Incluir linha ${it.draft.line}`} disabled={it.status === 'duplicate' || it.status === 'pending-update'} checked={it.include} onChange={(e) => includeToggle(i, e.target.checked)} /></td>
                    <td className="whitespace-nowrap">{it.draft.postedDate.split('-').reverse().join('/')}</td>
                    <td className="truncate max-w-[280px]" title={it.draft.description}>{it.draft.description}{it.draft.status === 'pending' ? ' (pendente)' : ''}</td>
                    <td className={`text-right whitespace-nowrap ${it.draft.amountCents < 0 ? 'text-danger' : 'text-ok'}`}>{brl(it.draft.amountCents, plan.currency)}</td>
                    <td className={`pl-2 ${it.status === 'new' ? 'text-ok' : it.status === 'duplicate' ? 'text-soft' : 'text-warn'}`} title={it.reason ?? it.warning}>{STATUS_LABEL[it.status]}{it.warning ? ' ⚠' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.items.length > 500 && <div className="text-[10px] text-soft p-1">Mostrando 500 de {plan.items.length}; todas seguem a decisão padrão.</div>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button className={primaryCls} disabled={busy || (!toImport && !plan.totals.pendingUpdateCount)} onClick={() => void confirm()} data-testid="import-confirm">{busy ? 'Gravando…' : `Confirmar importação (${toImport})`}</button>
            <span className="text-[11px] text-soft">Nada foi gravado ainda.</span>
          </div>
        </Card>
      )}
    </div>
  );
}

