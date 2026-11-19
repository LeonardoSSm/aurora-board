/** Fórmula (`aurora.formula`): calcula um resultado a partir dos valores conectados, sem executar código. */
import { useMemo, useState } from 'react';
import { Sigma } from 'lucide-react';
import type { AuroraElement, LinearElement, WidgetElement } from '../../core/schema';
import { isLinear } from '../../core/schema';
import type { WidgetPlugin } from '../registry';
import { WIDGET } from '../../core/widgetIds';
import { evaluateFormula, FORMULA_TEMPLATES, FUNCTIONS, MAX_FORMULA_LENGTH, type FormulaResult, type FormulaVariable } from '../../core/formula';
import { formatScalar, KIND_LABEL, normalizeName, readScalar } from '../../core/scalar';
import { CARD_FG, type CardModel } from '../../core/financeCard';
import { variableBase, type InputValue } from '../../core/dataflow';
import type { TileDisplayMode } from '../../core/valueTile';
import { setWidgetEditing, updateElements } from '../../store/actions';
import { getState } from '../../store/editor';
import { toast } from '../../store/ui';
import { Field, Label, Segmented, TextArea } from '../../ui/primitives';
import { CardView, cardSVG, currentFlow, InlineEditor, inlineInput, MODE_OPTIONS, patchWidget, useIsEditing } from './financeShared';

export interface FormulaData {
  expression: string;
  displayMode: TileDisplayMode;
  note: string;
}

export const FORMULA_SIZES: Record<TileDisplayMode, { width: number; height: number }> = {
  compact: { width: 150, height: 48 },
  normal: { width: 210, height: 96 },
  detailed: { width: 250, height: 180 },
};

export function sanitizeFormula(raw: unknown): FormulaData {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    expression: typeof d.expression === 'string' ? d.expression.slice(0, MAX_FORMULA_LENGTH) : '',
    displayMode: d.displayMode === 'compact' || d.displayMode === 'detailed' ? d.displayMode : 'normal',
    note: typeof d.note === 'string' ? d.note.slice(0, 300) : '',
  };
}

/** Variáveis da fórmula: o nome lógico gravado na conexão (ou, em conexões antigas, derivado do título). */
export function formulaVariables(inputs: InputValue[] | undefined): FormulaVariable[] {
  const used = new Set<string>();
  return (inputs ?? []).map((i) => {
    let name = i.variable ?? variableBase(i.sourceTitle, i.fromPort);
    if (!i.variable) { let n = 2; const base = name; while (used.has(normalizeName(name))) name = `${base}_${n++}`; }
    used.add(normalizeName(name));
    return { name, value: i.value, source: i.sourceTitle, edgeId: i.edgeId };
  });
}

const RESULT_KEY = '$formula';

function resultOf(d: FormulaData, outputs: Record<string, unknown>, inputs: Record<string, InputValue[]>): FormulaResult | null {
  if (!d.expression.trim()) return null;
  return (outputs[RESULT_KEY] as FormulaResult | undefined) ?? evaluateFormula(d.expression, formulaVariables(inputs.in));
}

export function formulaModel(el: WidgetElement, d: FormulaData, r: FormulaResult | null, vars: FormulaVariable[]): CardModel {
  const expr = d.expression.trim() ? (d.expression.trim().startsWith('=') ? d.expression.trim() : `=${d.expression.trim()}`) : '';
  const rows = d.displayMode === 'detailed' ? vars.map((v) => { const s = readScalar(v.value); return { label: v.name, value: s ? formatScalar(s) : '—' }; }) : [];
  if (!r) return { title: el.title, value: '—', valueColor: '#8ea3bf', caption: 'Duplo clique para escrever a fórmula', rows, accent: '#b998ff', valueRole: 'result' };
  return {
    title: el.title,
    value: r.ok ? formatScalar(r.value) : 'Erro',
    valueColor: r.ok ? (r.value.t === 'money' && r.value.cents < 0 ? '#fb8590' : CARD_FG) : '#fb8590',
    caption: d.displayMode === 'compact' ? undefined : expr,
    rows,
    accent: '#b998ff',
    status: r.ok ? undefined : { text: r.error.message, color: '#fb8590' },
    valueRole: 'result',
  };
}

