/**
 * “Locais”: gerenciador dos checkpoints do quadro (não substitui o painel de Quadros:
 * quadro = documento espacial; checkpoint = lugar dentro dele) e formulário de criar/editar.
 */
import { useEffect, useRef, useState } from 'react';
import { usePanelLayout } from './PanelResizer';
import { ArrowDown, ArrowUp, Copy, Crosshair, LocateFixed, MapPin, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useEditor, setState } from '../store/editor';
import { confirmDialog } from '../store/ui';
import {
  addCheckpoint, deleteCheckpoint, duplicateCheckpoint, moveCheckpointToView, navigateToCheckpoint,
  openCheckpointCreate, openCheckpointEdit, reorderCheckpoint, setCheckpointIndicators, updateCheckpoint,
} from '../store/checkpointActions';
import { CHECKPOINT_COLORS, CHECKPOINT_ICONS, CHECKPOINT_LIMITS, type CheckpointIcon } from '../core/checkpoints';
import { CHECKPOINT_ICON } from '../canvas/CheckpointLayer';
import { cancelCameraAnimation, isCameraAnimating } from '../store/cameraMotion';

export function LocationsPanel() {
  const open = useEditor((s) => s.locationsOpen);
  const cps = useEditor((s) => s.checkpoints);
  const compact = useEditor((s) => s.compact);
  const show = useEditor((s) => s.boards.find((b) => b.id === s.boardId)?.settings.showCheckpointIndicators !== false);
  const [q, setQ] = useState('');
  // Ancorado à direita da Biblioteca, que agora tem largura variável (issue #10).
  const lib = usePanelLayout('library');
  const libraryOpen = useEditor((s) => s.libraryOpen);
  if (!open) return null;
  const left = libraryOpen ? lib.width + 12 : 12;
  const needle = q.trim().toLowerCase();
  const list = cps.filter((c) => !needle || `${c.name} ${c.description}`.toLowerCase().includes(needle));
  const close = () => setState({ locationsOpen: false });
  return (
    <aside
      role="dialog"
      aria-label="Locais"
      data-testid="locations-panel"
      style={compact ? undefined : { left: Math.min(left, Math.max(12, window.innerWidth - 332)) }}
      className={`fixed z-[60] glass rounded-2xl flex flex-col max-h-[70vh] ${compact ? 'left-2 right-2 top-14' : 'top-14 w-[320px] max-w-[calc(100vw-24px)]'}`}
      // Esc: primeiro interrompe a viagem em curso (a câmera fica onde está); com a câmera parada, fecha o painel.
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { if (isCameraAnimating()) cancelCameraAnimation(); else close(); } }}
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <div>
          <div className="text-[13px] font-bold flex items-center gap-1.5"><MapPin size={14} className="text-accent" /> Locais</div>
          <div className="text-[10px] text-soft">Pontos de referência deste quadro · atalho G</div>
        </div>
        <button aria-label="Fechar locais" className="p-1.5 rounded-lg hover:bg-panel-3" onClick={close}><X size={15} /></button>
      </div>
      <div className="px-3 pt-2 flex gap-1.5">
        <label className="flex-1 flex items-center gap-2 h-8 px-2 rounded-lg border border-line bg-[#0f1826]">
          <Search size={13} className="text-soft" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar locais" aria-label="Filtrar locais" className="bg-transparent outline-none text-[12px] flex-1 min-w-0" />
        </label>
        <button type="button" onClick={() => openCheckpointCreate()} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-[#3174db] text-white text-[12px] font-semibold" title="Salvar o centro da visão atual como checkpoint">
          <Plus size={13} /> Salvar aqui
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5" data-testid="locations-list">
        {list.length === 0 && (
          <li className="px-2 py-3 text-[12px] text-soft leading-relaxed">
            {cps.length ? 'Nenhum local com esse nome.' : 'Nenhum local ainda. Use “Salvar aqui” ou clique com o botão direito num espaço vazio → “Adicionar checkpoint aqui”.'}
          </li>
        )}
        {list.map((c, i) => {
          const Icon = CHECKPOINT_ICON[c.icon];
          return (
            <li key={c.id} className="group flex items-center gap-1 rounded-lg hover:bg-panel-3" data-testid="location-item" data-id={c.id}>
              <button type="button" className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left" onClick={() => navigateToCheckpoint(c.id)} title={c.description || `Ir para ${c.name}`} aria-label={`Ir para ${c.name}`}>
                <span className="w-6 h-6 shrink-0 grid place-items-center rounded-full border" style={{ borderColor: c.color, color: c.color }}><Icon size={12} /></span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-fg truncate">{c.name}</span>
                  {c.description && <span className="block text-[10px] text-soft truncate">{c.description}</span>}
                </span>
              </button>
              <div className="flex items-center opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 pr-1">
                <IconBtn label={`Subir ${c.name}`} disabled={i === 0 || !!needle} onClick={() => reorderCheckpoint(c.id, -1)}><ArrowUp size={12} /></IconBtn>
                <IconBtn label={`Descer ${c.name}`} disabled={i === list.length - 1 || !!needle} onClick={() => reorderCheckpoint(c.id, 1)}><ArrowDown size={12} /></IconBtn>
                <IconBtn label={`Editar ${c.name}`} onClick={() => openCheckpointEdit(c.id)}><Pencil size={12} /></IconBtn>
                <IconBtn
                  label={`Excluir ${c.name}`}
                  onClick={async () => { if (await confirmDialog('Excluir local', `Excluir “${c.name}”? Os elementos do quadro não mudam. Ctrl+Z desfaz.`, 'Excluir', true)) deleteCheckpoint(c.id); }}
                ><Trash2 size={12} /></IconBtn>
              </div>
            </li>
          );
        })}
      </ul>
      <label className="flex items-center gap-2 px-3 pb-3 pt-1 text-[11px] text-fg-2 border-t border-line/60">
        <input type="checkbox" className="accent-accent" checked={show} onChange={(e) => setCheckpointIndicators(e.target.checked)} />
        Mostrar indicadores nas bordas da tela
      </label>
    </aside>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="p-1.5 rounded-md text-soft hover:text-fg hover:bg-panel disabled:opacity-25">
      {children}
    </button>
  );
}

