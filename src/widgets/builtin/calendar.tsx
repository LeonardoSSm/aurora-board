import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeCalendar, type CalendarData, type CalendarEvent } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { uid } from '../../core/elements';

const WEEK = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const calendarPlugin: WidgetPlugin<CalendarData> = {
  id: WIDGET.calendar,
  name: 'Calendário',
  description: 'Calendário local com eventos, datas e horários. Google Calendar: preparado, não configurado.',
  icon: CalendarDays,
  version: '1.0.0',
  category: 'Produtividade',
  status: 'ready',
  statusNote: 'Funciona localmente. A sincronização com Google Calendar exige OAuth (ver docs).',
  accent: '#6ca7ff',
  permissions: [],
  defaultSize: { width: 340, height: 400 },
  inputs: [],
  outputs: [{ id: 'events', label: 'Eventos', type: 'events' }],
  createData: () => sanitizeCalendar({}),
  sanitize: sanitizeCalendar,
  compute: (d) => ({ events: d.events }),
  summarize: (d) =>
    [...d.events]
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map((e) => `${e.date}${e.time ? ` ${e.time}${e.endTime ? `–${e.endTime}` : ''}` : ''}: ${e.title}${e.notes ? ` — ${e.notes}` : ''}`)
      .join('\n'),
  Component: function Calendar({ data, update }) {
    const [selected, setSelected] = useState(todayISO());
    const [title, setTitle] = useState('');
    const [time, setTime] = useState('');
    const [y, m] = data.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();
    const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
    const iso = (d: number) => `${data.month}-${String(d).padStart(2, '0')}`;
    const byDate = new Map<string, CalendarEvent[]>();
    for (const e of data.events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    const dayEvents = [...(byDate.get(selected) ?? [])].sort((a, b) => a.time.localeCompare(b.time));
    const add = () => {
      if (!title.trim()) return;
      update((d) => ({ ...d, events: [...d.events, { id: uid(), title: title.trim(), date: selected, time, endTime: '', notes: '' }] }));
      setTitle('');
      setTime('');
    };
    const monthName = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <button aria-label="Mês anterior" onClick={() => update({ month: shiftMonth(data.month, -1) })} className="p-1 rounded hover:bg-panel-3"><ChevronLeft size={14} /></button>
          <div className="font-semibold capitalize text-fg">{monthName}</div>
          <button aria-label="Próximo mês" onClick={() => update({ month: shiftMonth(data.month, 1) })} className="p-1 rounded hover:bg-panel-3"><ChevronRight size={14} /></button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px]">
          {WEEK.map((w, i) => <div key={i} className="text-soft font-bold py-0.5">{w}</div>)}
          {cells.map((d, i) =>
            d === null ? <div key={i} /> : (
              <button
                key={i}
                onClick={() => setSelected(iso(d))}
                className={`relative h-7 rounded-md text-[11px] ${selected === iso(d) ? 'bg-accent/25 text-white border border-accent/60' : iso(d) === todayISO() ? 'text-accent border border-accent/30' : 'text-fg-2 hover:bg-panel-3 border border-transparent'}`}
              >
                {d}
                {byDate.has(iso(d)) && <span className="absolute left-1/2 -translate-x-1/2 bottom-0.5 w-1 h-1 rounded-full bg-accent-2" />}
              </button>
            ),
          )}
        </div>
        <div className="text-[11px] text-muted font-semibold mt-1">{selected.split('-').reverse().join('/')}</div>
        <ul className="flex flex-col">
          {dayEvents.map((e) => (
            <li key={e.id} className="group flex items-center gap-2 py-1 border-b border-line/50 text-[12px]">
              <span className="text-accent w-10 shrink-0">{e.time || '—'}</span>
              <input
                className="flex-1 min-w-0 bg-transparent outline-none"
                value={e.title}
                onChange={(ev) => update((d) => ({ ...d, events: d.events.map((x) => (x.id === e.id ? { ...x, title: ev.target.value } : x)) }), { coalesce: true })}
              />
              <button aria-label="Remover evento" className="text-soft hover:text-danger opacity-0 group-hover:opacity-100" onClick={() => update((d) => ({ ...d, events: d.events.filter((x) => x.id !== e.id) }))}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
          {!dayEvents.length && <li className="text-[11px] text-soft italic">Sem eventos neste dia.</li>}
        </ul>
        <div className="flex gap-1">
          <input type="time" aria-label="Horário" value={time} onChange={(e) => setTime(e.target.value)} className="h-8 px-1 rounded-lg bg-[#0f1826] border border-line text-[11px] w-[84px]" />
          <input placeholder="Novo evento e Enter" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[12px]" />
        </div>
        <div className="text-[10px] text-soft">Agenda local · Google Calendar não configurado</div>
      </div>
    );
  },
};