/** Renomeia a variável de uma conexão e atualiza as referências na fórmula (um item de histórico). */
export function renameVariable(formulaId: string, edgeId: string, newName: string): string | null {
  const name = newName.trim();
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) return 'Use letras, números e _ (sem espaços; não comece com número).';
  if (FUNCTIONS.some((f) => [f.name, ...f.aliases].some((a) => normalizeName(a) === normalizeName(name)))) return 'Esse nome é de uma função.';
  const s = getState();
  const edges = s.elements.filter((e): e is LinearElement => isLinear(e) && e.connection.kind === 'data' && e.endBinding?.elementId === formulaId);
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return 'Conexão não encontrada.';
  const vars = formulaVariables(currentFlow(formulaId).inputs.in);
  const old = vars.find((v) => v.edgeId === edgeId)?.name ?? edge.connection.variable ?? '';
  if (vars.some((v) => v.edgeId !== edgeId && normalizeName(v.name) === normalizeName(name))) return 'Já existe uma entrada com esse nome.';
  const formula = s.elements.find((e) => e.id === formulaId);
  const d = formula?.type === 'widget' ? sanitizeFormula(formula.data) : null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_(])`, 'giu');
  updateElements(new Set([edgeId, formulaId]), (e): AuroraElement => {
    if (e.id === edgeId && isLinear(e)) return { ...e, connection: { ...e.connection, variable: name } };
    if (e.id === formulaId && e.type === 'widget' && d && old) return { ...e, data: { ...d, expression: d.expression.replace(re, name) } };
    return e;
  });
  return null;
}

function FormulaEditor({ element, data }: { element: WidgetElement; data: FormulaData }) {
  const [text, setText] = useState(data.expression || '=');
  return (
    <InlineEditor minWidth={240} onCommit={() => { patchWidget(element.id, sanitizeFormula, () => ({ data: { expression: text.trim() === '=' ? '' : text } })); }}>
      <input aria-label="Fórmula" autoFocus className={`${inlineInput} font-mono`} value={text} maxLength={MAX_FORMULA_LENGTH} onChange={(e) => setText(e.target.value)} placeholder="=receitas - despesas" />
      <div className="text-[10px] text-soft">Enter confirma · Esc cancela · funções: {FUNCTIONS.map((f) => f.name).join(', ')}</div>
    </InlineEditor>
  );
}

function VariableRow({ formulaId, v }: { formulaId: string; v: FormulaVariable }) {
  const [name, setName] = useState(v.name);
  const [err, setErr] = useState('');
  const s = readScalar(v.value);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Field
          aria-label={`Nome da entrada de ${v.source}`}
          value={name}
          onChange={(e) => { setName(e.target.value); setErr(''); }}
          onBlur={() => { if (name !== v.name) { const e = renameVariable(formulaId, v.edgeId, name); if (e) setErr(e); } }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="!h-7 font-mono !text-[12px]"
        />
        <span className="text-[11px] text-fg-2 whitespace-nowrap tabular-nums">{s ? formatScalar(s) : '—'}</span>
      </div>
      <div className="text-[10px] text-soft">de “{v.source}”{s ? ` · ${KIND_LABEL[s.t]}` : ' · sem valor'}</div>
      {err && <div className="text-[10px] text-danger">{err}</div>}
    </li>
  );
}

function Inspector({ element, data }: { element: WidgetElement; data: FormulaData }) {
  const id = element.id;
  const flow = currentFlow(id);
  const vars = formulaVariables(flow.inputs.in);
  const [draft, setDraft] = useState(data.expression);
  const preview = useMemo(() => (draft.trim() ? evaluateFormula(draft, vars) : null), [draft, vars]);
  const save = (expression: string) => patchWidget(id, sanitizeFormula, () => ({ data: { expression } }), `formula:${id}`);
  return (
    <div className="flex flex-col text-[12px]" data-testid="formula-inspector">
      <Label>Fórmula</Label>
      <TextArea
        aria-label="Expressão da fórmula"
        rows={2}
        className="font-mono !text-[12px]"
        value={draft}
        maxLength={MAX_FORMULA_LENGTH}
        placeholder="=receitas - despesas"
        onChange={(e) => { setDraft(e.target.value); save(e.target.value); }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="mt-1 text-[11px]" data-testid="formula-preview">
        {!preview ? <span className="text-soft">Escreva uma fórmula. Ex.: =salario * 20%</span> : preview.ok ? <span className="text-ok">= {formatScalar(preview.value)} <span className="text-soft">({KIND_LABEL[preview.value.t]})</span></span> : <span className="text-danger">{preview.error.message}</span>}
      </div>
      <Label>Entradas conectadas ({vars.length})</Label>
      {vars.length === 0 ? (
        <div className="text-[11px] text-soft">Conecte valores, meses ou outras fórmulas a este bloco com uma conexão do tipo Dados. Cada conexão vira uma variável.</div>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="formula-variables">{vars.map((v) => <VariableRow key={v.edgeId + v.name} formulaId={id} v={v} />)}</ul>
      )}
      <Label>Funções</Label>
      <div className="flex flex-wrap gap-1">
        {FUNCTIONS.map((f) => (
          <button key={f.name} type="button" title={`${f.signature} — ${f.description}`} className="h-6 px-1.5 rounded border border-line text-[10px] font-mono hover:bg-panel-3" onClick={() => { const v = `${draft || '='}${f.name}()`; setDraft(v); save(v); }}>{f.name}</button>
        ))}
      </div>
      <Label>Modelos</Label>
      <div className="flex flex-col gap-1">
        {FORMULA_TEMPLATES.map((t) => (
          <button key={t.id} type="button" title={t.hint} className="text-left text-[11px] px-2 py-1 rounded border border-line hover:bg-panel-3" onClick={() => { setDraft(t.expression); save(t.expression); }}>
            <span className="text-fg-2">{t.label}</span> <code className="text-soft">{t.expression}</code>
          </button>
        ))}
      </div>
      <Label>Modo visual</Label>
      <Segmented<TileDisplayMode> label="Modo visual" value={data.displayMode} onChange={(mode) => patchWidget(id, sanitizeFormula, () => ({ data: { displayMode: mode }, size: FORMULA_SIZES[mode] }))} options={MODE_OPTIONS} />
      <div className="mt-3 text-[10px] text-soft leading-relaxed">
        Operadores + − × ÷, parênteses e %. Decimais com ponto (0.20); argumentos separados por vírgula. Dinheiro é calculado em centavos; moedas diferentes nunca são somadas.
      </div>
    </div>
  );
}

export const formulaPlugin: WidgetPlugin<FormulaData> = {
  id: WIDGET.formula,
  name: 'Fórmula',
  description: 'Calcula um resultado a partir dos valores conectados (ex.: =receitas - despesas).',
  icon: Sigma,
  version: '1.0.0',
  category: 'Dados',
  status: 'ready',
  accent: '#b998ff',
  permissions: [],
  defaultSize: FORMULA_SIZES.normal,
  inputs: [{ id: 'in', label: 'Entradas', type: 'scalar', accepts: ['money', 'number', 'percent'] }],
  outputs: [{ id: 'result', label: 'Resultado', type: 'scalar' }],
  frame: 'bare',
  editOnInsert: true,
  librarySection: 'Finanças visuais',
  hideInLibrary: true,
  presets: [
    { id: 'blank', name: 'Fórmula', description: 'Fórmula livre com os valores conectados.', icon: Sigma, keywords: ['fórmula', 'cálculo', 'soma'], data: sanitizeFormula({}), size: FORMULA_SIZES.normal, title: 'Fórmula' },
    ...FORMULA_TEMPLATES.slice(0, 2).map((t) => ({ id: t.id, name: t.label, description: t.hint, icon: Sigma, keywords: ['fórmula', 'modelo'], data: sanitizeFormula({ expression: t.expression }), size: FORMULA_SIZES.normal, title: t.label })),
  ],
  createData: () => sanitizeFormula({}),
  sanitize: sanitizeFormula,
  compute: (d, inputs) => {
    if (!d.expression.trim()) return {};
    const r = evaluateFormula(d.expression, formulaVariables(inputs.in));
    return { result: r.ok ? r.value : undefined, [RESULT_KEY]: r };
  },
  summarize: (d, el) => {
    const { outputs, inputs } = currentFlow(el.id);
    const r = resultOf(d, outputs, inputs);
    return `${el.title}: ${d.expression || '(vazia)'}${r ? ` → ${r.ok ? formatScalar(r.value) : `erro: ${r.error.message}`}` : ''}`;
  },
  Component: function FormulaTile({ element, data, inputs, outputs, selected }) {
    const editing = useIsEditing(element.id);
    const vars = useMemo(() => formulaVariables(inputs.in), [inputs.in]);
    const r = resultOf(data, outputs, inputs);
    const model = useMemo(() => formulaModel(element, data, r, vars), [element, data, r, vars]);
    return (
      <>
        <CardView element={element} model={model} mode={data.displayMode} selected={selected} testid="formula-tile" />
        {editing && <FormulaEditor element={element} data={data} />}
      </>
    );
  },
  Inspector: ({ element, data }) => <Inspector element={element} data={data} />,
  onDoubleClick: (el) => setWidgetEditing(el.id),
  menuItems: (el) => [
    { id: 'edit', label: 'Editar fórmula', run: () => setWidgetEditing(el.id) },
    { id: 'copy', label: 'Copiar resultado', run: () => {
      const { outputs, inputs } = currentFlow(el.id);
      const r = resultOf(sanitizeFormula(el.data), outputs, inputs);
      if (r?.ok) void navigator.clipboard?.writeText(formatScalar(r.value)).then(() => toast('Resultado copiado.', 'success'), () => toast('Não foi possível copiar.', 'warning'));
    } },
  ],
  exportSVG: (d, el) => {
    const { outputs, inputs } = currentFlow(el.id);
    return cardSVG(formulaModel(el, d, resultOf(d, outputs, inputs), formulaVariables(inputs.in)), el, d.displayMode);
  },
};
