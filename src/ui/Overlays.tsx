/** Componentes flutuantes: zoom, menu de contexto, diálogos, toasts, atalhos. */
import { useEffect, useRef, useState } from 'react';
import { Focus, Maximize, Minus, Plus, X } from 'lucide-react';
import { useEditor, setState, getState } from '../store/editor';
import {
  copySelection,
  cutSelection,
  deleteSelected,
  duplicateSelected,
  groupSelection,
  pasteContent,
  reorderSelection,
  resetZoom,
  selectAll,
  startTextEdit,
  convertTextToValue,
  toggleLockSelection,
  ungroupSelection,
  zoomStep,
  zoomToFit,
  zoomToSelection,
} from '../store/actions';
import { acceptsBoundText, isText } from '../core/schema';
import { exportImage } from './fileActions';
import { getWidget } from '../widgets/registry';
import { openCheckpointCreate } from '../store/checkpointActions';
import { parseTextToValue } from '../core/valueTile';
import { TOOLS } from './tools';

export function ZoomControls() {
  const zoom = useEditor((s) => s.camera.zoom);
  const hasSel = useEditor((s) => s.selectedIds.length > 0);
  return (
    <div className="absolute bottom-3 left-3 z-20 glass rounded-xl p-1 flex items-center gap-0.5" role="group" aria-label="Zoom e enquadramento">
      <button className="grid place-items-center w-8 h-8 rounded-lg hover:bg-panel-3 text-fg-2" aria-label="Diminuir zoom" title="Diminuir zoom (Ctrl −)" onClick={() => zoomStep(-1)}><Minus size={15} /></button>
      <button data-testid="zoom-label" className="min-w-[52px] h-8 rounded-lg hover:bg-panel-3 text-[12px] font-semibold text-fg-2" title="Redefinir para 100% (Ctrl+0)" onClick={resetZoom}>{Math.round(zoom * 100)}%</button>
      <button className="grid place-items-center w-8 h-8 rounded-lg hover:bg-panel-3 text-fg-2" aria-label="Aumentar zoom" title="Aumentar zoom (Ctrl +)" onClick={() => zoomStep(1)}><Plus size={15} /></button>
      <div className="w-px h-5 bg-line mx-0.5" />
      <button className="grid place-items-center w-8 h-8 rounded-lg hover:bg-panel-3 text-fg-2" aria-label="Enquadrar tudo" title="Enquadrar todos os elementos (Shift+1)" onClick={zoomToFit}><Maximize size={15} /></button>
      <button disabled={!hasSel} className="grid place-items-center w-8 h-8 rounded-lg hover:bg-panel-3 text-fg-2" aria-label="Zoom na seleção" title="Zoom na seleção (Shift+2)" onClick={zoomToSelection}><Focus size={15} /></button>
    </div>
  );
}

