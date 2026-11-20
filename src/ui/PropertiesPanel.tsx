import { useMemo, type ReactNode } from 'react';
import { PanelResizer, usePanelLayout } from './PanelResizer';
import { PANEL_DEFAULTS } from '../core/panels';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Group,
  Lock,
  LockOpen,
  Trash2,
  Ungroup,
} from 'lucide-react';
import { setState, useEditor } from '../store/editor';
import {
  alignSelection,
  deleteSelected,
  duplicateSelected,
  groupSelection,
  reorderSelection,
  toggleLockSelection,
  ungroupSelection,
  updateBoardMeta,
  updateElements,
  updateStyle,
  updateWidgetData,
  setZoomPrefs,
  resetPanelWidth,
} from '../store/actions';
import type { Arrowhead, AuroraElement, ElementStyle, LinearElement, LinkKind, WidgetElement } from '../core/schema';
import { acceptsBoundText, isLinear, isText } from '../core/schema';
import { BACKGROUND_COLORS, FONT_FAMILIES, FONT_SIZES, STICKY_COLORS, STROKE_COLORS } from '../core/elements';
import { fitTextElement } from '../core/text';
import { resolveLinear } from '../core/bindings';
import { Button, Label, Segmented } from './primitives';
import { IconArrowPath, IconEdges, IconFill, IconRoughness, IconStrokeStyle, IconStrokeWidth } from './icons';
import { useDataflow } from '../widgets/dataflow';
import { dataflowSpec, getWidget, PERMISSION_LABELS } from '../widgets/registry';
import { portAccepts } from '../core/dataflow';
import { formatScalar, readScalar } from '../core/scalar';
import { isPeriodSummary } from '../core/financePeriod';
import { formatMoney } from '../core/finance';
import { makeHostApi, STATUS_LABEL } from '../widgets/WidgetFrame';
import { CONNECTION_KINDS } from './Toolbar';
import { connectionStyle } from '../core/connectionStyle';
import { CUSTOM_RANGE, SENSITIVITY_LABEL, sensitivityOf, type ZoomSensitivityPreset } from '../core/camera';
import { AnimationPreference, GifAnimationControls } from './GifControls';
import { NavigationPreference } from './NavigationPrefs';
import { RadialFavorites } from './RadialFavorites';
import { CompanionPreferences } from './companions/CompanionSettings';