/** Formulário de checkpoint (criar ou editar). Nome obrigatório. */
export function CheckpointDialog() {
  const editor = useEditor((s) => s.checkpointEditor);
  const cps = useEditor((s) => s.checkpoints);
  const zoom = useEditor((s) => s.camera.zoom);
  const editing = editor?.mode === 'edit' ? cps.find((c) => c.id === editor.id) : undefined;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(CHECKPOINT_COLORS[0]);
  const [icon, setIcon] = useState<CheckpointIcon>('pin');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const key = editor ? (editor.mode === 'edit' ? editor.id : `new:${editor.x},${editor.y}`) : '';
  useEffect(() => {
    saving.current = false;
    setError('');
    if (editing) {
      setName(editing.name); setDescription(editing.description); setColor(editing.color); setIcon(editing.icon); setRemember(editing.restoreZoom && editing.savedZoom !== null);
    } else if (editor) {
      setName(''); setDescription(''); setColor(CHECKPOINT_COLORS[cps.length % CHECKPOINT_COLORS.length]); setIcon('pin'); setRemember(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editor || (editor.mode === 'edit' && !editing)) return null;
  const close = () => setState({ checkpointEditor: null });
  const save = () => {
    if (saving.current) return; // evita duplicata por duplo Enter/clique
    const n = name.trim();
    if (!n) { setError('Dê um nome ao local.'); return; }
    saving.current = true;
    const zoomFields = remember ? { savedZoom: editor.mode === 'create' ? editor.zoom : editing?.savedZoom ?? zoom, restoreZoom: true } : { restoreZoom: false };
    const ok = editor.mode === 'create'
      ? !!addCheckpoint({ name: n, description: description.trim(), color, icon, x: editor.x, y: editor.y, ...zoomFields })
      : updateCheckpoint(editor.id, { name: n, description: description.trim(), color, icon, ...zoomFields });
    if (!ok) { saving.current = false; setError('Não foi possível salvar: verifique os campos.'); return; }
    close();
  };
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[#060a12bb] p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cp-title"
        data-testid="checkpoint-dialog"
        className="w-full max-w-md rounded-2xl border border-[#405a78] bg-[#1a293c] shadow-[0_30px_80px_#000b] p-5 flex flex-col gap-2"
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); } }}
      >
        <h2 id="cp-title" className="text-[16px] font-bold">{editor.mode === 'create' ? 'Novo checkpoint' : 'Editar checkpoint'}</h2>
        <label className="text-[11px] text-muted">Nome
          <input autoFocus aria-label="Nome do checkpoint" maxLength={CHECKPOINT_LIMITS.name} value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Ex.: Financeiro" className="mt-1 w-full h-9 px-2.5 rounded-lg border border-line bg-[#0f1826] text-fg text-[13px] outline-none focus:border-accent" />
        </label>
        <label className="text-[11px] text-muted">Descrição (opcional)
          <textarea aria-label="Descrição do checkpoint" maxLength={CHECKPOINT_LIMITS.description} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-line bg-[#0f1826] text-fg text-[12px] outline-none focus:border-accent resize-none" />
        </label>
        <div className="text-[11px] text-muted">Cor</div>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Cor do checkpoint">
          {CHECKPOINT_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Cor ${c}`} onClick={() => setColor(c)} className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
        <div className="text-[11px] text-muted">Ícone</div>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Ícone do checkpoint">
          {CHECKPOINT_ICONS.map((i) => {
            const I = CHECKPOINT_ICON[i];
            return (
              <button key={i} type="button" role="radio" aria-checked={icon === i} aria-label={`Ícone ${i}`} onClick={() => setIcon(i)} className={`w-8 h-8 grid place-items-center rounded-lg border ${icon === i ? 'border-accent bg-[#2c3a6e]' : 'border-line'}`} style={{ color }}>
                <I size={14} />
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-[12px] text-fg-2 mt-1">
          <input type="checkbox" className="accent-accent" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Restaurar o zoom ao navegar ({Math.round((editor.mode === 'create' ? editor.zoom : editing?.savedZoom ?? zoom) * 100)}%)
        </label>
        {editor.mode === 'edit' && editing && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            <button type="button" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-line text-[11px] hover:bg-panel-3" onClick={() => { navigateToCheckpoint(editing.id); close(); }}><LocateFixed size={12} /> Ir</button>
            <button type="button" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-line text-[11px] hover:bg-panel-3" title="O destino passa a ser o centro da visão atual" onClick={() => moveCheckpointToView(editing.id)}><Crosshair size={12} /> Mover destino para a visão atual</button>
            <button type="button" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-line text-[11px] hover:bg-panel-3" onClick={() => { const id = duplicateCheckpoint(editing.id); if (id) openCheckpointEdit(id); }}><Copy size={12} /> Duplicar</button>
            <button type="button" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[#a04a5c] text-[#ffd0d6] text-[11px]" onClick={async () => { if (await confirmDialog('Excluir local', `Excluir “${editing.name}”? Ctrl+Z desfaz.`, 'Excluir', true)) deleteCheckpoint(editing.id); }}><Trash2 size={12} /> Excluir</button>
          </div>
        )}
        {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={close} className="h-9 px-3.5 rounded-lg text-[12px] font-semibold text-muted hover:text-fg">Cancelar</button>
          <button type="button" onClick={save} className="h-9 px-3.5 rounded-lg border bg-[#3174db] border-[#4288f5] text-white text-[12px] font-semibold">Salvar</button>
        </div>
      </div>
    </div>
  );
}
