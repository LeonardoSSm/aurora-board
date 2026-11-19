/**
 * Sugestões de categoria vindas da IA (ciclo F1). Só valem para movimentações que o usuário autorizou
 * (modo detalhado de uma consulta bancária conectada e autorizada), só para categorias existentes, e só são
 * aplicadas depois de prévia + confirmação. A mudança vai para a classificação LOCAL (o registro do banco
 * não é alterado) e pode ser desfeita reclassificando em Minhas contas.
 */
import { useMemo, useState } from 'react';
import type { AuroraElement } from '../../core/schema';
import type { AIData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney } from '../../core/finance';
import type { BankTransaction } from '../../finance/model';
import { classifyTransaction, getFinance, useFinance } from '../../finance/store';
import { runBankQuery, sanitizeBankQuery } from '../../finance/query';
import { buildFinanceAIText, parseCategorySuggestions, shareAuthorized, txRef } from '../../finance/aiShare';
import { currentPeriod } from '../../core/scalar';
import type { WidgetProps } from '../registry';

/** Referências opacas autorizadas no contexto atual → movimentação. */
export function authorizedBankRefs(elements: AuroraElement[], validIds: ReadonlySet<string>): Map<string, BankTransaction> {
  const out = new Map<string, BankTransaction>();
  const fin = getFinance();
  for (const el of elements) {
    if (el.type !== 'widget' || el.widgetType !== WIDGET.bankQuery || !validIds.has(el.id)) continue;
    const q = sanitizeBankQuery(el.data, currentPeriod());
    if (q.aiShare.mode !== 'detail' || !shareAuthorized(q)) continue;
    const r = runBankQuery(fin, q);
    const p = buildFinanceAIText(q, r, fin, el.title);
    const refs = new Set(p.refs);
    for (const t of r.txs) if (refs.has(txRef(t))) out.set(txRef(t), t);
  }
  return out;
}

export function CategorySuggestionCard({ reply, messageId, props, elements, validIds }: { reply: string; messageId: string; props: WidgetProps<AIData>; elements: AuroraElement[]; validIds: Set<string> }) {
  const { data, update, api } = props;
  const version = useFinance((s) => s.version);
  const categories = useFinance((s) => s.categories);
  const allowed = useMemo(() => authorizedBankRefs(elements, validIds), [elements, validIds, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = useMemo(() => parseCategorySuggestions(reply, allowed, categories.map((c) => c.name)), [reply, allowed, categories]);
  const key = `${messageId}:categorize`;
  const appliedAt = data.applied[key];
  const [include, setInclude] = useState<Record<string, boolean>>({});
  if (!parsed || (!parsed.items.length && !parsed.rejected.length)) return null;
  const chosen = parsed.items.filter((i) => include[i.ref] !== false);
  const txOf = (id: string) => getFinance().transactions.find((t) => t.id === id);

  const apply = async () => {
    const lines = chosen.map((s) => { const t = txOf(s.txId); return t ? `• ${t.postedDate} ${formatMoney(t.amountCents, t.currency)}: ${s.from} → ${s.category}` : ''; }).filter(Boolean);
    const ok = await api.confirm('Alterar categorias (classificação local)', [...lines, '', 'O registro original do banco não muda. Você pode reclassificar depois em Minhas contas.'].join('\n'), 'Aplicar categorias');
    if (!ok) return;
    // Revalida: a autorização pode ter caído durante o diálogo.
    const now = parseCategorySuggestions(reply, authorizedBankRefs(api.getElements(), validIds), getFinance().categories.map((c) => c.name));
    const valid = new Set(now?.items.map((i) => i.ref));
    let n = 0;
    for (const s of chosen) {
      if (!valid.has(s.ref)) continue;
      await classifyTransaction(s.txId, { category: s.category });
      n++;
    }
    update((d) => ({ ...d, applied: { ...d.applied, [key]: Date.now() } }));
    api.toast(n === chosen.length ? `${n} categoria(s) atualizada(s).` : `${n} de ${chosen.length} aplicada(s): o restante saiu da autorização.`, n ? 'success' : 'warning');
  };

  return (
    <div className="mt-1.5 rounded-lg border border-[#63d7dd]/40 bg-[#63d7dd]/10 p-2 text-[11px]" data-testid="ai-categorize" data-applied={appliedAt ? 'true' : 'false'}>
      <div className="font-bold text-[#63d7dd] uppercase tracking-wider text-[10px] mb-1">Sugestões de categoria</div>
      <ul className="flex flex-col gap-0.5">
        {parsed.items.map((s) => {
          const t = txOf(s.txId);
          return (
            <li key={s.ref}>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-accent-2" disabled={!!appliedAt} checked={include[s.ref] !== false} onChange={(e) => setInclude((v) => ({ ...v, [s.ref]: e.target.checked }))} aria-label={`Aplicar sugestão ${s.ref}`} />
                <span className="truncate flex-1">{t ? `${t.postedDate} · ${formatMoney(t.amountCents, t.currency)}` : s.ref}: {s.from} → <b>{s.category}</b></span>
              </label>
            </li>
          );
        })}
      </ul>
      {parsed.rejected.length > 0 && <ul className="mt-1 text-warn text-[10px]">{parsed.rejected.slice(0, 5).map((r, i) => <li key={i}>⚠ {r.ref}: {r.reason}</li>)}</ul>}
      {parsed.items.length > 0 && (
        appliedAt ? <div className="mt-1 text-ok">✓ Aplicadas.</div> : <button className="mt-1 h-6 px-2 rounded-md bg-[#2b6f74] text-white" disabled={!chosen.length} onClick={() => void apply()}>Revisar e aplicar</button>
      )}
    </div>
  );
}