function common<T>(els: AuroraElement[], get: (e: AuroraElement) => T): T | null {
  if (!els.length) return null;
  const v = get(els[0]);
  return els.every((e) => get(e) === v) ? v : null;
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string | null; onChange: (c: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 items-center" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value === c}
          aria-label={c === 'transparent' ? 'Transparente' : c}
          title={c === 'transparent' ? 'Transparente' : c}
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded-md border ${value === c ? 'ring-2 ring-[#9aa3ff] ring-offset-1 ring-offset-panel' : 'border-line'}`}
          style={{ background: c === 'transparent' ? 'linear-gradient(135deg,#30384b 0 45%,#ee6573 46% 54%,#30384b 55%)' : c }}
        />
      ))}
      <label className="w-6 h-6 rounded-md border border-dashed border-line grid place-items-center text-[10px] text-muted cursor-pointer relative overflow-hidden" title="Cor personalizada">
        +
        <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" value={value && value.startsWith('#') && value.length === 7 ? value : '#ffffff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <Label>{title}</Label>
      {children}
    </div>
  );
}

function StyleEditor({ els, style }: { els: AuroraElement[]; style: ElementStyle }) {
  const has = (pred: (e: AuroraElement) => boolean) => (els.length ? els.some(pred) : true);
  const val = <K extends keyof ElementStyle>(k: K): ElementStyle[K] | null => (els.length ? common(els, (e) => e.style[k]) : style[k]);
  const closed = (e: AuroraElement) => ['rectangle', 'ellipse', 'diamond', 'frame'].includes(e.type);
  const stroked = (e: AuroraElement) => closed(e) || isLinear(e) || e.type === 'freedraw';
  const texty = (e: AuroraElement) => isText(e) || (acceptsBoundText(e) && (!!e.text || !isLinear(e)));
  const sticky = els.length > 0 && els.every((e) => e.type === 'sticky');

  return (
    <>
      {has((e) => stroked(e) || isText(e)) && !sticky && (
        <Section title={els.length && els.every(isText) ? 'Cor do texto' : 'Contorno'}>
          <Swatches label="Cor do contorno" colors={STROKE_COLORS} value={val('strokeColor')} onChange={(c) => updateStyle({ strokeColor: c })} />
        </Section>
      )}
      {(has(closed) || sticky) && (
        <Section title="Preenchimento">
          <Swatches label="Cor de fundo" colors={sticky ? STICKY_COLORS : BACKGROUND_COLORS} value={val('backgroundColor')} onChange={(c) => updateStyle({ backgroundColor: c })} />
          {!sticky && (val('backgroundColor') ?? 'x') !== 'transparent' && (
            <div className="mt-1.5">
              <Segmented label="Estilo de preenchimento" value={val('fillStyle')} onChange={(v) => updateStyle({ fillStyle: v })} options={[{ value: 'solid', label: <IconFill kind="solid" />, title: 'Sólido' }, { value: 'hachure', label: <IconFill kind="hachure" />, title: 'Hachura' }, { value: 'cross-hatch', label: <IconFill kind="cross-hatch" />, title: 'Cruzado' }]} />
            </div>
          )}
        </Section>
      )}
      {has(stroked) && (
        <>
          <Section title="Espessura">
            <div className="flex items-center gap-2">
              <Segmented label="Espessura" value={val('strokeWidth')} onChange={(v) => updateStyle({ strokeWidth: v })} options={[{ value: 1, label: <IconStrokeWidth w={1} />, title: 'Fina' }, { value: 2, label: <IconStrokeWidth w={2.5} />, title: 'Média' }, { value: 4, label: <IconStrokeWidth w={4.5} />, title: 'Grossa' }]} />
              <input type="number" min={0.5} max={32} step={0.5} aria-label="Espessura personalizada" value={val('strokeWidth') ?? ''} onChange={(e) => Number(e.target.value) > 0 && updateStyle({ strokeWidth: Number(e.target.value) })} className="w-14 h-8 px-1.5 rounded-lg bg-[#0f1826] border border-line text-[12px]" />
            </div>
          </Section>
          <Section title="Estilo da linha">
            <Segmented label="Estilo da linha" value={val('strokeStyle')} onChange={(v) => updateStyle({ strokeStyle: v })} options={[{ value: 'solid', label: <IconStrokeStyle style="solid" />, title: 'Sólida' }, { value: 'dashed', label: <IconStrokeStyle style="dashed" />, title: 'Tracejada' }, { value: 'dotted', label: <IconStrokeStyle style="dotted" />, title: 'Pontilhada' }]} />
          </Section>
          <Section title="Traço">
            <Segmented label="Estilo de desenho" value={val('roughness')} onChange={(v) => updateStyle({ roughness: v })} options={[{ value: 0, label: <IconRoughness level={0} />, title: 'Arquiteto — traço limpo' }, { value: 1, label: <IconRoughness level={1} />, title: 'Artista — traço à mão' }, { value: 2, label: <IconRoughness level={2} />, title: 'Cartunista — traço bem solto' }]} />
          </Section>
        </>
      )}
      {has((e) => e.type === 'rectangle' || e.type === 'image') && (
        <Section title="Bordas">
          <Segmented label="Bordas" value={val('roundness')} onChange={(v) => updateStyle({ roundness: v })} options={[{ value: 'sharp', label: <IconEdges round={false} />, title: 'Retas' }, { value: 'round', label: <IconEdges round />, title: 'Arredondadas' }]} />
        </Section>
      )}
      {has(texty) && (
        <>
          <Section title="Fonte">
            <Segmented
              label="Família tipográfica"
              value={val('fontFamily')}
              onChange={(v) => updateStyle({ fontFamily: v })}
              options={(Object.keys(FONT_FAMILIES) as (keyof typeof FONT_FAMILIES)[]).map((k) => ({
                value: k,
                title: FONT_FAMILIES[k].description,
                label: <span style={{ fontFamily: FONT_FAMILIES[k].css }}>{FONT_FAMILIES[k].label}</span>,
              }))}
            />
          </Section>
          <Section title="Tamanho do texto">
            <div className="flex items-center gap-2">
              <Segmented
                label="Tamanho do texto"
                value={val('fontSize')}
                onChange={(v) => updateStyle({ fontSize: v })}
                options={(Object.keys(FONT_SIZES) as (keyof typeof FONT_SIZES)[]).map((k) => ({ value: FONT_SIZES[k], label: k, title: `${FONT_SIZES[k]}px` }))}
              />
              <input type="number" min={6} max={400} aria-label="Tamanho personalizado" value={val('fontSize') ?? ''} onChange={(e) => Number(e.target.value) >= 6 && updateStyle({ fontSize: Number(e.target.value) })} className="w-14 h-8 px-1.5 rounded-lg bg-[#0f1826] border border-line text-[12px]" />
            </div>
          </Section>
          <Section title="Alinhamento">
            <div className="flex gap-2 flex-wrap">
              <Segmented label="Alinhamento horizontal" value={val('textAlign')} onChange={(v) => updateStyle({ textAlign: v })} options={[{ value: 'left', label: <AlignLeft size={14} />, title: 'Esquerda' }, { value: 'center', label: <AlignCenter size={14} />, title: 'Centro' }, { value: 'right', label: <AlignRight size={14} />, title: 'Direita' }]} />
              {has((e) => acceptsBoundText(e) && !isLinear(e)) && (
                <Segmented label="Alinhamento vertical" value={val('verticalAlign')} onChange={(v) => updateStyle({ verticalAlign: v })} options={[{ value: 'top', label: <AlignVerticalJustifyStart size={14} />, title: 'Topo' }, { value: 'middle', label: <AlignVerticalJustifyCenter size={14} />, title: 'Meio' }, { value: 'bottom', label: <AlignVerticalJustifyEnd size={14} />, title: 'Base' }]} />
              )}
            </div>
          </Section>
          {has((e) => !isText(e)) && (
            <Section title="Cor do texto">
              <Swatches label="Cor do texto" colors={['', ...STROKE_COLORS.slice(0, 7), '#2a2414']} value={val('textColor')} onChange={(c) => updateStyle({ textColor: c })} />
              <div className="text-[10px] text-soft mt-1">A primeira opção usa a cor do contorno.</div>
            </Section>
          )}
        </>
      )}
      <Section title={`Opacidade: ${val('opacity') ?? '—'}%`}>
        <input type="range" min={5} max={100} step={5} aria-label="Opacidade" value={val('opacity') ?? 100} onChange={(e) => updateStyle({ opacity: Number(e.target.value) })} className="w-full accent-[#8f9bff]" />
      </Section>
    </>
  );
}

/** Portas de uma conexão de dados: o que sai da origem, onde entra no destino, nome lógico e valor transmitido. */
function DataPorts({ edge }: { edge: LinearElement }) {
  const elements = useEditor((s) => s.elements);
  const flow = useDataflow();
  const src = elements.find((e) => e.id === edge.startBinding?.elementId);
  const dst = elements.find((e) => e.id === edge.endBinding?.elementId);
  if (!src || !dst || src.type !== 'widget' || dst.type !== 'widget') return null;
  const ss = dataflowSpec(src.widgetType, src), ds = dataflowSpec(dst.widgetType, dst);
  if (!ss || !ds) return null;
  const res = flow.edges.get(edge.id);
  const fromId = edge.connection.sourcePort ?? res?.fromPort?.id ?? '';
  const toId = edge.connection.targetPort ?? res?.toPort?.id ?? '';
  const toPort = ds.inputs.find((p) => p.id === toId);
  const setConn = (patch: Partial<LinearElement['connection']>) =>
    updateElements(new Set([edge.id]), (x) => (isLinear(x) ? { ...x, connection: { ...x.connection, ...patch } } : x));
  const transmitted = res?.status === 'ok' || res?.status === 'currency' || res?.status === 'duplicate' || res?.status === 'period' ? flow.outputs.get(src.id)?.[res.fromPort!.id] : undefined;
  const sc = readScalar(transmitted);
  const shown = sc ? formatScalar(sc) : isPeriodSummary(transmitted) ? `${transmitted.label}: saldo ${formatMoney(transmitted.balanceCents, transmitted.currency)}` : transmitted === undefined ? '—' : 'dados estruturados';
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[11px]" data-testid="data-ports">
      <label className="flex items-center gap-2">
        <span className="w-14 text-muted">Saída</span>
        <select aria-label="Saída da origem" className="flex-1 h-7 px-1.5 rounded-md bg-[#0f1826] border border-line" value={fromId} onChange={(e) => setConn({ sourcePort: e.target.value, ...(edge.connection.targetPort ? {} : { targetPort: toId || undefined }) })}>
          {ss.outputs.map((p) => (
            <option key={p.id} value={p.id}>{p.label}{toPort && !portAccepts(toPort, p.type) ? ' (incompatível)' : ''}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-14 text-muted">Entrada</span>
        <select aria-label="Entrada do destino" className="flex-1 h-7 px-1.5 rounded-md bg-[#0f1826] border border-line" value={toId} onChange={(e) => setConn({ targetPort: e.target.value, ...(edge.connection.sourcePort ? {} : { sourcePort: fromId || undefined }) })}>
          {ds.inputs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-14 text-muted">Nome</span>
        <input
          aria-label="Nome lógico da conexão"
          className="flex-1 h-7 px-1.5 rounded-md bg-[#0f1826] border border-line font-mono"
          value={edge.connection.variable ?? ''}
          placeholder="ex.: salario"
          onChange={(e) => /^[\p{L}\p{N}_]*$/u.test(e.target.value) && setConn({ variable: e.target.value || undefined })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <div className="text-soft">Transmitindo: <span className="text-fg-2" data-testid="data-ports-value">{shown}</span>{!edge.connection.sourcePort && !edge.connection.targetPort ? ' · portas automáticas (conexão antiga)' : ''}</div>
    </div>
  );
}

function ArrowEditor({ els }: { els: LinearElement[] }) {
  const flow = useDataflow();
  const ids = new Set(els.map((e) => e.id));
  const set = (fn: (e: LinearElement) => LinearElement) => updateElements(ids, (e) => (isLinear(e) ? fn(e) : e));
  const kind = common(els, (e) => (e as LinearElement).connection.kind) as LinkKind | null;
  const single = els.length === 1 ? els[0] : null;
  const edge = single ? flow.edges.get(single.id) : undefined;
  const heads: { value: Arrowhead; label: string }[] = [
    { value: 'none', label: '—' },
    { value: 'arrow', label: '→' },
    { value: 'triangle', label: '▶' },
    { value: 'dot', label: '●' },
    { value: 'bar', label: '|' },
  ];
  return (
    <>
      <Section title="Tipo de traçado">
        <Segmented
          label="Tipo de traçado"
          value={common(els, (e) => (e as LinearElement).path)}
          onChange={(v) => { setState({ currentArrowPath: v }); set((e) => ({ ...e, path: v, bend: v === 'curved' ? e.bend : 0 })); }}
          options={[{ value: 'straight', label: <IconArrowPath kind="straight" />, title: 'Reta' }, { value: 'curved', label: <IconArrowPath kind="curved" />, title: 'Curva' }, { value: 'elbow', label: <IconArrowPath kind="elbow" />, title: 'Cotovelo' }]}
        />
      </Section>
      <Section title="Pontas">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[11px] text-muted"><span className="w-10">Início</span><Segmented label="Ponta inicial" value={common(els, (e) => (e as LinearElement).startArrowhead)} onChange={(v) => set((e) => ({ ...e, startArrowhead: v }))} options={heads} /></div>
          <div className="flex items-center gap-2 text-[11px] text-muted"><span className="w-10">Fim</span><Segmented label="Ponta final" value={common(els, (e) => (e as LinearElement).endArrowhead)} onChange={(v) => set((e) => ({ ...e, endArrowhead: v }))} options={heads} /></div>
        </div>
      </Section>
      <Section title="Tipo de conexão">
        <div className="flex flex-wrap gap-1">
          {CONNECTION_KINDS.map((k) => (
            <button
              key={k.id}
              title={k.hint}
              onClick={() =>
                set((e) => {
                  const st = connectionStyle(k.id);
                  return { ...e, connection: { ...e.connection, kind: k.id }, style: k.id === 'visual' ? e.style : { ...e.style, strokeColor: st.stroke, strokeStyle: st.dash } };
                })
              }
              className={`h-8 px-2 rounded-lg border text-[11px] font-semibold ${kind === k.id ? 'bg-panel-3' : 'border-line text-muted'}`}
              style={kind === k.id ? { borderColor: k.color, color: k.color } : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-soft mt-1">{CONNECTION_KINDS.find((k) => k.id === kind)?.hint ?? 'Vários tipos selecionados.'} Uma conexão nunca executa ações sozinha.</div>
        {single && (
          <input
            className="mt-1.5 w-full h-8 px-2 rounded-lg bg-[#0f1826] border border-line text-[12px]"
            placeholder="Relação (ex.: depende de, referência)"
            value={single.connection.relation}
            onChange={(e) => updateElements(ids, (x) => (isLinear(x) ? { ...x, connection: { ...x.connection, relation: e.target.value } } : x), `relation:${single.id}`)}
          />
        )}
        {single && single.connection.kind !== 'visual' && (
          <div className={`mt-1.5 text-[11px] rounded-md border p-1.5 ${edge?.status === 'ok' ? 'border-ok/40 text-ok' : single.connection.kind === 'data' ? 'border-warn/40 text-warn' : 'border-line text-muted'}`} data-testid="edge-status">
            {single.connection.kind === 'data'
              ? edge
                ? `${edge.status === 'ok' ? '✓ ' : '⚠ '}${edge.message}`
                : 'Sem cálculo.'
              : single.connection.kind === 'context'
                ? 'Fornece contexto ao destino (ex.: IA) — o destino decide o que é enviado, com autorização.'
                : 'Execução: o destino pode receber ações do bloco de origem, sempre mediante confirmação.'}
          </div>
        )}
        {single && single.connection.kind === 'data' && single.startBinding && single.endBinding && <DataPorts edge={single} />}
        {single && (
          <div className="text-[10px] text-soft mt-1.5">
            {single.startBinding ? 'Início ancorado' : 'Início solto'} · {single.endBinding ? 'fim ancorado' : 'fim solto'}
            {(single.startBinding?.fixedPoint || single.endBinding?.fixedPoint) && (
              <button
                className="ml-1 underline"
                onClick={() => {
                  const byId = new Map(useEditor.getState().elements.map((e) => [e.id, e]));
                  set((e) => resolveLinear({ ...e, startBinding: e.startBinding && { ...e.startBinding, fixedPoint: null }, endBinding: e.endBinding && { ...e.endBinding, fixedPoint: null } }, byId));
                }}
              >
                usar ancoragem automática
              </button>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

function ArrowDefaults() {
  const path = useEditor((s) => s.currentArrowPath);
  return (
    <Section title="Tipo de seta">
      <Segmented label="Tipo de seta" value={path} onChange={(v) => setState({ currentArrowPath: v })} options={[{ value: 'straight', label: <IconArrowPath kind="straight" />, title: 'Reta (pontos formam cantos)' }, { value: 'curved', label: <IconArrowPath kind="curved" />, title: 'Curva (passa suavemente pelos pontos)' }, { value: 'elbow', label: <IconArrowPath kind="elbow" />, title: 'Cotovelo' }]} />
      <div className="text-[10px] text-soft mt-1">Clique para adicionar pontos; arraste para uma seta simples.</div>
    </Section>
  );
}

function WidgetInfo({ el }: { el: WidgetElement }) {
  const p = getWidget(el.widgetType);
  const flow = useDataflow();
  const ins = flow.inputs.get(el.id) ?? {};
  // Portas que dependem dos dados (ex.: HTML com ponte de dados) — as fixas quando o widget não declara.
  const spec = dataflowSpec(el.widgetType, el);
  if (!p) return <div className="text-[12px] text-warn">Widget “{el.widgetType}” não instalado. Dados preservados.</div>;
  const st = STATUS_LABEL[p.status];
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      <Label>Componente</Label>
      <input
        className="w-full h-8 px-2 rounded-lg bg-[#0f1826] border border-line text-[13px] font-semibold"
        value={el.title}
        aria-label="Título do bloco"
        onChange={(e) => updateElements(new Set([el.id]), (x) => ({ ...x, title: e.target.value }) as AuroraElement, `title:${el.id}`)}
      />
      <div className="flex items-center gap-1.5 text-muted mt-1">
        <span>{p.name} v{p.version}</span>
        <span className={`text-[10px] px-1.5 rounded border ${st.cls}`}>{st.label}</span>
      </div>
      <div className="text-[11px] text-soft">{p.description}</div>
      {p.statusNote && <div className="text-[11px] text-warn/90">{p.statusNote}</div>}
      {spec && (spec.inputs.length > 0 || spec.outputs.length > 0) && (
        <>
          <Label>Portas de dados</Label>
          {spec.inputs.map((i) => (
            <div key={i.id} className="text-[11px] flex flex-wrap items-baseline gap-x-2" data-testid="port-row"><span className="min-w-0 flex-[1_1_7rem] break-words">⇢ {i.label}</span><span className="ml-auto flex items-baseline gap-2 shrink-0"><code className="text-soft break-all">{i.type}</code><span className="text-ok">{ins[i.id]?.length ?? 0}</span></span></div>
          ))}
          {spec.outputs.map((o) => (
            <div key={o.id} className="text-[11px] flex flex-wrap items-baseline gap-x-2" data-testid="port-row"><span className="min-w-0 flex-[1_1_7rem] break-words">{o.label} ⇢</span><code className="ml-auto text-soft break-all">{o.type}</code></div>
          ))}
        </>
      )}
      {p.Inspector && <WidgetInspector el={el} />}
      {p.permissions.length > 0 && (
        <>
          <Label>Permissões</Label>
          <ul className="text-[11px] text-muted list-disc pl-4">{p.permissions.map((x) => <li key={x}>{PERMISSION_LABELS[x]}</li>)}</ul>
        </>
      )}
    </div>
  );
}

/** Configurações próprias do widget (contrato WidgetPlugin.Inspector). */
function WidgetInspector({ el }: { el: WidgetElement }) {
  const p = getWidget(el.widgetType)!;
  const data = useMemo(() => p.sanitize(el.data), [p, el.data]);
  const api = useMemo(() => makeHostApi(el.id), [el.id]);
  const update = (updater: unknown, opts?: { coalesce?: boolean }) =>
    updateWidgetData(el.id, (raw) => {
      const cur = p.sanitize(raw);
      return typeof updater === 'function' ? (updater as (d: unknown) => unknown)(cur) : { ...(cur as object), ...(updater as object) };
    }, opts?.coalesce);
  const Inspector = p.Inspector!;
  return <Inspector element={el} data={data} update={update as never} selected inputs={{}} outputs={{}} api={api} />;
}

function Geometry({ el }: { el: AuroraElement }) {
  const ids = new Set([el.id]);
  const num = (label: string, value: number, apply: (v: number) => Partial<AuroraElement>) => (
    <label className="flex items-center gap-1 text-[10px] text-soft">
      {label}
      <input
        type="number"
        value={Math.round(value)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          updateElements(ids, (x) => {
            const n = { ...x, ...apply(v) } as AuroraElement;
            return isText(n) && 'width' in apply(v) ? fitTextElement({ ...n, autoSize: false }) : n;
          }, `geom:${el.id}`);
        }}
        className="w-full h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px] text-fg"
      />
    </label>
  );
  return (
    <Section title="Posição e tamanho">
      <div className="grid grid-cols-2 gap-1.5">
        {num('X', el.x, (v) => ({ x: v }))}
        {num('Y', el.y, (v) => ({ y: v }))}
        {!isLinear(el) && num('L', el.width, (v) => ({ width: Math.max(4, v) }))}
        {!isLinear(el) && num('A', el.height, (v) => ({ height: Math.max(4, v) }))}
        {!isLinear(el) && el.type !== 'widget' && el.type !== 'frame' && num('°', (el.angle * 180) / Math.PI, (v) => ({ angle: (v * Math.PI) / 180 }))}
      </div>
    </Section>
  );
}

function BoardSettings() {
  const board = useEditor((s) => s.boards.find((b) => b.id === s.boardId));
  if (!board) return null;
  const set = (patch: Partial<typeof board.settings>) => void updateBoardMeta(board.id, { settings: { ...board.settings, ...patch } });
  return (
    <>
      <Label>Quadro</Label>
      <textarea
        className="w-full min-h-[52px] px-2 py-1.5 rounded-lg bg-[#0f1826] border border-line text-[12px] resize-y"
        placeholder="Descrição do quadro"
        defaultValue={board.description}
        key={board.id}
        onBlur={(e) => e.target.value !== board.description && void updateBoardMeta(board.id, { description: e.target.value })}
      />
      <div className="flex flex-col gap-1.5 mt-2 text-[12px] text-fg-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={board.settings.grid} onChange={(e) => set({ grid: e.target.checked })} className="accent-accent" /> Mostrar grade</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={board.settings.snapToGrid} onChange={(e) => set({ snapToGrid: e.target.checked })} className="accent-accent" /> Alinhar à grade</label>
        <label className="flex items-center gap-2" title="Ctrl durante o arrasto inverte temporariamente"><input type="checkbox" checked={board.settings.snapToObjects !== false} onChange={(e) => set({ snapToObjects: e.target.checked })} className="accent-accent" /> Encaixar nos objetos (guias)</label>
        <div className="flex items-center gap-2">
          Roda do mouse:
          <Segmented label="Roda do mouse" value={board.settings.wheelMode} onChange={(v) => set({ wheelMode: v })} options={[{ value: 'zoom', label: 'Zoom' }, { value: 'pan', label: 'Navegar' }]} />
        </div>
        <div className="text-[10px] text-soft">Touchpad: dois dedos navegam, pinça faz zoom. Ctrl+roda sempre faz zoom.</div>
      </div>
      <ZoomSensitivity />
      <NavigationPreference />
      <AnimationPreference />
      <RadialFavorites />
      <CompanionPreferences />
    </>
  );
}

/** Sensibilidade do zoom — preferência geral (vale para todos os quadros). */
function ZoomSensitivity() {
  const prefs = useEditor((s) => s.zoomPrefs);
  const presets: ZoomSensitivityPreset[] = ['precise', 'smooth', 'normal', 'fast', 'custom'];
  const pct = Math.round((Math.exp(0.15 * sensitivityOf(prefs)) - 1) * 100);
  return (
    <div className="mt-3" data-testid="zoom-sensitivity">
      <Label>Sensibilidade do zoom</Label>
      <Segmented<ZoomSensitivityPreset> label="Sensibilidade do zoom" value={prefs.preset} onChange={(preset) => void setZoomPrefs({ preset })} options={presets.map((p) => ({ value: p, label: p === 'custom' ? 'Pers.' : SENSITIVITY_LABEL[p], title: SENSITIVITY_LABEL[p] }))} />
      {prefs.preset === 'custom' && (
        <input type="range" aria-label="Sensibilidade personalizada" min={CUSTOM_RANGE.min} max={CUSTOM_RANGE.max} step={0.05} value={prefs.custom} onChange={(e) => void setZoomPrefs({ custom: Number(e.target.value) })} className="w-full mt-2 accent-accent" />
      )}
      <div className="text-[10px] text-soft mt-1">≈ {pct}% por clique da roda. Vale para todos os quadros; “Roda do mouse” acima é deste quadro.</div>
    </div>
  );
}

export function PropertiesPanel() {
  const open = useEditor((s) => s.propertiesOpen);
  const compact = useEditor((s) => s.compact);
  const elements = useEditor((s) => s.elements);
  const selectedIds = useEditor((s) => s.selectedIds);
  const style = useEditor((s) => s.currentStyle);
  const tool = useEditor((s) => s.tool);
  const layout = usePanelLayout('properties');
  if (!open) return null;
  const set = new Set(selectedIds);
  const els = elements.filter((e) => set.has(e.id));
  const styleTargets = els.filter((e) => e.type !== 'widget');
  const linears = els.filter(isLinear);
  const single = els.length === 1 ? els[0] : null;
  const locked = els.some((e) => e.locked);
  const grouped = els.some((e) => e.groupIds.length);

  return (
    <aside style={{ width: layout.width }} data-testid="properties-panel" className={`relative shrink-0 min-w-0 bg-panel border-l border-line flex flex-col ${compact ? 'absolute inset-y-0 right-0 z-40 max-w-[85vw] shadow-[-20px_0_50px_#000a]' : 'z-20'}`} aria-label="Propriedades">
      {!compact && <PanelResizer side="properties" width={layout.width} max={layout.max} />}
      <div className="px-4 h-11 flex items-center justify-between gap-2 border-b border-line">
        <h2 className="text-[11px] font-bold tracking-widest text-muted truncate min-w-0">
          {els.length === 0 ? (tool === 'select' ? 'QUADRO E ESTILO PADRÃO' : 'ESTILO DA FERRAMENTA') : els.length === 1 ? 'PROPRIEDADES' : `${els.length} SELECIONADOS`}
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          {!compact && layout.stored !== PANEL_DEFAULTS.properties && <button type="button" className="text-[10px] text-soft hover:text-fg hover:underline underline-offset-2" data-testid="reset-properties-width" onClick={() => void resetPanelWidth('properties')}>Largura padrão</button>}
          {locked && <Lock size={13} className="text-warn" aria-label="Bloqueado" />}
        </div>
      </div>
      <div className="props-form flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 min-w-0" data-testid="properties">
        {single?.type === 'widget' && <WidgetInfo el={single} />}
        {(styleTargets.length > 0 || els.length === 0) && <StyleEditor els={styleTargets} style={style} />}
        {linears.length > 0 && linears.length === els.length && <ArrowEditor els={linears} />}
        {els.length === 0 && (tool === 'arrow' || tool === 'connect') && <ArrowDefaults />}
        {els.some((e) => e.type === 'image') && <GifAnimationControls els={els} />}
        {single && <Geometry el={single} />}
        {els.length > 0 && (
          <>
            <Label>Camadas</Label>
            <div className="flex gap-1">
              <Button title="Enviar para trás (Ctrl+Shift+[)" aria-label="Enviar para trás" onClick={() => reorderSelection('back')}><ArrowDownToLine size={14} /></Button>
              <Button title="Recuar (Ctrl+[)" aria-label="Recuar uma camada" onClick={() => reorderSelection('backward')}><ChevronDown size={14} /></Button>
              <Button title="Avançar (Ctrl+])" aria-label="Avançar uma camada" onClick={() => reorderSelection('forward')}><ChevronUp size={14} /></Button>
              <Button title="Trazer para frente (Ctrl+Shift+])" aria-label="Trazer para frente" onClick={() => reorderSelection('front')}><ArrowUpToLine size={14} /></Button>
            </div>
            {els.length > 1 && (
              <>
                <Label>Alinhar</Label>
                <div className="flex gap-1 flex-wrap">
                  {(['left', 'center-x', 'right', 'top', 'center-y', 'bottom'] as const).map((m) => (
                    <Button key={m} onClick={() => alignSelection(m)} title={m}>
                      {{ left: '⇤', 'center-x': '↔', right: '⇥', top: '⤒', 'center-y': '↕', bottom: '⤓' }[m]}
                    </Button>
                  ))}
                </div>
              </>
            )}
            <Label>Ações</Label>
            <div className="flex gap-1 flex-wrap">
              <Button onClick={() => duplicateSelected()} title="Duplicar (Ctrl+D)"><Copy size={13} /> Duplicar</Button>
              {els.length > 1 && <Button onClick={groupSelection} title="Agrupar (Ctrl+G)"><Group size={13} /> Agrupar</Button>}
              {grouped && <Button onClick={ungroupSelection} title="Desagrupar (Ctrl+Shift+G)"><Ungroup size={13} /> Desagrupar</Button>}
              <Button onClick={toggleLockSelection} title="Bloquear (Ctrl+Shift+L)">{locked ? <><LockOpen size={13} /> Desbloquear</> : <><Lock size={13} /> Bloquear</>}</Button>
              <Button variant="danger" onClick={deleteSelected} title="Excluir (Delete)"><Trash2 size={13} /> Excluir</Button>
            </div>
          </>
        )}
        {els.length === 0 && tool === 'select' && <BoardSettings />}
        {els.length === 0 && <div className="mt-4 text-[11px] text-soft leading-relaxed">Sem seleção: as alterações de estilo acima valem para os próximos elementos desenhados.</div>}
      </div>
    </aside>
  );
}
