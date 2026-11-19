/**
 * Prévia e confirmação das ações propostas pela IA (contrato v2, ver docs/AI_ACTIONS.md).
 * Nada é aplicado sem: prévia visível → botão explícito → diálogo de confirmação → revalidação no estado atual.
 */
import { useMemo, useRef, useState } from 'react';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import type { AIData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { formatMoney } from '../../core/finance';
import { ROLE_LABEL } from '../../core/scalar';
import { sanitizeTasks } from '../../core/widgetData';
import type { WidgetProps } from '../registry';
import { appendTasks } from './tasks';
import {
  aiEntryId,
  buildApplyPlan,
  crossCheck,
  destinationFromKey,
  destinationKey,
  destinationOptions,
  financeTargets,
  resolveMoney,
  suggestedDestination,
  targetWarning,
  type FinancialRequest,
  type MoneyAction,
  type ParsedProposal,
  type ProposedAction,
} from '../../integrations/aiActions';

interface Props {
  proposal: ParsedProposal;
  /** 'ai' = veio do modelo; 'local' = lida do pedido do usuário porque a IA não propôs ação financeira. */
  origin: 'ai' | 'local';
  applyKey: string;
  request: FinancialRequest | null;
  props: WidgetProps<AIData>;
  elements: AuroraElement[];
  validIds: Set<string>;
}

const ACTION_LABEL: Record<ProposedAction['type'], string> = { note: 'Nota', tasks: 'Tarefas', connect: 'Conexão', money: 'Financeiro' };

export function ProposalCard({ proposal, origin, applyKey, request, props, elements, validIds }: Props) {
  const { element, data, api } = props;
  const appliedAt = data.applied[applyKey];
  const targets = useMemo(() => financeTargets(elements, element.id, validIds), [elements, element.id, validIds]);
  const [include, setInclude] = useState<boolean[]>(() => proposal.actions.map(() => true));
  const [choice, setChoice] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    proposal.actions.forEach((a, i) => {
      if (a.type !== 'money') return;
      const d = suggestedDestination(a, targets);
      out[i] = d ? destinationKey(d) : '';
    });
    return out;
  });
  const busy = useRef(false);
  const validRef = useRef(validIds);
  validRef.current = validIds;
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);

  const resolved = proposal.actions.map((a, i) => {
    if (a.type !== 'money') return null;
    const dest = destinationFromKey(choice[i] ?? '');
    // Já aplicada: o bloco igual no quadro é o que ela mesma criou — não é aviso de duplicidade.
    return dest ? resolveMoney(a, dest, targets, aiEntryId(applyKey, i), appliedAt ? undefined : elements) : null;
  });
  const blocked = proposal.actions.some((a, i) => include[i] && a.type === 'money' && (!resolved[i] || resolved[i]!.errors.length > 0));
  const nothing = !include.some(Boolean);

  const plan = (els: AuroraElement[]) => {
    const ai = els.find((e): e is WidgetElement => e.id === element.id && e.type === 'widget');
    if (!ai) return { ok: false as const, errors: ['O bloco de IA não existe mais.'] };
    return buildApplyPlan({
      actions: proposal.actions,
      include,
      destinations: proposal.actions.map((_, i) => destinationFromKey(choice[i] ?? '')),
      elements: els,
      ai,
      applyKey,
      validIds: validRef.current,
    });
  };

  const apply = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const pre = plan(api.getElements());
      if (!pre.ok) { api.toast(pre.errors[0], 'error'); return; }
      const ok = await api.confirm(
        pre.plan.financial ? 'Confirmar alterações financeiras' : 'Criar elementos sugeridos pela IA',
        [...pre.plan.lines.map((l) => `• ${l}`), ...(pre.plan.warnings.length ? ['', ...pre.plan.warnings.map((w) => `⚠ ${w}`)] : []), '', 'Nada foi alterado ainda. Depois de aplicar, Ctrl+Z desfaz tudo de uma vez.'].join('\n'),
        'Aplicar no quadro',
      );
      if (!ok) return;
      // O quadro pode ter mudado com o diálogo aberto: revalida e exige o mesmo efeito que foi confirmado.
      const fresh = plan(api.getElements());
      if (!fresh.ok) { api.toast(fresh.errors[0], 'error'); return; }
      if (fresh.plan.lines.join('\n') !== pre.plan.lines.join('\n')) { api.toast('O quadro mudou durante a confirmação. Revise a proposta e confirme de novo.', 'warning'); return; }
      api.applyBatch(fresh.plan.add, fresh.plan.updates, true);
      api.toast('Proposta aplicada. Ctrl+Z desfaz.', 'success');
    } finally {
      busy.current = false;
    }
  };

  // Compatibilidade: tarefas podem ir para um bloco de Tarefas ligado por conexão de execução.
  const allTasks = proposal.actions.flatMap((a) => (a.type === 'tasks' ? a.tasks : []));
  const taskTargets = allTasks.length
    ? api
        .connections()
        .filter((c) => c.connection.kind === 'execution' && c.startBinding?.elementId === element.id && c.endBinding)
        .map((c) => api.getElement(c.endBinding!.elementId))
        .filter((e): e is WidgetElement => !!e && e.type === 'widget' && e.widgetType === WIDGET.tasks)
    : [];
  const sendToTasks = async (targetId: string, title: string) => {
    const ok = await api.confirm('Enviar tarefas', `Adicionar ${allTasks.length} tarefa(s) ao bloco “${title}”? (conexão de execução)`, 'Enviar');
    if (!ok) return;
    api.updateWidgetData(targetId, (d) => appendTasks(sanitizeTasks(d), allTasks));
    api.toast(`Tarefas enviadas para “${title}”.`, 'success');
  };

  const title = (id: string) => {
    const el = byId.get(id);
    return el ? (el.type === 'widget' ? el.title : el.text.trim().split('\n')[0] || el.type) : '?';
  };

  return (
    <div className="mt-1.5 rounded-lg border border-accent-2/40 bg-accent-2/10 p-2 text-[11px]" data-testid="ai-proposal" data-origin={origin} data-applied={appliedAt ? 'true' : 'false'}>
      <div className="font-bold text-accent-2 uppercase tracking-wider text-[10px] mb-1">
        {origin === 'local' ? 'Interpretação local do seu pedido' : 'Proposta estruturada'}
      </div>
      {origin === 'local' && (
        <div className="text-[10px] text-warn mb-1">A IA não propôs ação financeira. Esta prévia foi lida diretamente do seu pedido — confira antes de aplicar.</div>
      )}
      <ul className="flex flex-col gap-1">
        {proposal.actions.map((a, i) => (
          <li key={i} className="rounded-md border border-line/60 bg-[#0f1826] p-1.5" data-testid="ai-action" data-action-type={a.type}>
            <label className="flex items-start gap-1.5">
              <input
                type="checkbox"
                aria-label={`Incluir ação ${i + 1}`}
                checked={include[i]}
                disabled={!!appliedAt}
                onChange={(e) => setInclude((v) => v.map((x, j) => (j === i ? e.target.checked : x)))}
                className="accent-accent-2 mt-0.5"
              />
              <span className="flex-1 min-w-0">
                <span className="text-[9px] uppercase text-soft font-bold mr-1">{ACTION_LABEL[a.type]}</span>
                {a.type === 'note' && <span>“{a.title}”</span>}
                {a.type === 'tasks' && <span>“{a.title}” · {a.tasks.length} tarefa(s)</span>}
                {a.type === 'connect' && <span>{title(a.from)} → {title(a.to)}{a.label ? ` (${a.label})` : ''}</span>}
                {a.type === 'money' && <MoneyHeadline a={a} currency={resolved[i]?.currency} />}
              </span>
            </label>
            {a.type === 'money' && (
              <MoneyDetails
                a={a}
                index={i}
                targets={targets}
                choice={choice[i] ?? ''}
                setChoice={(k) => setChoice((c) => ({ ...c, [i]: k }))}
                resolved={resolved[i]}
                request={origin === 'ai' ? request : null}
                disabled={!!appliedAt}
              />
            )}
          </li>
        ))}
      </ul>
      {proposal.rejected.length > 0 && (
        <div className="mt-1 text-[10px] text-danger" data-testid="ai-rejected">
          {proposal.rejected.map((r) => <div key={r.index}>Ignorada (ação {r.index + 1}, {r.type}): {r.reason}</div>)}
        </div>
      )}
      {proposal.notices.map((n) => <div key={n} className="mt-1 text-[10px] text-warn">{n}</div>)}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        <button
          data-testid="ai-proposal-apply"
          disabled={!!appliedAt || blocked || nothing || !proposal.actions.length}
          onClick={apply}
          className="h-7 px-2 rounded-md bg-[#5b46a8] text-white font-semibold disabled:opacity-50"
        >
          {appliedAt ? 'Aplicada' : 'Revisar e aplicar…'}
        </button>
        {taskTargets.map((t) => (
          <button key={t.id} onClick={() => sendToTasks(t.id, t.title)} className="h-7 px-2 rounded-md border border-ok/50 text-ok">Enviar para “{t.title}”…</button>
        ))}
      </div>
      <div className="text-[10px] text-soft mt-1">
        {appliedAt ? `Aplicada em ${new Date(appliedAt).toLocaleString('pt-BR')}. Ctrl+Z desfaz.` : blocked ? 'Escolha um destino válido para cada valor financeiro.' : 'Nada é criado ou alterado sem sua confirmação.'}
      </div>
    </div>
  );
}

