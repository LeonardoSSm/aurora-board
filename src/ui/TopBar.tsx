import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleHelp,
  Download,
  FolderOpen,
  LayoutGrid,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Undo2,
  Upload,
} from 'lucide-react';
import { useEditor, setState } from '../store/editor';
import { canRedo, canUndo, createBoard, createWorkspace, redo, switchWorkspace, undo, updateBoardMeta } from '../store/actions';
import { promptDialog } from '../store/ui';
import { exportCurrentBoardJSON, exportImage, exportWorkspaceJSON, importLegacyFromBrowser, pickImportFile } from './fileActions';
import { IconButton } from './primitives';

function SaveIndicator() {
  const state = useEditor((s) => s.saveState);
  const map = {
    saved: { text: 'Salvo localmente', cls: 'text-ok' },
    pending: { text: 'Alterações pendentes…', cls: 'text-muted' },
    saving: { text: 'Salvando…', cls: 'text-muted' },
    error: { text: 'Erro ao salvar — exporte um backup', cls: 'text-danger' },
  }[state];
  return (
    <span data-testid="save-state" data-state={state} className={`text-[11px] whitespace-nowrap hidden lg:inline ${map.cls}`} role="status" aria-live="polite">
      ● {map.text}
    </span>
  );
}

function Menu({ label, icon, children }: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-panel-3 hover:bg-[#28405d] text-xs font-semibold text-fg-2">
        {icon} <span className="hidden md:inline">{label}</span> <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-50 min-w-[240px] rounded-xl glass p-1 flex flex-col" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children, hint }: { onClick: () => void; children: React.ReactNode; hint?: string }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex items-center justify-between gap-3 text-left text-[12px] px-2.5 py-2 rounded-md hover:bg-panel-3 text-fg-2">
      <span>{children}</span>
      {hint && <span className="text-[10px] text-soft">{hint}</span>}
    </button>
  );
}

export function TopBar() {
  const workspaces = useEditor((s) => s.workspaces);
  const workspaceId = useEditor((s) => s.workspaceId);
  const board = useEditor((s) => s.boards.find((b) => b.id === s.boardId));
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const propertiesOpen = useEditor((s) => s.propertiesOpen);
  useEditor((s) => s.history); // re-render para habilitar/desabilitar desfazer
  const [editingName, setEditingName] = useState(false);

  return (
    <header className="h-14 shrink-0 flex items-center gap-2 px-3 bg-panel border-b border-line z-30">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-8 h-8 rounded-lg grid place-items-center bg-gradient-to-br from-[#367ce8] to-[#8066df] shadow-[0_0_20px_#3178dd44] text-white text-lg shrink-0">✧</div>
        <div className="hidden sm:block leading-tight">
          <div className="text-[13px] font-extrabold tracking-tight">Aurora Board</div>
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={async (e) => {
              if (e.target.value === '__new') {
                const name = await promptDialog('Novo workspace', 'Workspaces agrupam quadros independentes.', '', 'Ex.: Sousa OS');
                if (name) await createWorkspace(name);
                return;
              }
              await switchWorkspace(e.target.value);
            }}
            className="bg-transparent text-[10px] text-muted font-semibold uppercase tracking-wider outline-none cursor-pointer -ml-0.5"
          >
            {workspaces.map((w) => <option key={w.id} value={w.id} className="bg-panel">{w.name}</option>)}
            <option value="__new" className="bg-panel">＋ Novo workspace…</option>
          </select>
        </div>
      </div>
      <div className="w-px h-7 bg-line mx-1" />
      <IconButton label="Biblioteca de componentes" active={libraryOpen} onClick={() => setState({ libraryOpen: !libraryOpen })}><PanelLeft size={16} /></IconButton>
      <button
        onClick={() => setState({ boardsPanelOpen: true })}
        className="inline-flex items-center gap-1.5 h-8 px-2 rounded-lg hover:bg-panel-3 text-muted"
        title="Quadros do workspace"
        aria-label="Abrir lista de quadros"
      >
        <LayoutGrid size={15} />
      </button>
      <div className="min-w-0 flex items-center gap-1">
        {editingName ? (
          <input
            autoFocus
            defaultValue={board?.name}
            aria-label="Nome do quadro"
            className="h-8 px-2 rounded-lg bg-[#0f1826] border border-accent text-[13px] font-bold outline-none w-56"
            onBlur={(e) => { setEditingName(false); if (board && e.target.value.trim()) void updateBoardMeta(board.id, { name: e.target.value.trim() }); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <button data-testid="board-name" onDoubleClick={() => setEditingName(true)} onClick={() => setState({ boardsPanelOpen: true })} className="truncate max-w-[260px] text-[13px] font-bold px-2 h-8 rounded-lg hover:bg-panel-3" title="Clique: trocar de quadro · Duplo clique: renomear">
            {board?.name ?? '…'}
          </button>
        )}
        <IconButton
          label="Novo quadro"
          onClick={async () => {
            const name = await promptDialog('Novo quadro', 'Um espaço livre e independente.', '', 'Nome do quadro', 'Criar');
            if (name !== null) await createBoard(name || 'Novo quadro');
          }}
        >
          <Plus size={16} />
        </IconButton>
      </div>

      <div className="flex-1" />
      <SaveIndicator />
      <IconButton label="Desfazer (Ctrl+Z)" disabled={!canUndo()} onClick={undo}><Undo2 size={16} /></IconButton>
      <IconButton label="Refazer (Ctrl+Shift+Z)" disabled={!canRedo()} onClick={redo}><Redo2 size={16} /></IconButton>
      <Menu label="Importar" icon={<Upload size={14} />}>
        {(close) => (
          <>
            <MenuItem onClick={() => { close(); pickImportFile(); }} hint=".json">Arquivo JSON (backup ou v0.2/v0.3)…</MenuItem>
            <MenuItem onClick={() => { close(); void importLegacyFromBrowser(); }}>Dados do protótipo v0.3 deste navegador</MenuItem>
          </>
        )}
      </Menu>
      <Menu label="Exportar" icon={<Download size={14} />}>
        {(close) => (
          <>
            <MenuItem onClick={() => { close(); void exportCurrentBoardJSON(); }} hint="JSON">Este quadro</MenuItem>
            <MenuItem onClick={() => { close(); void exportWorkspaceJSON(); }} hint="JSON">Backup do workspace</MenuItem>
            <div className="h-px bg-line my-1" />
            <MenuItem onClick={() => { close(); void exportImage('png', false); }} hint="PNG">Imagem do quadro</MenuItem>
            <MenuItem onClick={() => { close(); void exportImage('svg', false); }} hint="SVG">Vetor do quadro</MenuItem>
            <MenuItem onClick={() => { close(); void exportImage('png', true); }} hint="PNG">Imagem da seleção</MenuItem>
            <MenuItem onClick={() => { close(); void exportImage('png', false, false); }} hint="PNG">Quadro sem fundo</MenuItem>
          </>
        )}
      </Menu>
      <IconButton label="Quadros" onClick={() => setState({ boardsPanelOpen: true })} className="md:hidden"><FolderOpen size={16} /></IconButton>
      <IconButton label="Atalhos e ajuda (?)" onClick={() => setState({ shortcutsOpen: true })}><CircleHelp size={16} /></IconButton>
      <IconButton label="Painel de propriedades" active={propertiesOpen} onClick={() => setState({ propertiesOpen: !propertiesOpen })}><PanelRight size={16} /></IconButton>
    </header>
  );
}
