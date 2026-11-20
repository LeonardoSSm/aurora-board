/**
 * Aurora Command Center (issue #14): Ctrl+K / Cmd+K ou o botão de busca na barra superior. Busca local em todos
 * os quadros (quadros, locais, elementos, tarefas), ações e recentes. Combobox + listbox acessíveis; Esc fecha e
 * devolve o foco. Nada é enviado para fora do navegador.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BookOpen, CheckSquare, Command, FileText, FolderOpen, Focus, HelpCircle, Inbox, LayoutGrid, Loader2, Lock, MapPin, Plus, Search, Sparkles, StickyNote, Wallet } from 'lucide-react';
import { useEditor, getState, setState } from '../store/editor';
import { addWidget, createBoard, viewportCenterWorld, zoomToFit, zoomToSelection } from '../store/actions';
import { indexStatus, jumpTo, loadRecents, recentResults, refreshIndex, search, subscribeIndex, type SearchResult } from '../store/commandCenter';
import { lastCaptured } from '../store/quickCapture';
import { FILTER_LABEL, terms, type SearchFilter } from '../core/search';
import { WIDGET } from '../core/widgetIds';
import { openFinanceHub } from './finance/uiState';
import { openRadialFromKeyboard } from './radialOpen';

interface Action { id: string; label: string; hint?: string; keys?: string; icon: typeof Search; run: () => void | Promise<unknown>; when?: () => boolean }

/** Ações seguras (nenhuma destrutiva). */
function actions(): Action[] {
  return [
    { id: 'new-board', label: 'Novo quadro', icon: Plus, run: () => createBoard('Novo quadro') },
    { id: 'new-note', label: 'Criar nota', hint: 'Bloco Notas no centro da tela', icon: StickyNote, run: () => { addWidget(WIDGET.notes, viewportCenterWorld()); } },
    { id: 'new-task', label: 'Criar tarefa', hint: 'Bloco Tarefas no centro da tela', icon: CheckSquare, run: () => { addWidget(WIDGET.tasks, viewportCenterWorld()); } },
    { id: 'capture', label: 'Captura rápida', hint: 'Nota ou tarefa sem sair do lugar', keys: 'Ctrl+Shift+Espaço', icon: Inbox, run: () => setState({ captureOpen: true }) },
    { id: 'open-captured', label: 'Abrir item capturado', hint: 'Último item da captura rápida', icon: Inbox, when: () => !!lastCaptured(), run: async () => { const c = lastCaptured(); if (c) await jumpTo({ key: `element:${c.boardId}:${c.elementId}`, kind: 'element', boardId: c.boardId, workspaceId: getState().boards.find((b) => b.id === c.boardId)?.workspaceId ?? getState().workspaceId, id: c.elementId, title: '', body: '', typeLabel: '', filter: 'notes', updatedAt: 0 }); } },
    { id: 'places', label: 'Ir para local…', hint: 'Abre a lista de Locais', keys: 'G', icon: MapPin, run: () => setState({ locationsOpen: true }) },
    { id: 'selection', label: 'Ir para a seleção', keys: 'Shift+2', icon: Focus, when: () => getState().selectedIds.length > 0, run: () => zoomToSelection() },
    { id: 'fit', label: 'Enquadrar tudo', keys: 'Shift+1', icon: LayoutGrid, run: () => zoomToFit() },
    { id: 'wheel', label: 'Aurora Wheel (criar…)', keys: 'W', icon: Sparkles, run: () => openRadialFromKeyboard(null) },
    { id: 'finance', label: 'Abrir Minhas contas', icon: Wallet, run: () => openFinanceHub() },
    { id: 'library', label: 'Mostrar biblioteca', icon: BookOpen, run: () => setState({ libraryOpen: true }) },
    { id: 'boards', label: 'Quadros e workspaces', icon: FolderOpen, run: () => setState({ boardsPanelOpen: true }) },
    { id: 'help', label: 'Ajuda e atalhos', keys: '?', icon: HelpCircle, run: () => setState({ shortcutsOpen: true }) },
  ];
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const KIND_ICON = { board: FolderOpen, checkpoint: MapPin, element: FileText, task: CheckSquare } as const;
const GROUP_OF: Record<string, string> = { board: 'Quadros', checkpoint: 'Locais', element: 'Elementos', task: 'Tarefas' };
const FILTERS: SearchFilter[] = ['all', 'boards', 'places', 'notes', 'tasks', 'code', 'other'];

type Row = { kind: 'result'; r: SearchResult; group: string } | { kind: 'action'; a: Action; group: string };

export function CommandCenter() {
  const open = useEditor((s) => s.commandOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [active, setActive] = useState(0);
  const status = useSyncExternalStore(subscribeIndex, indexStatus);
  const [recentTick, setRecentTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Índice da conversa atual: atualizado a cada abertura (só relê quadros alterados).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    void refreshIndex();
    void loadRecents().then(() => setRecentTick((t) => t + 1));
    inputRef.current?.focus();
    return () => { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);
  // Edições no quadro atual entram na hora (o índice do quadro ativo vem do estado).
  const elements = useEditor((s) => s.elements);
  const checkpoints = useEditor((s) => s.checkpoints);
  const boards = useEditor((s) => s.boards);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const ts = terms(q);
    if (!ts.length) {
      for (const r of recentResults().slice(0, 6)) out.push({ kind: 'result', r, group: 'Recentes' });
      for (const a of actions().filter((x) => !x.when || x.when())) out.push({ kind: 'action', a, group: 'Ações' });
      return out;
    }
    const results = search(q, { filter, includeArchived });
    for (const g of ['board', 'checkpoint', 'element', 'task'] as const) for (const r of results) if (r.doc.kind === g) out.push({ kind: 'result', r, group: GROUP_OF[g] });
    const nq = fold(q.trim());
    if (filter === 'all') for (const a of actions().filter((x) => (!x.when || x.when()) && fold(`${x.label} ${x.hint ?? ''}`).includes(nq))) out.push({ kind: 'action', a, group: 'Ações' });
    return out;
  }, [q, filter, includeArchived, status, recentTick, elements, checkpoints, boards]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => { listRef.current?.querySelector(`[data-row="${cur}"]`)?.scrollIntoView({ block: 'nearest' }); }, [cur]);
  const close = () => setState({ commandOpen: false });
  const choose = (row: Row | undefined) => {
    if (!row) return;
    close();
    if (row.kind === 'action') void row.a.run();
    else void jumpTo(row.r.doc);
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[85] flex items-start justify-center bg-[#060a12aa] p-3 pt-[10vh]" onPointerDown={(e) => e.target === e.currentTarget && close()} data-testid="command-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command Center"
        data-testid="command-center"
        className="w-full max-w-[640px] rounded-2xl border border-[#405a78] bg-[#162336] shadow-[0_30px_80px_#000b] flex flex-col max-h-[75vh] overflow-hidden"
        onKeyDown={(e) => {
          e.stopPropagation(); // atalhos do quadro não disparam com a paleta aberta
          if (e.key === 'Escape') { e.preventDefault(); close(); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((cur + 1) % Math.max(1, rows.length)); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((cur - 1 + rows.length) % Math.max(1, rows.length)); return; }
          if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); return; }
          if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(rows.length - 1); return; }
          if (e.key === 'Enter') { e.preventDefault(); choose(rows[cur]); }
        }}
      >
        <label className="flex items-center gap-2 px-4 h-12 border-b border-line">
          <Search size={16} className="text-soft shrink-0" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={rows[cur] ? `command-row-${cur}` : undefined}
            aria-autocomplete="list"
            aria-label="Buscar em todos os quadros ou digitar um comando"
            placeholder="Buscar notas, tarefas, locais, quadros… ou um comando"
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            className="flex-1 min-w-0 bg-transparent outline-none text-[14px]"
          />
          {status.state === 'indexing' && <span className="text-[10px] text-soft flex items-center gap-1" data-testid="index-status"><Loader2 size={11} className="animate-spin" /> indexando {status.done}/{status.total}</span>}
          <kbd className="hidden sm:inline text-[10px] text-soft border border-line rounded px-1">Esc</kbd>
        </label>
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line/60 overflow-x-auto" role="radiogroup" aria-label="Filtrar por tipo">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => { setFilter(f); setActive(0); inputRef.current?.focus(); }} className={`h-6 px-2 rounded-md text-[11px] whitespace-nowrap ${filter === f ? 'bg-[#2c3a6e] text-[#d8dcff]' : 'text-fg-2 hover:bg-panel-3'}`}>{FILTER_LABEL[f]}</button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-[10px] text-soft whitespace-nowrap pl-2">
            <input type="checkbox" className="accent-accent" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> arquivados
          </label>
        </div>
        <ul id="command-list" ref={listRef} role="listbox" aria-label="Resultados" className="flex-1 overflow-y-auto py-1" data-testid="command-list">
          {rows.length === 0 && (
            <li className="px-4 py-6 text-[12px] text-soft text-center" data-testid="command-empty">
              {terms(q).length ? (status.state === 'indexing' ? 'Procurando nos quadros…' : 'Nada encontrado. Tente outras palavras ou outro filtro.') : 'Digite para buscar em todos os quadros.'}
            </li>
          )}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <RowItem key={row.kind === 'action' ? `a:${row.a.id}` : row.r.doc.key} index={i} header={header} active={i === cur} onHover={() => setActive(i)} onChoose={() => choose(row)}>
                {row.kind === 'action' ? <ActionRow a={row.a} /> : <ResultRow r={row.r} />}
              </RowItem>
            );
          })}
        </ul>
        <div className="px-4 py-1.5 border-t border-line/60 text-[10px] text-soft flex flex-wrap gap-x-3">
          <span><Command size={10} className="inline" /> ↑↓ navegar · Enter abrir · Esc fechar</span>
          <span className="flex items-center gap-1"><Lock size={10} /> Busca local: nada sai deste navegador. Conteúdo de IA, HTML e finanças não é pesquisado (só o título do bloco).</span>
        </div>
      </div>
    </div>
  );
}