function MoneyHeadline({ a, currency }: { a: MoneyAction; currency?: string }) {
  const cur = (currency ?? a.currency ?? 'BRL') as 'BRL' | 'USD' | 'EUR';
  const color = a.role === 'income' ? 'text-ok' : a.role === 'expense' ? 'text-danger' : 'text-fg';
  return (
    <span data-testid="ai-money">
      <b className={color}>{ROLE_LABEL[a.role]}</b> <b className="tabular-nums">{formatMoney(a.amountCents, cur)}</b>
      <span className="text-soft"> · {cur} · {a.amountCents} centavos{a.installments > 1 ? ` · ${a.installments} parcelas` : ''}{a.title ? ` · “${a.title}”` : ''}</span>
    </span>
  );
}

function MoneyDetails(p: {
  a: MoneyAction;
  index: number;
  targets: ReturnType<typeof financeTargets>;
  choice: string;
  setChoice: (k: string) => void;
  resolved: ReturnType<typeof resolveMoney> | null;
  request: FinancialRequest | null;
  disabled: boolean;
}) {
  const options = destinationOptions(p.a, p.targets);
  // Já aplicada: recalcular o efeito contra o quadro atual mostraria o lançamento somado duas vezes
  // e “já foi aplicado” como erro. Mostra só o destino usado.
  if (p.disabled) {
    return (
      <div className="mt-1 pl-5 text-[10px] text-soft" data-testid="ai-applied-dest">
        Destino: {options.find((o) => o.key === p.choice)?.label ?? 'removido do quadro'}
      </div>
    );
  }
  const warnings = [...crossCheck(p.a, p.request), ...[targetWarning(p.a, p.targets)].filter((w): w is string => !!w), ...(p.resolved?.warnings ?? [])];
  return (
    <div className="mt-1 flex flex-col gap-0.5 pl-5">
      <select
        aria-label={`Destino da ação ${p.index + 1}`}
        data-testid="ai-destination"
        value={p.choice}
        disabled={p.disabled}
        onChange={(e) => p.setChoice(e.target.value)}
        className="h-7 px-1.5 rounded-md bg-[#0a111c] border border-line text-[11px]"
      >
        <option value="" disabled>Escolha o destino…</option>
        {options.map((o) => (
          <option key={o.key} value={o.key} disabled={o.disabled}>{o.label}{o.disabled ? ` — ${o.reason}` : ''}</option>
        ))}
      </select>
      {!p.choice && (
        <div className="text-warn" data-testid="ai-needs-choice">
          {p.a.ambiguous ? 'Pedido ambíguo: escolha se cria um bloco independente ou um lançamento em Finanças.' : 'Escolha onde registrar este valor.'}
        </div>
      )}
      {p.resolved && <div className="text-fg-2" data-testid="ai-effect">{p.resolved.effect}</div>}
      {p.resolved && p.resolved.defaults.length > 0 && <div className="text-[10px] text-soft" data-testid="ai-defaults">Padrões: {p.resolved.defaults.join(' · ')}</div>}
      {warnings.map((w) => <div key={w} className="text-[10px] text-warn" data-testid="ai-warning">⚠ {w}</div>)}
      {p.resolved?.errors.map((e) => <div key={e} className="text-[10px] text-danger" data-testid="ai-error">{e}</div>)}
    </div>
  );
}