export function ContextMenu() {
  const menu = useEditor((s) => s.contextMenu);
  const sel = useEditor((s) => s.selectedIds);
  const elements = useEditor((s) => s.elements);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setState({ contextMenu: null }); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setState({ contextMenu: null });
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);
  if (!menu) return null;
  const target = elements.find((e) => e.id === menu.targetId);
  const selected = elements.filter((e) => sel.includes(e.id));
  const plugin = target?.type === 'widget' ? getWidget(target.widgetType) : undefined;
  const widgetItems = target?.type === 'widget' && plugin?.menuItems && selected.length <= 1 ? plugin.menuItems(target, plugin.sanitize(target.data)) : [];
  const run = (fn: () => void) => () => { setState({ contextMenu: null }); fn(); };
  const Item = ({ label, hint, onClick, disabled }: { label: string; hint?: string; onClick: () => void; disabled?: boolean }) => (
    <button role="menuitem" disabled={disabled} onClick={run(onClick)} className="w-full flex justify-between gap-6 px-2.5 py-1.5 rounded-md text-left text-[12px] text-fg-2 hover:bg-panel-3 disabled:opacity-30">
      <span>{label}</span>
      {hint && <span className="text-[10px] text-soft">{hint}</span>}
    </button>
  );
  const Sep = () => <div className="h-px bg-line my-1" />;
  const x = Math.min(menu.x, window.innerWidth - 230), y = Math.min(menu.y, window.innerHeight - (target ? 430 + widgetItems.length * 30 : 220));
  return (
    <div ref={ref} role="menu" data-testid="context-menu" className="fixed z-[70] w-56 glass rounded-xl p-1" style={{ left: x, top: Math.max(8, y) }}>
      {target ? (
        <>
          {(isText(target) || acceptsBoundText(target) || target.type === 'frame') && <Item label="Editar texto" hint="Enter" onClick={() => startTextEdit(target.id)} />}
          {target.type === 'text' && parseTextToValue(target.text) && <Item label="Converter em valor" onClick={() => convertTextToValue(target.id)} />}
          {widgetItems.length > 0 && (
            <>
              {widgetItems.map((i) => <Item key={i.id} label={i.label} disabled={i.disabled} onClick={i.run} />)}
              <Sep />
            </>
          )}
          <Item label="Recortar" hint="Ctrl+X" onClick={() => cutSelection()} />
          <Item label="Copiar" hint="Ctrl+C" onClick={() => copySelection()} />
          <Item label="Colar" hint="Ctrl+V" onClick={() => void pasteContent(null, [], menu.world)} />
          <Item label="Duplicar" hint="Ctrl+D" onClick={() => duplicateSelected()} />
          <Sep />
          <Item label="Agrupar" hint="Ctrl+G" disabled={selected.length < 2} onClick={groupSelection} />
          <Item label="Desagrupar" hint="Ctrl+Shift+G" disabled={!selected.some((e) => e.groupIds.length)} onClick={ungroupSelection} />
          <Item label={selected.some((e) => !e.locked) ? 'Bloquear' : 'Desbloquear'} hint="Ctrl+Shift+L" onClick={toggleLockSelection} />
          <Sep />
          <Item label="Trazer para frente" hint="Ctrl+Shift+]" onClick={() => reorderSelection('front')} />
          <Item label="Avançar" hint="Ctrl+]" onClick={() => reorderSelection('forward')} />
          <Item label="Recuar" hint="Ctrl+[" onClick={() => reorderSelection('backward')} />
          <Item label="Enviar para trás" hint="Ctrl+Shift+[" onClick={() => reorderSelection('back')} />
          <Sep />
          <Item label="Zoom na seleção" hint="Shift+2" onClick={zoomToSelection} />
          <Item label="Exportar seleção (PNG)" onClick={() => void exportImage('png', true)} />
          <Sep />
          <Item label="Excluir" hint="Delete" onClick={deleteSelected} />
        </>
      ) : (
        <>
          <Item label="Colar aqui" hint="Ctrl+V" onClick={() => void pasteContent(null, [], menu.world)} />
          <Item label="Adicionar checkpoint aqui" onClick={() => openCheckpointCreate(menu.world)} />
          <Item label="Salvar localização atual" hint="centro da tela" onClick={() => openCheckpointCreate()} />
          <Item label="Selecionar tudo" hint="Ctrl+A" onClick={selectAll} />
          <Item label="Enquadrar tudo" hint="Shift+1" onClick={zoomToFit} />
          <Item label="Zoom 100%" hint="Ctrl+0" onClick={resetZoom} />
          <Sep />
          <Item
            label={getState().boards.find((b) => b.id === getState().boardId)?.settings.grid ? 'Ocultar grade' : 'Mostrar grade'}
            onClick={() => {
              const s = getState();
              const b = s.boards.find((x) => x.id === s.boardId);
              if (b) setState({ boards: s.boards.map((x) => (x.id === b.id ? { ...x, settings: { ...x.settings, grid: !x.settings.grid } } : x)) });
            }}
          />
          <Item label="Exportar quadro (PNG)" onClick={() => void exportImage('png', false)} />
        </>
      )}
    </div>
  );
}

