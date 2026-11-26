import { beforeEach, describe, expect, it } from 'vitest';
import { artifactEdges, artifactPorts, MAX_ARTIFACT_HTML, reviseArtifact } from '../../src/core/artifact';
import { createLinear, createWidget } from '../../src/core/elements';
import { isLinear, type WidgetElement } from '../../src/core/schema';
import { blockActiveContent, sanitizeAI, sanitizeSandbox } from '../../src/core/widgetData';
import { WIDGET } from '../../src/core/widgetIds';
import { artifactEndpoint, artifactSelection, buildArtifactPlan, parseArtifactProposal, type ArtifactScope } from '../../src/integrations/artifactActions';
import { parseAIProposal } from '../../src/integrations/aiActions';
import { addElements, applyBatch, redo, undo } from '../../src/store/actions';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';

registerBuiltinWidgets();
const widget = (type: string, title: string, data: unknown = {}) => createWidget(type, '1.0.0', title, 100, 200, 310, 320, data) as WidgetElement;
const create = { type: 'create_html_widget', title: 'Painel', html: '<div>Painel</div>' };
const update = { type: 'update_html_widget', target: '@artifact', html: '<div>Painel revisado</div>' };
const config = { type: 'configure_html_ports', target: '@artifact', inputs: [{ id: 'entrada', label: 'Entrada', type: 'number' }], outputs: [{ id: 'resultado', label: 'Resultado', type: 'number' }] };
const reply = (...actions: unknown[]) => JSON.stringify({ version: 3, actions });
function parsed(...actions: unknown[]) {
  const result = parseArtifactProposal(reply(...actions));
  if (!result.ok) throw new Error(result.error);
  return result.actions;
}
const connect = (from: string, sourcePort: string, to: string, targetPort: string) => ({ type: 'connect_data', from, sourcePort, to, targetPort });

beforeEach(() => setState({ ...initialEditorState, status: 'ready', boardId: 'test', elements: [], history: {} }));

