import { Component, useCallback, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Puzzle } from 'lucide-react';
import type { WidgetElement } from '../core/schema';
import type { InputValue } from '../core/dataflow';
import { connectionsOf } from '../core/bindings';
import { getState, useEditor } from '../store/editor';
import { addElements, getAsset, putAsset, setSelection, updateElement, updateWidgetData } from '../store/actions';
import { confirmDialog, toast } from '../store/ui';
import { getWidget, type WidgetHostApi } from './registry';
import { getDataflow } from './dataflow';

const EMPTY_INPUTS: Record<string, InputValue[]> = {};
const EMPTY_OUTPUTS: Record<string, unknown> = {};
const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], [data-interactive], iframe, label';

class WidgetErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error)
      return (
        <div className="text-xs text-danger flex gap-2 items-start">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            O widget “{this.props.name}” falhou ao renderizar. Os dados foram preservados.
            <div className="text-muted mt-1 font-mono">{this.state.error.message}</div>
          </div>
        </div>
      );
    return this.props.children;
  }
}

export function makeHostApi(id: string): WidgetHostApi {
  return {
    toast: (m, k) => toast(m, k),
    confirm: (t, m, l, d) => confirmDialog(t, m, l, d),
    getElements: () => getState().elements,
    getElement: (eid) => getState().elements.find((e) => e.id === eid),
    addElements: (els, select) => addElements(els, select),
    connections: () => connectionsOf(getState().elements, id),
    updateElement: (eid, patch) => updateElement(eid, patch),
    updateWidgetData: (eid, updater) => updateWidgetData(eid, updater),
    putAsset: (file, name) => putAsset(file, name ?? (file as File).name),
    getAssetURL: async (aid) => (await getAsset(aid))?.dataURL ?? null,
  };
}

export const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  ready: { label: 'Ativo', cls: 'bg-ok/15 text-ok border-ok/30' },
  'needs-config': { label: 'Não configurado', cls: 'bg-warn/15 text-warn border-warn/30' },
  experimental: { label: 'Experimental', cls: 'bg-accent-2/15 text-accent-2 border-accent-2/30' },
  planned: { label: 'Futuro', cls: 'bg-muted/10 text-muted border-line' },
};

export function WidgetFrame({ element, selected }: { element: WidgetElement; selected: boolean }) {
  const plugin = getWidget(element.widgetType);
  const tool = useEditor((s) => s.tool);
  const inputs = useEditor((s) => getDataflow(s.elements).inputs.get(element.id) ?? EMPTY_INPUTS);
  const outputs = useEditor((s) => getDataflow(s.elements).outputs.get(element.id) ?? EMPTY_OUTPUTS);
  const [renaming, setRenaming] = useState(false);
  const data = useMemo(() => (plugin ? plugin.sanitize(element.data) : element.data), [plugin, element.data]);
  const api = useMemo(() => makeHostApi(element.id), [element.id]);
  const update = useCallback(
    (updater: unknown, opts?: { coalesce?: boolean }) => {
      if (!plugin) return;
      updateWidgetData(
        element.id,
        (raw) => {
          const cur = plugin.sanitize(raw);
          return typeof updater === 'function' ? (updater as (d: unknown) => unknown)(cur) : { ...(cur as object), ...(updater as object) };
        },
        opts?.coalesce,
      );
    },
    [element.id, plugin],
  );

  const Icon = plugin?.icon ?? Puzzle;
  const accent = plugin?.accent ?? '#8fa6c8';
  const status = plugin ? STATUS_LABEL[plugin.status] : null;
  const inputCount = Object.values(inputs).reduce((n, l) => n + l.length, 0);

  return (
    <div
      data-widget-root={element.id}
      className="w-full h-full flex flex-col rounded-xl border bg-gradient-to-b from-panel-2 to-panel shadow-[0_12px_32px_rgba(0,0,0,.4)] overflow-hidden"
      style={{ borderColor: selected ? accent : '#2e405a', boxShadow: selected ? `0 0 0 1px ${accent}55, 0 14px 36px rgba(0,0,0,.5)` : undefined }}
    >
      <div className="h-[3px] shrink-0" style={{ background: accent }} />
      <header className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-line/60">
        <span className="grid place-items-center w-6 h-6 rounded-md" style={{ color: accent, background: `${accent}22` }}>
          <Icon size={14} />
        </span>
        {renaming ? (
          <input
            autoFocus
            data-interactive
            defaultValue={element.title}
            className="flex-1 min-w-0 bg-panel-3 rounded px-1.5 py-0.5 text-[13px] font-semibold outline-none border border-accent/50"
            onBlur={(e) => { setRenaming(false); if (e.target.value.trim() && e.target.value !== element.title) updateElement(element.id, { title: e.target.value.trim() }); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <div className="flex-1 min-w-0" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }} title="Duplo clique para renomear">
            <div className="text-[9px] uppercase tracking-wider font-bold leading-none" style={{ color: accent }}>{plugin?.name ?? 'Widget'}</div>
            <div className="text-[13px] font-semibold truncate leading-tight mt-0.5" data-testid="widget-title">{element.title}</div>
          </div>
        )}
        {inputCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded border border-ok/30 text-ok bg-ok/10" title="Entradas recebidas por conexões de dados">⇢ {inputCount}</span>}
        {status && plugin?.status !== 'ready' && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${status.cls}`}>{status.label}</span>}
      </header>
      <div
        data-widget-body={element.id}
        data-scrollable
        className="flex-1 min-h-0 overflow-auto p-3 text-[13px] text-fg-2 select-text"
        style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
        onPointerDown={(e) => {
          const s = getState();
          const isSelectedAlone = s.selectedIds.length === 1 && s.selectedIds[0] === element.id;
          // Controles (campos, botões…) sempre interagem; com o bloco já selecionado, o corpo inteiro
          // fica "nativo" (selecionar texto, rolar). Mover: cabeçalho, bordas ou arrastar antes de selecionar.
          if ((e.target as HTMLElement).closest(INTERACTIVE) || (isSelectedAlone && e.button === 0 && !e.shiftKey)) {
            e.stopPropagation();
            if (!s.selectedIds.includes(element.id)) setSelection([element.id]);
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {plugin ? (
          <WidgetErrorBoundary name={plugin.name}>
            <plugin.Component element={element} data={data} update={update as never} selected={selected} inputs={inputs} outputs={outputs} api={api} />
          </WidgetErrorBoundary>
        ) : (
          <div className="text-xs text-muted">
            Widget “{element.widgetType}” não está instalado nesta versão. Os dados foram preservados e serão mantidos ao salvar/exportar.
          </div>
        )}
      </div>
    </div>
  );
}