export function DialogHost() {
  const dialog = useEditor((s) => s.dialog);
  const [value, setValue] = useState('');
  useEffect(() => { setValue(dialog?.input?.initial ?? ''); }, [dialog?.id, dialog?.input?.initial]);
  if (!dialog) return null;
  const primary = dialog.buttons.find((b) => b.variant === 'primary' || b.variant === 'danger') ?? dialog.buttons[dialog.buttons.length - 1];
  const close = (button: string | null) => dialog.resolve({ button, value });
  const cls = { primary: 'bg-[#3174db] border-[#4288f5] text-white', danger: 'bg-[#5a2232] border-[#a04a5c] text-[#ffd0d6]', ghost: 'bg-transparent border-transparent text-muted hover:text-fg' };
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[#060a12bb] p-4" onPointerDown={(e) => e.target === e.currentTarget && close(null)}>
      <div role="dialog" aria-modal="true" aria-labelledby="dlg-title" className={`w-full ${dialog.wide ? 'max-w-xl' : 'max-w-md'} rounded-2xl border border-[#405a78] bg-[#1a293c] shadow-[0_30px_80px_#000b] p-5`}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(null); if (e.key === 'Enter' && !dialog.input?.multiline && (e.target as HTMLElement).tagName !== 'BUTTON') close(primary.value); }}>
        <h2 id="dlg-title" className="text-[16px] font-bold mb-2">{dialog.title}</h2>
        {dialog.message && <p className="text-[12px] text-muted leading-relaxed whitespace-pre-line">{dialog.message}</p>}
        {dialog.body}
        {dialog.input && (
          <input autoFocus value={value} placeholder={dialog.input.placeholder} onChange={(e) => setValue(e.target.value)} className="mt-3 w-full h-9 px-2.5 rounded-lg border border-line bg-[#0f1826] outline-none focus:border-accent" />
        )}
        <div className="flex justify-end gap-2 mt-5">
          {dialog.buttons.map((b) => (
            <button key={b.value} autoFocus={!dialog.input && b === primary} onClick={() => close(b.value)} className={`h-9 px-3.5 rounded-lg border text-[12px] font-semibold ${cls[b.variant ?? 'ghost']}`}>{b.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const color = { info: 'border-[#4f7bac]', success: 'border-ok/60', error: 'border-danger/70', warning: 'border-warn/60' };
  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[90] flex flex-col gap-2 items-center pointer-events-none" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto max-w-[90vw] rounded-lg border ${color[t.kind]} bg-[#1c2b40] text-[12px] text-fg px-3.5 py-2 shadow-[0_10px_30px_#0008]`}>{t.message}</div>
      ))}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl + Z / Ctrl + Shift + Z (ou Ctrl + Y)', 'Desfazer / refazer'],
  ['Ctrl + A', 'Selecionar tudo'],
  ['Ctrl + C / X / V', 'Copiar / recortar / colar (imagens e texto também)'],
  ['Ctrl + D', 'Duplicar'],
  ['Ctrl + G / Ctrl + Shift + G', 'Agrupar / desagrupar'],
  ['Ctrl + Shift + L', 'Bloquear / desbloquear'],
  ['Ctrl + ] / [  (+Shift: extremos)', 'Ordem das camadas'],
  ['Delete / Backspace', 'Excluir'],
  ['Esc', 'Cancelar ferramenta, edição ou seleção'],
  ['Enter', 'Editar texto do elemento selecionado'],
  ['Setas (+Shift)', 'Mover seleção 1px (10px)'],
  ['Seta/linha: cliques', 'Cada clique adiciona um ponto · Enter/Esc ou clique no último ponto finaliza'],
  ['Ponto da seta + Delete', 'Remove o ponto (arraste ◦ entre pontos para criar)'],
  ['Ctrl + setas', 'Criar nó conectado (fluxograma)'],
  ['Alt + setas', 'Ir para o nó conectado'],
  ['Ctrl + Alt + C / V', 'Copiar / colar estilo'],
  ['Ctrl ao arrastar', 'Liga/desliga o encaixe nos objetos'],
  ['Shift + 1 / Shift + 2', 'Enquadrar tudo / zoom na seleção'],
  ['G', 'Locais (checkpoints): lista, ir, editar'],
  ['Esc (durante navegação)', 'Interrompe o movimento da câmera'],
  ['Ctrl + + / − / 0', 'Zoom / 100%'],
  ['Espaço + arrastar, botão do meio', 'Navegar (pan)'],
  ['Shift ao desenhar', 'Proporção fixa / ângulos de 15°'],
  ['Alt + arrastar', 'Duplicar arrastando'],
  ['Duplo clique', 'Escrever na forma / criar texto / entrar no grupo'],
  ['Q', 'Manter ferramenta ativa'],
  ['Segurar botão direito (vazio)', 'Aurora Wheel: soltar na fatia cria ali (clique curto = menu de sempre)'],
  ['W', 'Abrir a Aurora Wheel pelo teclado (setas, Enter, 1–8, Esc)'],
  ['Ctrl + K (Cmd + K)', 'Command Center: buscar em todos os quadros, ir até o item, ações'],
  ['Ctrl + Shift + Espaço', 'Captura rápida de nota ou tarefa (quadro atual ou Inbox)'],
  ['?', 'Esta ajuda'],
];

export function ShortcutsDialog() {
  const open = useEditor((s) => s.shortcutsOpen);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[#060a12bb] p-4" onPointerDown={(e) => e.target === e.currentTarget && setState({ shortcutsOpen: false })} onKeyDown={(e) => e.key === 'Escape' && setState({ shortcutsOpen: false })}>
      <div role="dialog" aria-modal="true" aria-label="Atalhos de teclado" className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-2xl border border-[#405a78] bg-[#1a293c] p-5">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-[16px] font-bold">Atalhos e ajuda</h2>
          <button autoFocus aria-label="Fechar" onClick={() => setState({ shortcutsOpen: false })} className="p-1 rounded hover:bg-panel-3"><X size={16} /></button>
        </div>
        <div className="grid md:grid-cols-2 gap-x-6">
          <div>
            <h3 className="text-[11px] font-bold text-muted tracking-wider mb-1">FERRAMENTAS</h3>
            {TOOLS.map((t) => (
              <div key={t.id} className="flex justify-between text-[12px] py-1 border-b border-line/50"><span>{t.label}</span><kbd className="text-soft">{t.keys.join(' / ')}</kbd></div>
            ))}
          </div>
          <div>
            <h3 className="text-[11px] font-bold text-muted tracking-wider mb-1 mt-3 md:mt-0">EDIÇÃO E NAVEGAÇÃO</h3>
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} className="flex justify-between gap-3 text-[12px] py-1 border-b border-line/50"><span>{d}</span><kbd className="text-soft text-right">{k}</kbd></div>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-soft mt-3">Atalhos de uma letra não funcionam enquanto você digita em campos de texto.</p>
      </div>
    </div>
  );
}
