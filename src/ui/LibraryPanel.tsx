import { useEffect, useState } from 'react';
import { ImageIcon, Search, ShieldCheck } from 'lucide-react';
import { setState, useEditor } from '../store/editor';
import { addWidget, pickImages } from '../store/actions';
import { listPlanned, listWidgets, PERMISSION_LABELS, type WidgetPlugin } from '../widgets/registry';
import { STATUS_LABEL } from '../widgets/WidgetFrame';
import { WIDGET_DRAG_MIME } from '../canvas/Canvas';
import { fetchAIStatus, type AIStatus } from '../integrations/aiClient';
import { WIDGET } from '../core/widgetIds';

function useAIConfigured() {
  const [s, setS] = useState<AIStatus | null>(null);
  useEffect(() => { fetchAIStatus().then(setS); }, []);
  if (!s) return null;
  return s.state === 'ready' && s.providers.some((p) => p.configured);
}

function effectiveStatus(p: WidgetPlugin, aiConfigured: boolean | null) {
  if (p.id === WIDGET.ai && aiConfigured === false) return 'needs-config';
  return p.status;
}

export function LibraryPanel() {
  const open = useEditor((s) => s.libraryOpen);
  const compact = useEditor((s) => s.compact);
  const add = (fn: () => void) => { fn(); if (compact) setState({ libraryOpen: false }); };
  const [q, setQ] = useState('');
  const aiConfigured = useAIConfigured();
  if (!open) return null;
  const widgets = listWidgets().filter((w) => !q || `${w.name} ${w.description}`.toLowerCase().includes(q.toLowerCase()));
  const categories = [...new Set(widgets.map((w) => w.category))];
  const planned = listPlanned().filter((p) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <aside className={`w-64 shrink-0 bg-panel border-r border-line flex flex-col ${compact ? 'absolute inset-y-0 left-0 z-40 max-w-[85vw] shadow-[20px_0_50px_#000a]' : 'z-20'}`} aria-label="Biblioteca de componentes">
      <div className="p-3 pb-2">
        <div className="text-[10px] font-bold tracking-widest text-soft mb-2">BIBLIOTECA</div>
        <label className="flex items-center gap-2 h-8 px-2 rounded-lg border border-line bg-[#0f1826]">
          <Search size={13} className="text-soft" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar componentes" className="bg-transparent outline-none text-[12px] flex-1 min-w-0" />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="text-[10px] text-soft px-1.5 mb-2">Clique para inserir no centro ou arraste para o quadro.</div>
        {(!q || 'imagem'.includes(q.toLowerCase())) && (
          <LibItem
            name="Imagem"
            description="Inserir imagem do dispositivo (ou cole/arraste no quadro)."
            icon={<ImageIcon size={16} />}
            accent="#f59abf"
            status="ready"
            dragType="tool:image"
            onAdd={() => add(() => void pickImages())}
          />
        )}
        {categories.map((c) => (
          <div key={c} className="mt-2">
            <div className="text-[10px] font-bold tracking-wider text-soft px-1.5 mb-1 uppercase">{c}</div>
            {widgets.filter((w) => w.category === c).map((w) => (
              <LibItem
                key={w.id}
                name={w.name}
                description={w.description}
                icon={<w.icon size={16} />}
                accent={w.accent}
                status={effectiveStatus(w, aiConfigured)}
                dragType={w.id}
                permissions={w.permissions.map((p) => PERMISSION_LABELS[p])}
                note={w.statusNote}
                onAdd={() => add(() => addWidget(w.id))}
              />
            ))}
          </div>
        ))}
        {planned.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] font-bold tracking-wider text-soft px-1.5 mb-1 uppercase">Integrações futuras</div>
            {planned.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5 px-2 py-2 rounded-lg opacity-60" title={`Ainda não implementado. ${p.activation}`}>
                <span className="w-8 h-8 shrink-0 grid place-items-center rounded-lg border border-line text-muted"><p.icon size={15} /></span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold">{p.name} <span className={`text-[9px] px-1 rounded border ${STATUS_LABEL.planned.cls}`}>Futuro</span></div>
                  <div className="text-[10px] text-soft leading-snug">{p.description}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 mx-1 rounded-lg border border-line p-2 text-[10px] text-soft leading-relaxed flex gap-1.5">
          <ShieldCheck size={13} className="shrink-0 text-ok mt-0.5" />
          Plugins de terceiros rodam isolados (iframe sandbox) e só recebem dados por conexões explícitas.
        </div>
      </div>
    </aside>
  );
}

function LibItem(props: {
  name: string;
  description: string;
  icon: React.ReactNode;
  accent: string;
  status: string;
  dragType: string;
  permissions?: string[];
  note?: string;
  onAdd: () => void;
}) {
  const st = STATUS_LABEL[props.status];
  return (
    <button
      draggable
      data-library-item={props.dragType}
      onDragStart={(e) => {
        e.dataTransfer.setData(WIDGET_DRAG_MIME, props.dragType);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={props.onAdd}
      title={[props.description, props.note, props.permissions?.length ? `Permissões: ${props.permissions.join('; ')}` : ''].filter(Boolean).join('\n')}
      className="w-full flex items-start gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-panel-3 border border-transparent hover:border-line transition-colors"
    >
      <span className="w-8 h-8 shrink-0 grid place-items-center rounded-lg" style={{ color: props.accent, background: `${props.accent}1f`, border: `1px solid ${props.accent}55` }}>
        {props.icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
          {props.name}
          {props.status !== 'ready' && st && <span className={`text-[9px] px-1 rounded border ${st.cls}`}>{st.label}</span>}
        </span>
        <span className="block text-[10px] text-soft leading-snug line-clamp-2">{props.description}</span>
      </span>
    </button>
  );
}