function RowItem({ index, header, active, onHover, onChoose, children }: { index: number; header: string | null; active: boolean; onHover: () => void; onChoose: () => void; children: ReactNode }) {
  return (
    <>
      {header && <li role="presentation" className="px-4 pt-2 pb-0.5 text-[10px] font-bold tracking-widest text-soft uppercase">{header}</li>}
      <li
        id={`command-row-${index}`}
        data-row={index}
        role="option"
        aria-selected={active}
        data-testid="command-row"
        className={`mx-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center gap-2.5 ${active ? 'bg-[#26395a]' : 'hover:bg-panel-3'}`}
        onPointerMove={() => { if (!active) onHover(); }}
        onClick={onChoose}
      >
        {children}
      </li>
    </>
  );
}

function ActionRow({ a }: { a: Action }) {
  const I = a.icon;
  return (
    <>
      <I size={15} className="text-accent shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-fg truncate">{a.label}</span>
        {a.hint && <span className="block text-[10px] text-soft truncate">{a.hint}</span>}
      </span>
      {a.keys && <kbd className="text-[10px] text-soft border border-line rounded px-1 shrink-0">{a.keys}</kbd>}
    </>
  );
}

function ResultRow({ r }: { r: SearchResult }) {
  const I = KIND_ICON[r.doc.kind];
  const where = r.doc.kind === 'board' ? r.workspaceName : `${r.boardName}${r.workspaceName ? ` · ${r.workspaceName}` : ''}`;
  return (
    <>
      <I size={15} className="text-fg-2 shrink-0" />
      <span className="flex-1 min-w-0" data-testid="command-result" data-key={r.doc.key}>
        <span className="block text-[13px] text-fg truncate">{r.doc.title || '(sem título)'}</span>
        {r.snippet ? (
          <span className="block text-[11px] text-muted truncate" data-testid="command-snippet">{r.snippet.before}<mark className="bg-[#ffd36a33] text-[#ffe7a6] rounded-sm">{r.snippet.hit}</mark>{r.snippet.after}</span>
        ) : r.doc.contentHidden ? (
          <span className="block text-[10px] text-soft truncate">conteúdo não pesquisável (privacidade) — só o título</span>
        ) : null}
      </span>
      <span className="text-[10px] text-soft shrink-0 text-right max-w-[40%] truncate">{r.doc.typeLabel}{where ? <><br />{where}</> : null}{r.archived ? ' · arquivado' : ''}</span>
    </>
  );
}