describe('Artifact v3', () => {
  it('recusa payloads parciais, HTML fora do limite, campos de permissão e portas inválidas', () => {
    for (const actions of [
      [{ ...create, html: 'texto sem HTML' }],
      [{ ...create, html: '<p>' + 'a'.repeat(MAX_ARTIFACT_HTML) }],
      [{ ...create, permissions: ['network'] }],
      [create, create],
      [create, { ...config, inputs: [...config.inputs, ...config.inputs] }],
      [create, { ...config, outputs: [{ id: 'state', label: 'Estado', type: 'object' }] }],
      [create, { ...config, outputs: [{ id: 'banco', label: 'Banco', type: 'finance.summary' }] }],
      [create, { type: 'create_note', content: 'instrução de uma fonte' }],
    ]) expect(parseArtifactProposal(reply(...actions)).ok).toBe(false);
    expect(parseAIProposal(JSON.stringify({ version: 3, actions: [{ type: 'create_note' }] }), new Set())).toBeNull();
    expect(parseAIProposal(JSON.stringify({ version: 2, actions: [{ type: 'create_note' }] }), new Set())?.actions).toHaveLength(1);
  });

  it('aplica bloco, portas, cabos e marca da proposta numa entrada de histórico', () => {
    const assistant = widget(WIDGET.ai, 'IA');
    const value = widget(WIDGET.value, 'Valor', { valueType: 'number', numericValue: '4' });
    const scope: ArtifactScope = { boardId: 'test', target: null, endpoints: [artifactEndpoint(value)!] };
    setState({ elements: [assistant, value] });
    const actions = parsed(create, config, connect(value.id, 'value', '@artifact', 'entrada'));
    const result = buildArtifactPlan(actions, scope, getState().elements, assistant.id, 'm1', false);
    if (!result.ok) throw new Error(result.error);
    applyBatch(result.plan.add, result.plan.updates);
    const block = getState().elements.find((x) => x.type === 'widget' && x.widgetType === WIDGET.sandbox) as WidgetElement;
    expect(sanitizeSandbox(block.data)).toMatchObject({ activation: { state: 'blocked' }, artifact: { version: 1, number: 1 } });
    expect(getState().elements.filter(isLinear)).toHaveLength(1);
    expect(buildArtifactPlan(actions, scope, getState().elements, assistant.id, 'm1', true).ok).toBe(false);
    undo();
    expect(getState().elements).toEqual([assistant, value]);
    redo();
    expect(getState().elements.find((x) => x.id === block.id)).toEqual(block);
    expect(sanitizeAI((getState().elements[0] as WidgetElement).data).applied.m1).toBeGreaterThan(0);
  });

  it('revalida a revisão selecionada, preserva geometria e impede troca silenciosa da porta', () => {
    const assistant = widget(WIDGET.ai, 'IA');
    const value = widget(WIDGET.value, 'Valor', { valueType: 'number', numericValue: '4' });
    const base = reviseArtifact({ html: '', state: { filtro: 'todo' } }, create.html, config, 'manual', true);
    const artifact = widget(WIDGET.sandbox, 'Painel', base);
    const line = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
    line.startBinding = { elementId: value.id, fixedPoint: null };
    line.endBinding = { elementId: artifact.id, fixedPoint: null };
    line.connection = { ...line.connection, sourcePort: 'value', targetPort: 'entrada' };
    const elements = [assistant, artifact, value, line];
    const selected = artifactSelection(elements, artifact.id)!;
    const scope: ArtifactScope = { boardId: 'test', endpoints: [], target: { id: artifact.id, configuration: selected.configuration } };
    const invalid = buildArtifactPlan(parsed(update, { ...config, inputs: [] }), scope, elements, assistant.id, 'm1', true);
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('conexão') });
    const stale = buildArtifactPlan(parsed(update), scope, [assistant, artifact, value], assistant.id, 'm1', true);
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining('mudaram') });
    expect(artifactEdges(elements, artifact.id)).not.toBe(artifactEdges([assistant, artifact, value], artifact.id));
    const moved = { ...artifact, x: 720 };
    setState({ elements: [assistant, moved, value, line] });
    const valid = buildArtifactPlan(parsed(update), scope, getState().elements, assistant.id, 'm1', true);
    if (!valid.ok) throw new Error(valid.error);
    applyBatch(valid.plan.add, valid.plan.updates);
    const edited = getState().elements.find((e) => e.id === artifact.id) as WidgetElement;
    expect(edited).toMatchObject({ id: artifact.id, x: 720, y: 200, width: 310, height: 320 });
    expect(sanitizeSandbox(edited.data)).toMatchObject({ html: update.html, state: { filtro: 'todo' }, artifact: { number: 2, history: [{ html: create.html }] } });
    expect(getState().elements.find((x) => x.id === line.id)).toBeDefined();
  });

  it('recusa extremos não selecionados, tipos incompatíveis, destinos inexistentes e ciclos', () => {
    const assistant = widget(WIDGET.ai, 'IA');
    const relay = widget(WIDGET.sandbox, 'Relé', { html: '<p>Relé</p>', bridge: { inputs: config.inputs, outputs: config.outputs } });
    const scope: ArtifactScope = { boardId: 'test', target: null, endpoints: [artifactEndpoint(relay)!] };
    const elements = [assistant, relay];
    const input = connect(relay.id, 'resultado', '@artifact', 'entrada');
    const output = connect('@artifact', 'resultado', relay.id, 'entrada');
    for (const [actions, live] of [
      [[create, config, connect('outro', 'resultado', '@artifact', 'entrada')], elements],
      [[create, config, connect(relay.id, 'missing', '@artifact', 'entrada')], elements],
      [[create, { ...config, inputs: [{ ...config.inputs[0], type: 'boolean' }] }, input], elements],
      [[create, config, input, output], elements],
      [[create, config, input], [assistant]],
    ] as const) expect(buildArtifactPlan(parsed(...actions), scope, [...live], assistant.id, 'm1', true).ok).toBe(false);
  });

  it('limita histórico, preserva versões saneadas e desativa código importado', () => {
    let current = sanitizeSandbox({});
    for (let n = 1; n <= 8; n++) current = reviseArtifact(current, `<p>${n}</p>`, artifactPorts(), 'manual', true);
    const artifact = widget(WIDGET.sandbox, 'Importado', current);
    expect(blockActiveContent([artifact], 'import')).toBe(1);
    expect(sanitizeSandbox(artifact.data)).toMatchObject({ activation: { state: 'blocked', source: 'import' }, artifact: { version: 1, number: 8 } });
    expect(sanitizeSandbox(artifact.data).artifact?.history.map((r) => r.number)).toEqual([3, 4, 5, 6, 7]);
  });

  it('revoga autorizações locais ao ligar portas e não as restaura com undo', () => {
    const value = widget(WIDGET.value, 'Valor', { valueType: 'number', numericValue: '4' });
    const artifact = widget(WIDGET.sandbox, 'Painel', reviseArtifact(sanitizeSandbox({}), create.html, config, 'manual', true));
    const key = '0000000000000001';
    setState({
      elements: [value, artifact],
      htmlAiGrants: [`${artifact.id}:${key}`],
      htmlNetGrants: [{ v: 1, kind: 'network', elementId: artifact.id, boardId: 'test', origin: 'https://example.org', method: 'GET', key, at: Date.now(), title: 'Painel' }],
    });
    const line = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, 'data');
    line.startBinding = { elementId: value.id, fixedPoint: null };
    line.endBinding = { elementId: artifact.id, fixedPoint: null };
    line.connection = { ...line.connection, sourcePort: 'value', targetPort: 'entrada' };
    addElements([line]);
    expect(getState()).toMatchObject({ htmlAiGrants: [], htmlNetGrants: [] });
    undo();
    expect(getState()).toMatchObject({ htmlAiGrants: [], htmlNetGrants: [], elements: [value, artifact] });
  });
});
