import { useState } from 'react';
import { ListChecks, Trash2 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeTasks, type TaskItem, type TaskPriority, type TasksData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { uid } from '../../core/elements';
import { Empty } from '../../ui/primitives';

const PRIORITY: Record<TaskPriority, { label: string; cls: string }> = {
  low: { label: 'Baixa', cls: 'text-soft border-line' },
  medium: { label: 'Média', cls: 'text-accent border-accent/40' },
  high: { label: 'Alta', cls: 'text-danger border-danger/40' },
};
const NEXT_PRIORITY: Record<TaskPriority, TaskPriority> = { low: 'medium', medium: 'high', high: 'low' };
const STATUS_LABEL = { todo: 'A fazer', doing: 'Fazendo', done: 'Feito' } as const;

export function appendTasks(data: TasksData, texts: { text: string; priority?: TaskPriority }[]): TasksData {
  return {
    ...data,
    items: [...data.items, ...texts.filter((t) => t.text.trim()).map((t) => ({ id: uid(), text: t.text.trim(), status: 'todo' as const, priority: t.priority ?? 'medium', dueDate: '' }))],
  };
}

export const tasksPlugin: WidgetPlugin<TasksData> = {
  id: WIDGET.tasks,
  name: 'Tarefas',
  description: 'Checklist com estados, prioridades e datas opcionais.',
  icon: ListChecks,
  version: '1.0.0',
  category: 'Produtividade',
  status: 'ready',
  accent: '#5addaa',
  permissions: [],
  defaultSize: { width: 320, height: 300 },
  inputs: [{ id: 'incoming', label: 'Tarefas recebidas', type: 'tasks' }],
  outputs: [
    { id: 'tasks', label: 'Tarefas', type: 'tasks' },
    { id: 'open', label: 'Pendentes', type: 'number' },
  ],
  createData: () => ({ items: [], hideDone: false }),
  sanitize: sanitizeTasks,
  compute: (d) => ({ tasks: d.items, open: d.items.filter((i) => i.status !== 'done').length }),
  summarize: (d) => d.items.map((i) => `[${i.status === 'done' ? 'x' : i.status === 'doing' ? '~' : ' '}] ${i.text} (prioridade ${PRIORITY[i.priority].label}${i.dueDate ? `, prazo ${i.dueDate}` : ''})`).join('\n'),
  Component: function Tasks({ data, update, inputs }) {
    const [draft, setDraft] = useState('');
    const items = data.hideDone ? data.items.filter((i) => i.status !== 'done') : data.items;
    const done = data.items.filter((i) => i.status === 'done').length;
    const patch = (id: string, p: Partial<TaskItem>) => update((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));
    const incoming = (inputs.incoming ?? []).flatMap((v) => (Array.isArray(v.value) ? (v.value as TaskItem[]).map((t) => ({ ...t, from: v.sourceTitle })) : []));
    const add = () => {
      if (!draft.trim()) return;
      update((d) => appendTasks(d, [{ text: draft }]));
      setDraft('');
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span data-testid="tasks-progress">{done}/{data.items.length} concluídas</span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={data.hideDone} onChange={(e) => update({ hideDone: e.target.checked })} className="accent-accent" />
            Ocultar feitas
          </label>
        </div>
        {data.items.length > 0 && (
          <div className="h-1 rounded bg-panel-3 overflow-hidden">
            <div className="h-full bg-ok transition-all" style={{ width: `${(done / data.items.length) * 100}%` }} />
          </div>
        )}
        <ul className="flex flex-col">
          {items.map((i) => (
            <li key={i.id} className="group flex items-center gap-2 py-1.5 border-b border-line/50">
              <input
                type="checkbox"
                aria-label={`Concluir ${i.text}`}
                checked={i.status === 'done'}
                onChange={(e) => patch(i.id, { status: e.target.checked ? 'done' : 'todo' })}
                className="accent-ok w-4 h-4 shrink-0"
              />
              <input
                value={i.text}
                onChange={(e) => update((d) => ({ ...d, items: d.items.map((x) => (x.id === i.id ? { ...x, text: e.target.value } : x)) }), { coalesce: true })}
                className={`flex-1 min-w-0 bg-transparent outline-none text-[13px] ${i.status === 'done' ? 'line-through text-soft' : 'text-fg'}`}
              />
              <button
                onClick={() => patch(i.id, { status: i.status === 'todo' ? 'doing' : i.status === 'doing' ? 'done' : 'todo' })}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${i.status === 'doing' ? 'text-warn border-warn/40' : 'text-soft border-line'}`}
                title="Alternar estado"
              >
                {STATUS_LABEL[i.status]}
              </button>
              <button onClick={() => patch(i.id, { priority: NEXT_PRIORITY[i.priority] })} className={`text-[10px] px-1.5 py-0.5 rounded border ${PRIORITY[i.priority].cls}`} title="Alternar prioridade">
                {PRIORITY[i.priority].label}
              </button>
              <input
                type="date"
                aria-label="Prazo"
                value={i.dueDate}
                onChange={(e) => patch(i.id, { dueDate: e.target.value })}
                className={`bg-transparent text-[10px] text-muted w-[92px] outline-none ${i.dueDate ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
              />
              <button aria-label="Remover tarefa" onClick={() => update((d) => ({ ...d, items: d.items.filter((x) => x.id !== i.id) }))} className="text-soft hover:text-danger opacity-0 group-hover:opacity-100">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
        {!data.items.length && <Empty>Nenhuma tarefa ainda.</Empty>}
        <div className="flex gap-1.5">
          <input
            value={draft}
            placeholder="Nova tarefa e Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            className="flex-1 h-8 px-2 rounded-lg bg-[#0f1826] border border-line/70 outline-none focus:border-accent text-[13px]"
          />
          <button onClick={add} className="h-8 px-2.5 rounded-lg border border-dashed border-line text-accent text-xs hover:bg-panel-3">Adicionar</button>
        </div>
        {incoming.length > 0 && (
          <div className="mt-1 rounded-lg border border-ok/30 bg-ok/5 p-2">
            <div className="text-[10px] uppercase tracking-wider font-bold text-ok mb-1">Recebidas por conexão de dados</div>
            {incoming.slice(0, 8).map((t) => (
              <div key={t.id} className="text-[12px] text-fg-2 truncate">• {t.text} <span className="text-soft">— {t.from}</span></div>
            ))}
            <button
              className="mt-1.5 text-[11px] text-ok hover:underline"
              onClick={() => update((d) => appendTasks(d, incoming.filter((t) => t.status !== 'done').map((t) => ({ text: t.text, priority: t.priority }))))}
            >
              Copiar pendentes para esta lista
            </button>
          </div>
        )}
      </div>
    );
  },
};
