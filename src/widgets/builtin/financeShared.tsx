/** Peças compartilhadas pelos blocos de Finanças visuais (valor, mês, fórmula). */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import { cardLayout, type CardModel } from '../../core/financeCard';
import type { TileDisplayMode } from '../../core/valueTile';
import { getState, useEditor } from '../../store/editor';
import { setWidgetEditing, updateElements } from '../../store/actions';
import { getDataflow } from '../dataflow';
import { TileSVG, tileNodesToSVG } from './tileRender';

export const MODE_OPTIONS: { value: TileDisplayMode; label: string }[] = [
  { value: 'compact', label: 'Compacto' },
  { value: 'normal', label: 'Normal' },
  { value: 'detailed', label: 'Detalhado' },
];

export function CardView({ element, model, mode, selected, testid }: { element: WidgetElement; model: CardModel; mode: TileDisplayMode; selected: boolean; testid: string }) {
  const nodes = useMemo(() => cardLayout(model, element.width, element.height, mode), [model, element.width, element.height, mode]);
  return (
    <TileSVG
      nodes={nodes}
      width={element.width}
      height={element.height}
      testid={testid}
      label={`${model.title ? model.title + ': ' : ''}${model.value}${model.status ? ` (${model.status.text})` : ''}`}
      filter={selected ? `drop-shadow(0 0 6px ${model.accent}55)` : 'drop-shadow(0 6px 14px rgba(0,0,0,.35))'}
      attrs={{ 'data-value': model.value, 'data-mode': mode, ...(model.status ? { 'data-status': model.status.text } : {}) }}
    />
  );
}

export function cardSVG(model: CardModel, el: WidgetElement, mode: TileDisplayMode): string {
  return tileNodesToSVG(cardLayout(model, el.width, el.height, mode));
}

/** Saídas/entradas atuais de um elemento (para exportação e inspetor). */
export function currentFlow(id: string) {
  const f = getDataflow(getState().elements);
  return { inputs: f.inputs.get(id) ?? {}, outputs: f.outputs.get(id) ?? {} };
}

export function useIsEditing(id: string) {
  return useEditor((s) => s.editingWidgetId === id);
}

/**
 * Painel de edição rápida sobre o bloco: Enter confirma, Esc cancela, clicar fora confirma.
 * Fica acima do bloco e pode ser maior que ele (blocos compactos continuam editáveis).
 */
export function InlineEditor({ children, onCommit, onCancel, minWidth = 200 }: { children: ReactNode; onCommit: () => boolean | void; onCancel?: () => void; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    if (commit && onCommit() === false) return; // inválido: continua editando
    done.current = true;
    if (!commit) onCancel?.();
    setWidgetEditing(null);
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) finish(true); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });
  return (
    <div
      ref={ref}
      data-interactive
      data-testid="inline-editor"
      className="absolute left-0 top-0 z-10 rounded-lg border border-accent/60 bg-[#101a29] shadow-[0_12px_30px_#000a] p-2 flex flex-col gap-1.5"
      style={{ minWidth }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !(e.target as HTMLElement).matches('textarea')) { e.preventDefault(); finish(true); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }}
    >
      {children}
    </div>
  );
}

export const inlineInput = 'w-full h-8 px-2 rounded-md border border-line bg-[#0b1320] text-fg text-[13px] outline-none focus:border-accent';

/** Atualiza dados e (opcionalmente) título num único item de histórico. */
export function patchWidget<D>(id: string, sanitize: (raw: unknown) => D, fn: (d: D, el: WidgetElement) => { data?: Partial<D>; title?: string; size?: { width: number; height: number } }, coalesceKey?: string) {
  updateElements(
    new Set([id]),
    (el) => {
      if (el.type !== 'widget') return el;
      const cur = sanitize(el.data);
      const r = fn(cur, el);
      const next: WidgetElement = { ...el, data: r.data ? sanitize({ ...(cur as object), ...r.data }) : el.data };
      if (r.title !== undefined) next.title = r.title;
      if (r.size) {
        next.x = el.x + (el.width - r.size.width) / 2;
        next.y = el.y + (el.height - r.size.height) / 2;
        next.width = r.size.width;
        next.height = r.size.height;
      }
      return next as AuroraElement;
    },
    coalesceKey,
  );
}
