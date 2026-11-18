import { useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Copy, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useEditor, setState } from '../store/editor';
import { createBoard, deleteBoard, deleteWorkspace, duplicateBoard, moveBoard, openBoard, renameWorkspace, setBoardArchived, updateBoardMeta } from '../store/actions';
import { promptDialog } from '../store/ui';

function fmtDate(t: number) {
  return new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function BoardsPanel() {
  const open = useEditor((s) => s.boardsPanelOpen);
  const boards = useEditor((s) => s.boards);
  const boardId = useEditor((s) => s.boardId);
  const ws = useEditor((s) => s.workspaces.find((w) => w.id === s.workspaceId));
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  if (!open) return null;
  const close = () => setState({ boardsPanelOpen: false });
  const list = boards.filter((b) => b.archived === showArchived && (!q || `${b.name} ${b.description}`.toLowerCase().includes(q.toLowerCase())));
  const archivedCount = boards.filter((b) => b.archived).length;

  return (
    <div className="fixed inset-0 z-[75] bg-[#060a12aa]" onPointerDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
      <aside role="dialog" aria-label="Quadros" className="absolute left-0 top-0 bottom-0 w-[420px] max-w-[95vw] bg-panel border-r border-line shadow-[20px_0_60px_#0008] flex flex-col">
        <div className="p-4 border-b border-line">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold tracking-widest text-soft">WORKSPACE</div>
              <div className="flex items-center gap-1.5">
                <h2 className="text-[16px] font-bold">{ws?.name}</h2>
                <button aria-label="Renomear workspace" className="p-1 text-soft hover:text-fg" onClick={async () => { const n = await promptDialog('Renomear workspace', '', ws?.name); if (n && ws) await renameWorkspace(ws.id, n); }}><Pencil size={12} /></button>
                <button aria-label="Excluir workspace" className="p-1 text-soft hover:text-danger" onClick={() => ws && deleteWorkspace(ws.id)}><Trash2 size={12} /></button>
              </div>
            </div>
            <button aria-label="Fechar" onClick={close} className="p-1.5 rounded-lg hover:bg-panel-3"><X size={16} /></button>
          </div>
          <div className="flex gap-2 mt-3">
            <label className="flex-1 flex items-center gap-2 h-9 px-2.5 rounded-lg border border-line bg-[#0f1826]">
              <Search size={14} className="text-soft" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar quadros" className="flex-1 bg-transparent outline-none text-[13px]" />
            </label>
            <button
              className="inline-flex items-center gap-1 h-9 px-3 rounded-lg bg-[#3174db] text-white text-[12px] font-semibold"
              onClick={async () => {
                const name = await promptDialog('Novo quadro', 'Um espaço livre e independente.', '', 'Nome do quadro', 'Criar');
                if (name !== null) { await createBoard(name || 'Novo quadro'); close(); }
              }}
            >
              <Plus size={14} /> Novo
            </button>
          </div>
          <div className="flex gap-3 mt-2 text-[11px]">
            <button className={!showArchived ? 'text-accent font-semibold' : 'text-muted'} onClick={() => setShowArchived(false)}>Ativos ({boards.length - archivedCount})</button>
            <button className={showArchived ? 'text-accent font-semibold' : 'text-muted'} onClick={() => setShowArchived(true)}>Arquivados ({archivedCount})</button>
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto p-2" data-testid="boards-list">
          {list.map((b) => (
            <li key={b.id} className={`group rounded-xl border p-3 mb-1.5 cursor-pointer ${b.id === boardId ? 'border-accent/60 bg-accent/10' : 'border-line/60 hover:bg-panel-3'}`} onClick={async () => { if (!b.archived) { await openBoard(b.id); close(); } }}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13px] truncate">{b.name}</div>
                  {b.description && <div className="text-[11px] text-muted line-clamp-2">{b.description}</div>}
                  <div className="text-[10px] text-soft mt-1">Atualizado {fmtDate(b.updatedAt)} · criado {fmtDate(b.createdAt)}</div>
                </div>
                <div className="flex gap-0.5 opacity-60 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                  <button aria-label="Renomear" title="Renomear" className="p-1.5 rounded hover:bg-panel" onClick={async () => { const n = await promptDialog('Renomear quadro', '', b.name); if (n) await updateBoardMeta(b.id, { name: n }); }}><Pencil size={13} /></button>
                  <button aria-label="Descrição" title="Editar descrição" className="p-1.5 rounded hover:bg-panel text-[11px] font-bold" onClick={async () => { const d = await promptDialog('Descrição do quadro', '', b.description); if (d !== null) await updateBoardMeta(b.id, { description: d }); }}>¶</button>
                  <button aria-label="Duplicar" title="Duplicar" className="p-1.5 rounded hover:bg-panel" onClick={() => duplicateBoard(b.id)}><Copy size={13} /></button>
                  {!showArchived && <button aria-label="Mover para cima" title="Mover para cima" className="p-1.5 rounded hover:bg-panel" onClick={() => moveBoard(b.id, -1)}><ArrowUp size={13} /></button>}
                  {!showArchived && <button aria-label="Mover para baixo" title="Mover para baixo" className="p-1.5 rounded hover:bg-panel" onClick={() => moveBoard(b.id, 1)}><ArrowDown size={13} /></button>}
                  <button aria-label={b.archived ? 'Restaurar' : 'Arquivar'} title={b.archived ? 'Restaurar' : 'Arquivar'} className="p-1.5 rounded hover:bg-panel" onClick={() => setBoardArchived(b.id, !b.archived)}>{b.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}</button>
                  <button aria-label="Excluir" title="Excluir" className="p-1.5 rounded hover:bg-panel text-danger" onClick={() => deleteBoard(b.id)}><Trash2 size={13} /></button>
                </div>
              </div>
            </li>
          ))}
          {!list.length && <li className="text-center text-[12px] text-soft p-6">{q ? 'Nenhum quadro encontrado.' : showArchived ? 'Nenhum quadro arquivado.' : 'Nenhum quadro.'}</li>}
        </ul>
      </aside>
    </div>
  );
}
