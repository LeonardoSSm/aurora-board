import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type React from 'react';
import { Box } from 'lucide-react';
import type { WidgetPlugin, WidgetProps } from '../registry';
import { sanitizeSandbox, type SandboxData } from '../../core/widgetData';
import { MAX_ARTIFACT_HTML, artifactCodeError, artifactConfiguration, artifactEdges, artifactPorts, reviseArtifact, type ArtifactRevision } from '../../core/artifact';
import { WIDGET } from '../../core/widgetIds';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import { isLinear } from '../../core/schema';
import { aiConfigDigest, BRIDGE_INPUT_TYPES, BRIDGE_LIMITS, BRIDGE_OUTPUT_TYPES, BRIDGE_TYPE_LABELS, BRIDGE_VERSION, buildHtmlAIText, buildInputSnapshot, digest, emptyBridge, isValidPortId, sanitizeBridge, type BridgeConfig, type BridgePort, type InputSnapshot } from '../../core/htmlBridge';
import { dataUpstream, directInputEdges } from '../../core/dataUpstream';
import { beginGeneration, clearOutputs, endGeneration, isCurrentToken, outputEntry, outputsOf, outputsVersion, publishOutput, randomToken, subscribeOutputs } from '../htmlOutputs';
import { useDataflow } from '../dataflow';
import { getState, useEditor } from '../../store/editor';
import { grantHtmlAI, revokeHtmlAI } from '../../store/actions';
import { toast } from '../../store/ui';
import { financialTaint } from '../../integrations/aiContext';
import { Badge, Button, Field, Label, Segmented, Select } from '../../ui/primitives';
import { BRIDGE_EXAMPLES } from './sandboxExamples';
import { ARTIFACT_EXAMPLES } from './artifactExamples';
import { sanitizeDatasetData } from './dataset';
import { datasetGrantKey } from '../../data/aiShare';
import { NetSession, netAvailability, netReloadOf, revokeNetAccess, subscribeNet } from '../../net/broker';
import { NetAccessPanel } from '../../net/NetAccessPanel';
import { netError, parseRequestMessage, responseMessage } from '../../net/protocol';
import '../../net/consent';
import { artifactConnectionImpact } from '../../integrations/artifactActions';

/**
 * Host de widgets isolados. O conteúdo roda em <iframe sandbox="allow-scripts"> SEM allow-same-origin:
 * não acessa cookies, IndexedDB, DOM do app nem a rede com credenciais do app.
 * Comunicação apenas por postMessage, com mensagens validadas e limite de tamanho.
 *
 * Protocolo (v1 — HTML Data Bridge, issue #11; ver docs/HTML_DATA_BRIDGE.md):
 *   app → iframe: { type: 'aurora:load', html, state, bridge?: { v, token, ports, inputs, connections } }
 *                 { type: 'aurora:inputs', token, inputs, connections }       (só quando mudam)
 *   iframe → app: { type: 'aurora:setState', token?, state }                  (JSON, até 100 KB; gravado)
 *                 { type: 'aurora:publish', token, port, value }              (validado; NÃO gravado)
 *                 { type: 'aurora:request' | 'aurora:abort', token, id, … }   (H2 — ver src/net/broker.ts)
 *   app → iframe: { type: 'aurora:response', token, id, ok, result | error }   (H2)
 * O `token` identifica a montagem atual do iframe: mensagens de montagens anteriores são descartadas.
 */
const MAX_STATE = 100_000;
/** Limite de atualizações de estado por segundo vindas de um iframe (as excedentes viram uma só: a última). */
export const MAX_UPDATES_PER_SECOND = 10;

/**
 * CSP do documento isolado (public/sandbox.html, também enviada como cabeçalho pela hospedagem): só scripts e
 * estilos inline; sem rede, frames, formulários, base ou objetos. Testada contra os dois arquivos.
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

/** Documento hospedeiro: um documento PRÓPRIO, que não herda a CSP do app (um srcdoc herdaria). */
export const SANDBOX_DOCUMENT_URL = '/sandbox.html';

/** Valida uma mensagem recebida do iframe. Retorna null se não for do protocolo. */
export function parseSandboxMessage(data: unknown): { ok: true; state: unknown } | { ok: false; error: string } | null {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'aurora:setState') return null;
  if (Object.keys(data as object).some((k) => k !== 'type' && k !== 'state' && k !== 'token')) return { ok: false, error: 'Mensagem com campos inesperados ignorada.' };
  try {
    const json = JSON.stringify((data as { state?: unknown }).state ?? null);
    if (json === undefined) return { ok: false, error: 'Estado inválido recebido do widget.' };
    if (json.length > MAX_STATE) return { ok: false, error: 'Estado excede 100 KB e foi ignorado.' };
    return { ok: true, state: JSON.parse(json) };
  } catch {
    return { ok: false, error: 'Estado inválido recebido do widget.' };
  }
}

/** Mensagem de publicação da ponte de dados. Retorna null se não for desse tipo ou estiver malformada. */
export function parseBridgeMessage(data: unknown): { token: string; port: string; value: unknown } | null {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'aurora:publish') return null;
  const o = data as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'type' && k !== 'token' && k !== 'port' && k !== 'value')) return null;
  if (typeof o.token !== 'string' || typeof o.port !== 'string' || o.port.length > 64) return null;
  return { token: o.token, port: o.port, value: o.value };
}

/**
 * Limitador "a última vence": no máximo N entregas por segundo; a última pendente é entregue depois.
 * `cancel()` descarta a pendente e impede entregas futuras (desmontagem: nada chega depois do fim da montagem).
 */
export function createThrottle<T>(
  deliver: (v: T) => void,
  perSecond = MAX_UPDATES_PER_SECOND,
  now = () => Date.now(),
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
) {
  let windowStart = -Infinity, count = 0, pending: { v: T } | null = null, scheduled = false, cancelled = false;
  const flush = () => {
    scheduled = false;
    if (cancelled) { pending = null; return; }
    windowStart = now();
    count = 0;
    if (pending) { const p = pending; pending = null; count = 1; deliver(p.v); }
  };
  const push = (v: T) => {
    if (cancelled) return;
    const t = now();
    if (t - windowStart >= 1000) { windowStart = t; count = 0; }
    if (count < perSecond && !scheduled) { count++; deliver(v); return; }
    pending = { v };
    if (!scheduled) { scheduled = true; schedule(flush, Math.max(0, 1000 - (t - windowStart))); }
  };
  return Object.assign(push, { cancel: () => { cancelled = true; pending = null; } });
}

/** Iframes de HTML ativos ao mesmo tempo (os excedentes ficam pausados até liberar vaga). */
export const MAX_ACTIVE_FRAMES = 20;
/** Tamanho máximo do HTML executado (o mesmo teto da importação). */
export const MAX_HTML_CHARS = 500_000;

/**
 * Modo seguro: `?safe` na URL desliga TODO HTML personalizado nesta sessão — recuperação caso um widget
 * atrapalhe o uso do quadro (o último quadro aberto é reaberto ao iniciar).
 */
export const SAFE_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('safe');

/* Vagas de iframe (S1-SEC-003: limite de frames simultâneos). */
const slots = new Set<string>();
const waiters = new Set<() => void>();
function useFrameSlot(key: string, wanted: boolean): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    let claimed = false;
    const tryClaim = () => {
      if (claimed || slots.size >= MAX_ACTIVE_FRAMES) return;
      slots.add(key);
      claimed = true;
      waiters.delete(tryClaim);
      setHas(true);
    };
    tryClaim();
    if (!claimed) waiters.add(tryClaim);
    return () => {
      waiters.delete(tryClaim);
      if (claimed) {
        slots.delete(key);
        setHas(false);
        for (const w of [...waiters]) w();
      }
    };
  }, [key, wanted]);
  return has;
}

export interface FrameBridge {
  elementId: string;
  signature: string;
  ports: { inputs: BridgePort[]; outputs: BridgePort[] };
  snapshot: InputSnapshot;
}

type RuntimeStatus = 'ready' | 'error' | 'timeout';

export function SandboxFrame({ html, state, onState, title, bridge, elementId: netElementId, onRuntime }: { html: string; state: unknown; onState: (s: unknown, taint: string[]) => void; title: string; bridge?: FrameBridge; elementId?: string; onRuntime?: (status: RuntimeStatus) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const [navigated, setNavigated] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loads = useRef(0);
  const navigatedRef = useRef(false);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const runtime = useRef(onRuntime);
  runtime.current = onRuntime;
  const startupTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  // Geração desta montagem: mensagens com outro token (montagens anteriores) não alteram nada.
  const tokenRef = useRef('');
  const loadedRef = useRef(false);
  const sentInputs = useRef('');
  if (!tokenRef.current) tokenRef.current = randomToken();
  const elementId = bridge?.elementId;
  const signature = bridge?.signature;
  // H2: uma sessão de rede por montagem do iframe (mesmo token). Desmontar = cancelar tudo o que estiver pendente.
  const netRef = useRef<NetSession | null>(null);
  useLayoutEffect(() => {
    if (!netElementId) return;
    const session = new NetSession({ elementId: netElementId, token: tokenRef.current, post: (m) => { if (!navigatedRef.current) ref.current?.contentWindow?.postMessage(m, '*'); } });
    netRef.current = session;
    return () => { session.dispose(); if (netRef.current === session) netRef.current = null; };
    // `nonce`: “Recarregar widget” depois de uma navegação bloqueada começa uma sessão nova.
  }, [netElementId, nonce]);
  useLayoutEffect(() => {
    if (!elementId || !signature) return;
    const token = tokenRef.current;
    beginGeneration(elementId, token, signature);
    return () => endGeneration(elementId, token);
  }, [elementId, signature, nonce]);
  // useLayoutEffect: o listener existe antes de o iframe (inserido neste mesmo commit) conseguir postar a
  // primeira mensagem — com useEffect, o WebKit às vezes entregava o primeiro setState antes do registro.
  useLayoutEffect(() => {
    // H2: a marca de dados protegidos é capturada quando a mensagem CHEGA (a sessão ainda existe), não na entrega
    // atrasada pelo limitador; e nada é entregue depois da desmontagem (Codex PR #33: “Limpar estado e recarregar”).
    const deliver = createThrottle<{ st: unknown; taint: string[]; token: string }>(({ st, taint, token }) => {
      if (!navigatedRef.current && token === tokenRef.current) onStateRef.current(st, taint);
    });
    let windowStart = 0, inWindow = 0, warned = false;
    const onMessage = (e: MessageEvent) => {
      // Só aceita mensagens do PRÓPRIO iframe (identidade da janela; a origem do srcdoc é opaca)
      // e nunca depois de o frame ter navegado para outro documento.
      if (!ref.current || e.source !== ref.current.contentWindow || e.origin !== 'null' || navigatedRef.current) return;
      const type = (e.data as { type?: unknown } | null)?.type;
      if (type === 'aurora:runtime' && runtime.current) {
        const d = e.data as Record<string, unknown>;
        if (Object.keys(d).length !== 3 || d.token !== tokenRef.current || (d.status !== 'ready' && d.status !== 'error')) return;
        if (d.status === 'ready') clearTimeout(startupTimer.current);
        runtime.current(d.status);
        return;
      }
      if (type === 'aurora:request' || type === 'aurora:abort') {
        if (netRef.current) { netRef.current.handle(e.data); return; }
        // Bloco sem sessão de rede (widgets de terceiros): responde “indisponível” a quem tiver token válido.
        const m = parseRequestMessage(e.data);
        if (m && m.token === tokenRef.current) ref.current.contentWindow?.postMessage(responseMessage(m.token, m.id, netError('unavailable', 'Este tipo de bloco não tem acesso à rede.')), '*');
        return;
      }
      const pub = parseBridgeMessage(e.data);
      if (pub) {
        // Teto de publicações por segundo (protege contra laços no HTML do usuário). O setState tem a sua
        // própria regra — no máximo 10 gravações por segundo, a última vence — e não passa por este teto.
        const now = Date.now();
        if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
        if (++inWindow > BRIDGE_LIMITS.maxMessagesPerSecond) {
          if (!warned) { warned = true; setError(`Mais de ${BRIDGE_LIMITS.maxMessagesPerSecond} publicações por segundo: as excedentes foram descartadas.`); }
          return;
        }
        const b = bridgeRef.current;
        if (!b || pub.token !== tokenRef.current || !isCurrentToken(b.elementId, pub.token)) return;
        const err = publishOutput(b.elementId, pub.token, b.ports.outputs, pub.port, pub.value);
        setError(err ?? '');
        return;
      }
      if (type !== 'aurora:setState') return;
      const tok = (e.data as { token?: unknown }).token;
      if (runtime.current ? tok !== tokenRef.current : tok !== undefined && tok !== '' && tok !== tokenRef.current) return;
      const r = parseSandboxMessage(e.data);
      if (r?.ok) deliver({ st: r.state, taint: netRef.current?.taintIds() ?? [], token: tokenRef.current });
      else if (r) setError(r.error);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); deliver.cancel(); clearTimeout(startupTimer.current); };
  }, []);
  // Entradas: só reenviadas quando o conteúdo muda (sem eco; até 10 por segundo, a última vence).
  const postInputs = useMemo(() => createThrottle<InputSnapshot>((snap) => {
    if (!loadedRef.current || navigatedRef.current || snap.json === sentInputs.current) return;
    sentInputs.current = snap.json;
    ref.current?.contentWindow?.postMessage({ type: 'aurora:inputs', token: tokenRef.current, inputs: snap.inputs, connections: snap.connections }, '*');
  }), []);
  const snapJson = bridge?.snapshot.json;
  useEffect(() => { if (bridgeRef.current) postInputs(bridgeRef.current.snapshot); }, [snapJson, postInputs]);
  if (navigated) {
    return (
      <div data-testid="sandbox-navigated" className="flex flex-col h-full gap-2 items-start justify-center p-3 rounded-md border border-warn/50 bg-warn/10 text-[11px] text-fg-2">
        <b className="text-warn">Widget bloqueado</b>
        O HTML tentou carregar outra página dentro do quadro. Isso não é permitido (a página carregada sairia do isolamento sem rede).
        <button className="h-6 px-2 rounded border border-line text-[11px] hover:bg-panel-3" onClick={() => {
          loads.current = 0;
          loadedRef.current = false;
          sentInputs.current = '';
          tokenRef.current = randomToken();
          navigatedRef.current = false;
          setNavigated(false);
          setNonce((n) => n + 1);
        }}>Recarregar widget</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full gap-1">
      <iframe
        key={nonce}
        ref={ref}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        src={SANDBOX_DOCUMENT_URL}
        className="flex-1 w-full rounded-md border border-line/60 bg-[#0a111c]"
        onLoad={() => {
          loads.current++;
          // O documento hospedeiro dispara UM load. Um segundo load significa que o frame navegou (location, meta
          // refresh, link): o novo documento está fora do nosso controle, então o widget é desmontado e nada mais
          // é aceito dele. (A CSP do app, frame-src 'self', já impede navegar para outras origens.)
          if (loads.current > 1) { navigatedRef.current = true; netRef.current?.dispose(); netRef.current = null; clearTimeout(startupTimer.current); setNavigated(true); return; }
          const b = bridgeRef.current;
          loadedRef.current = true;
          if (b) sentInputs.current = b.snapshot.json;
          const net = netRef.current ? netAvailability() : { available: false, message: 'Este tipo de bloco não tem acesso à rede.' };
          if (runtime.current) startupTimer.current = setTimeout(() => runtime.current?.('timeout'), 5_000);
          ref.current?.contentWindow?.postMessage({ type: 'aurora:load', html: htmlRef.current, state: stateRef.current, reportRuntime: !!runtime.current, net: { v: 1, token: tokenRef.current, available: net.available, message: net.message }, ...(b ? { bridge: { v: BRIDGE_VERSION, token: tokenRef.current, ports: b.ports, inputs: b.snapshot.inputs, connections: b.snapshot.connections } } : {}) }, '*');
        }}
      />
      {error && <div className="text-[11px] text-warn">{error}</div>}
    </div>
  );
}

function SandboxNotice({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1.5 h-full p-2.5 rounded-md border border-line/70 bg-[#0a111c] text-[11px] text-fg-2 overflow-auto">
      <b className="text-[12px] text-fg">{title}</b>
      {children}
    </div>
  );
}

const STATE_PORT = { id: 'state', label: 'Estado', type: 'any' };

const EXAMPLE = `<div style="padding:12px">
  <b>Contador isolado</b>
  <p id="v">0</p>
  <button id="b">+1</button>
</div>
<script>
  let n = 0;
  const v = document.getElementById('v');
  addEventListener('aurora:init', e => { n = (e.detail && e.detail.n) || 0; v.textContent = n; });
  document.getElementById('b').onclick = () => { n++; v.textContent = n; aurora.setState({ n }); };
</script>`;

export const sandboxPlugin: WidgetPlugin<SandboxData> = {
  id: WIDGET.sandbox,
  name: 'HTML isolado',
  description: 'Executa HTML/JS próprio em sandbox (sem acesso ao app). Base para plugins de terceiros.',
  icon: Box,
  version: '1.0.0',
  category: 'Desenvolvimento',
  status: 'experimental',
  statusNote: 'Isolado por iframe sandbox + CSP (sem rede própria). Recebe só os dados das conexões ligadas às entradas; consultas GET a APIs HTTPS só pelo Aurora Board, com sua autorização (aurora.request).',
  accent: '#9cb1cf',
  permissions: ['sandbox:scripts'],
  defaultSize: { width: 360, height: 300 },
  librarySection: 'Aurora Artifacts',
  presets: ARTIFACT_EXAMPLES,
  inputs: [],
  outputs: [STATE_PORT],
  // Ponte de dados (issue #11): a porta legada `state` continua (conexões antigas não mudam).
  ports: (d) => ({ inputs: d.bridge?.inputs ?? [], outputs: [STATE_PORT, ...(d.bridge?.outputs ?? [])] }),
  createData: () => ({ html: EXAMPLE, state: null }),
  sanitize: sanitizeSandbox,
  compute: (d, _inputs, el) => ({ state: d.state, ...(d.bridge ? outputsOf(el.id, d.bridge.outputs) : {}) }),
  // Resumo sem conteúdo (busca/exportação): o estado e as saídas podem conter qualquer dado.
  summarize: (d) => `Widget HTML isolado${d.bridge ? ` (entradas: ${d.bridge.inputs.map((p) => p.id).join(', ') || 'nenhuma'}; saídas: ${d.bridge.outputs.map((p) => p.id).join(', ') || 'nenhuma'})` : ''}.`,
  aiContext: (d, el) => htmlAIPolicy(d, el),
  Inspector: (props) => <SandboxInspector {...props} />,
  Component: function Sandbox({ data, update, element, selected, api, inputs }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(data.html);
    const [showCode, setShowCode] = useState(false);
    const [draftError, setDraftError] = useState('');
    const [runtime, setRuntime] = useState<{ key: string; status: RuntimeStatus } | null>(null);
    const [retry, setRetry] = useState(0);
    const editSource = useRef('');
    const artifact = data.artifact;
    const edgeKey = useEditor((s) => artifact ? artifactEdges(s.elements, element.id) : '');
    const signature = useMemo(() => artifact ? artifactConfiguration(data, edgeKey) : bridgeSignature(data), [artifact, data.html, data.activation, data.bridge, edgeKey]);
    const blocked = data.activation?.state === 'blocked';
    const tooBig = data.html.length > (artifact ? MAX_ARTIFACT_HTML : MAX_HTML_CHARS);
    // Só re-renderiza quando o painel pede “Limpar estado e recarregar” (não a cada consulta).
    const netReload = useSyncExternalStore(subscribeNet, () => netReloadOf(element.id));
    const frameKey = `${signature}:${netReload}:${retry}`;
    const status = runtime?.key === frameKey ? runtime.status : null;
    const slot = useFrameSlot(`${element.id}:${useId()}`, !editing && !blocked && !SAFE_MODE && !tooBig && status !== 'timeout');
    const bridgeInputs = data.bridge?.inputs;
    const snapshot = useMemo(() => (bridgeInputs ? buildInputSnapshot(bridgeInputs, inputs) : null), [bridgeInputs, inputs]);
    const frameBridge = useMemo<FrameBridge | undefined>(() => (data.bridge && snapshot ? { elementId: element.id, signature, ports: { inputs: data.bridge.inputs, outputs: data.bridge.outputs }, snapshot } : undefined), [data.bridge, snapshot, element.id, signature]);
    const live = () => {
      const el = api.getElement(element.id);
      if (!el || el.type !== 'widget' || el.widgetType !== WIDGET.sandbox || el.locked) return null;
      const current = sanitizeSandbox(el.data);
      return { el, data: current, key: artifactConfiguration(current, artifactEdges(api.getElements(), el.id)) };
    };
    const origin = data.activation?.source === 'paste' ? 'conteúdo colado' : data.activation?.source === 'import' ? 'um arquivo importado' : 'uma revisão salva';
    const activate = async () => {
      const before = live();
      if (!before || before.data.activation?.state !== 'blocked') return;
      if (artifact) {
        const error = artifactCodeError(before.data.html);
        if (error) { api.toast(error, 'error'); return; }
      }
      const ok = await api.confirm(
        artifact ? 'Autorizar execução do Artifact?' : 'Ativar HTML personalizado',
        `Este código veio de ${origin}. O JavaScript roda em um iframe isolado e recebe as entradas conectadas. Consultas a APIs HTTPS pedem autorização por destino no Board.`,
        'Ativar este widget',
      );
      if (!ok) return;
      if (live()?.key !== before.key) { api.toast('O painel mudou. Revise o código antes de executar.', 'warning'); return; }
      update({ activation: { state: 'allowed', source: before.data.activation.source, at: Date.now() } });
    };
    const openEditor = () => {
      const current = live();
      if (!current) return;
      editSource.current = current.key;
      setDraft(current.data.html);
      setDraftError('');
      setEditing(true);
    };
    const saveDraft = () => {
      const current = live();
      if (!current || current.key !== editSource.current) { setDraftError('O painel mudou. Reabra o editor para revisar a versão atual.'); return; }
      if (artifact) {
        const error = artifactCodeError(draft);
        if (error) { setDraftError(error); return; }
        if (draft !== current.data.html) update(reviseArtifact(current.data, draft, artifactPorts(current.data.bridge), 'manual', false));
      } else {
        if (draft.length > MAX_HTML_CHARS) { setDraftError('O HTML excede o limite do widget.'); return; }
        update({ html: draft, activation: undefined });
      }
      setEditing(false);
    };
    const restore = async (revision: ArtifactRevision) => {
      const current = live();
      if (!current) return;
      const next = reviseArtifact(current.data, revision.html, artifactPorts(revision), 'restore', false);
      const error = artifactCodeError(revision.html) ?? artifactConnectionImpact(api.getElements(), current.el, next);
      if (error) { api.toast(error, 'error'); return; }
      const ok = await api.confirm('Restaurar revisão do Artifact?', `A v${revision.number} será salva como uma nova revisão pausada, preservando o código atual no histórico. Revise antes de executar.`, 'Restaurar pausado');
      if (!ok) return;
      const latest = live();
      if (!latest || latest.key !== current.key) { api.toast('O painel mudou. Revise antes de restaurar.', 'warning'); return; }
      const revised = reviseArtifact(latest.data, revision.html, artifactPorts(revision), 'restore', false);
      const impact = artifactConnectionImpact(api.getElements(), latest.el, revised);
      if (impact) { api.toast(impact, 'error'); return; }
      update(revised);
    };
    let body: React.ReactNode;
    if (editing) {
      body = (
        <>
          <textarea aria-label="Código HTML" data-scrollable value={draft} onChange={(e) => { setDraft(e.target.value); setDraftError(''); }} spellCheck={false} className="flex-1 min-h-[80px] p-2 rounded-md bg-[#0a111c] border border-line font-mono text-[11px] resize-none" />
          {draftError && <p role="alert" className="text-warn text-[11px]">{draftError}</p>}
          <div className="flex justify-end gap-1.5">
            <button className="h-7 px-2 text-[11px] text-muted" onClick={() => { setDraft(data.html); setEditing(false); }}>Cancelar</button>
            <button className="h-7 px-3 rounded-md bg-[#3174db] text-white text-[11px]" onClick={saveDraft}>{artifact ? 'Salvar revisão pausada' : 'Aplicar'}</button>
          </div>
        </>
      );
    } else if (SAFE_MODE) {
      body = <SandboxNotice testId="sandbox-safe-mode" title="Modo seguro">HTML personalizado desligado nesta sessão (endereço com <code>?safe</code>). Recarregue sem o parâmetro para executar.</SandboxNotice>;
    } else if (blocked) {
      body = (
        <SandboxNotice testId="sandbox-inactive" title="HTML personalizado desativado">
          <span>Veio de {origin}. Autorize para executar. {data.html.length.toLocaleString('pt-BR')} caracteres.</span>
          <div className="flex gap-1.5">
            <button className="h-6 px-2 rounded border border-line hover:bg-panel-3" onClick={() => setShowCode((v) => !v)}>{showCode ? 'Ocultar código' : 'Ver código'}</button>
            <button data-testid="sandbox-activate" className="h-6 px-2 rounded border border-warn/60 text-warn hover:bg-warn/10" onClick={() => void activate()}>Ativar…</button>
          </div>
          {showCode && <pre data-scrollable className="font-mono text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-auto bg-[#060b13] p-1.5 rounded">{data.html}</pre>}
        </SandboxNotice>
      );
    } else if (tooBig) {
      body = <SandboxNotice testId="sandbox-too-big" title="HTML grande demais">Limite de {(artifact ? MAX_ARTIFACT_HTML : MAX_HTML_CHARS).toLocaleString('pt-BR')} caracteres.</SandboxNotice>;
    } else if (status === 'timeout') {
      body = <SandboxNotice testId="artifact-timeout" title="Execução interrompida">O painel demorou a iniciar.<Button onClick={() => setRetry((n) => n + 1)}>Tentar executar de novo</Button></SandboxNotice>;
    } else if (!slot) {
      body = <SandboxNotice testId="sandbox-paused" title="Pausado">Há {MAX_ACTIVE_FRAMES} widgets HTML em execução. Este começa quando outro for fechado.</SandboxNotice>;
    } else {
      body = <SandboxFrame key={frameKey} html={data.html} state={data.state} title={element.title} elementId={element.id}
        onRuntime={artifact ? (next) => setRuntime((prev) => prev?.key === frameKey && prev.status === 'error' && next === 'ready' ? prev : { key: frameKey, status: next }) : undefined}
        onState={(state, taint) => {
          if (artifact && taint.length) return;
          update((d) => ({ ...d, state, ...(taint.length ? { stateTaint: { sources: taint, at: Date.now() } } : {}) }), { coalesce: true });
        }} bridge={frameBridge} />;
    }
    return (
      <div className="flex flex-col gap-1.5 h-full" data-testid={artifact ? 'artifact-widget' : undefined}>
        {artifact && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          <Badge tone="accent">Artifact v{artifact.number}</Badge>
          <span role="status">{editing ? 'Editando' : blocked || SAFE_MODE ? 'Pausado' : status === 'error' || status === 'timeout' ? 'Falha de execução' : status === 'ready' ? 'Em execução' : slot ? 'Iniciando…' : 'Aguardando vaga'}</span>
          <span>{data.bridge?.inputs.length ?? 0} entradas · {data.bridge?.outputs.length ?? 0} saídas</span>
        </div>}
        {status === 'error' && !blocked && !editing && <p role="alert" className="text-[11px] text-warn">O código registrou um erro. Edite ou restaure uma revisão.</p>}
        <div className="min-h-0 flex-1 flex flex-col">{body}</div>
        {!editing && (selected || artifact) && <div className="flex flex-wrap gap-1">
          <button disabled={element.locked} className="h-6 px-2 text-[11px] text-muted hover:text-fg" onClick={openEditor}>{artifact ? 'Código' : 'Editar HTML'}</button>
          {artifact && !blocked && <button disabled={element.locked} className="h-6 px-2 text-[11px] text-muted hover:text-fg" onClick={() => update({ activation: { state: 'blocked', source: data.activation?.source ?? 'artifact', at: Date.now() } })}>{SAFE_MODE ? 'Manter pausado' : 'Pausar'}</button>}
          {artifact && artifact.history.length > 0 && <details className="relative text-[11px]">
            <summary data-interactive className="cursor-pointer px-2 py-1">Histórico</summary>
            <ul className="z-10 max-h-32 overflow-auto rounded border border-line bg-panel-2 p-1" data-scrollable>
              {[...artifact.history].reverse().map((rev, i) => <li key={i} className="flex flex-wrap items-center gap-1 py-0.5">
                <span>v{rev.number} · {{ ai: 'IA', manual: 'Manual', restore: 'Restauração', example: 'Exemplo' }[rev.origin]} · {new Date(rev.at).toLocaleDateString('pt-BR')}</span>
                <button className="underline" disabled={element.locked} onClick={() => void restore(rev)}>Restaurar v{rev.number}…</button>
              </li>)}
            </ul>
          </details>}
        </div>}
      </div>
    );
  },
};

/* ------------------------------------------------------------------ HTML Data Bridge (issue #11) */

/** Assinatura das portas+HTML: muda quando a definição muda (o iframe recomeça e as saídas antigas caem). */
function bridgeSignature(d: SandboxData): string {
  return digest(JSON.stringify([d.html.length, digest(d.html), d.bridge ? [d.bridge.inputs, d.bridge.outputs] : null]));
}

/**
 * Fontes PROTEGIDAS a montante, com o resumo da autorização de cada uma (troca de autorização revoga a do HTML):
 * consultas bancárias e, desde a issue #24 (D2-C), dados importados — estes pela autorização LOCAL vigente
 * (`datasetAiGrants`), não pelo que o quadro diz. Cada tipo usa a própria autorização (nada é reaproveitado).
 */
function financialUpstreamOf(elements: AuroraElement[], id: string): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return dataUpstream(elements, id).flatMap((u) => {
    const el = byId.get(u);
    if (el?.type !== 'widget') return [];
    if (el.widgetType === WIDGET.bankQuery) {
      const share = (el.data as { aiShare?: { confirmedDigest?: unknown; mode?: unknown } } | null)?.aiShare;
      return [`${u}:${String(share?.mode ?? '')}:${String(share?.confirmedDigest ?? '')}`];
    }
    if (el.widgetType === WIDGET.dataset) {
      const d = sanitizeDatasetData(el.data);
      const key = datasetGrantKey(el.id, d.source, d.view, d.ai.mode);
      return [`${u}:ds:${d.ai.mode}:${d.ai.mode !== 'none' && getState().datasetAiGrants.includes(key) ? key.split(':')[1] : 'pendente'}`];
    }
    return [];
  });
}

export function htmlGrantKey(elements: AuroraElement[], el: WidgetElement, d: SandboxData): string {
  const bridge = d.bridge ?? emptyBridge();
  const base = aiConfigDigest({ elementId: el.id, html: d.html, bridge, inputEdges: directInputEdges(elements, el.id), financialUpstream: financialUpstreamOf(elements, el.id) });
  return `${el.id}:${d.artifact ? digest(`${base}:${artifactConfiguration(d, artifactEdges(elements, el.id))}`) : base}`;
}

// Concessões locais nunca voltam automaticamente ao desfazer. Limpa também as saídas da revisão anterior.
useEditor.subscribe((state, prev) => {
  const { elements } = state;
  const previous = prev.elements;
  if (state.boardId !== prev.boardId || elements === previous) return;
  let after: Map<string, AuroraElement> | undefined;
  for (const old of previous) {
    if (old.type !== 'widget' || old.widgetType !== WIDGET.sandbox) continue;
    after ??= new Map(elements.map((el) => [el.id, el]));
    const el = after.get(old.id);
    const current = el?.type === 'widget' && el.widgetType === WIDGET.sandbox ? el.data as SandboxData : null;
    const prior = old.data as SandboxData;
    if (!current?.artifact && !prior?.artifact) continue;
    const beforeEdges = artifactEdges(previous, old.id);
    const afterEdges = artifactEdges(elements, old.id);
    if (current && beforeEdges === afterEdges && (current === prior || artifactConfiguration(sanitizeSandbox(current), afterEdges) === artifactConfiguration(sanitizeSandbox(prior), beforeEdges))) continue;
    clearOutputs(old.id);
    if (state.htmlAiGrants.some((key) => key.startsWith(`${old.id}:`))) void revokeHtmlAI(old.id).catch(() => toast('Autorizações de IA atualizadas apenas nesta sessão.', 'warning'));
    if (state.htmlNetGrants.some((grant) => grant.elementId === old.id && grant.boardId === state.boardId)) void revokeNetAccess(old.id).catch(() => toast('Autorizações de rede atualizadas apenas nesta sessão.', 'warning'));
  }
});

/** Política de IA do bloco HTML: só saídas escolhidas, com autorização LOCAL válida para a configuração atual. */
export function htmlAIPolicy(d: SandboxData, el: WidgetElement): { allowed: boolean; text: string; reason?: string } {
  const b = d.bridge;
  if (!b || b.ai.mode === 'none' || !b.ai.outputs.length) return { allowed: false, text: '', reason: 'Bloco HTML: nenhuma saída escolhida para a IA (HTML, estado e entradas nunca são enviados).' };
  const st = getState();
  if (!st.htmlAiGrants.includes(htmlGrantKey(st.elements, el, d))) return { allowed: false, text: '', reason: 'Bloco HTML: autorização para IA pendente ou desatualizada (confirme no painel do bloco).' };
  const values = outputsOf(el.id, b.outputs);
  if (!b.ai.outputs.some((id) => Object.prototype.hasOwnProperty.call(values, id))) return { allowed: false, text: '', reason: 'Bloco HTML: nenhuma saída publicada ainda (o bloco precisa estar em execução).' };
  const text = buildHtmlAIText(el.title, b, values);
  return text ? { allowed: true, text } : { allowed: false, text: '', reason: 'Bloco HTML: nada a enviar.' };
}

const PORT_TYPE_OPTIONS = (types: readonly string[]) => types.map((t) => <option key={t} value={t}>{BRIDGE_TYPE_LABELS[t] ?? t} ({t})</option>);

function nextPortId(ports: BridgePort[], base: string) {
  let n = ports.length + 1;
  while (ports.some((p) => p.id === `${base}${n}`)) n++;
  return `${base}${n}`;
}

function PortEditor({ kind, ports, onChange, status }: { kind: 'inputs' | 'outputs'; ports: BridgePort[]; onChange: (p: BridgePort[]) => void; status: (p: BridgePort) => ReactNode }) {
  const types = kind === 'inputs' ? BRIDGE_INPUT_TYPES : BRIDGE_OUTPUT_TYPES;
  const set = (i: number, patch: Partial<BridgePort>) => onChange(ports.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-1.5" data-testid={`bridge-${kind}`}>
      {ports.map((p, i) => (
        <div key={i} className="rounded-md border border-line/60 p-1.5 flex flex-col gap-1" data-testid={`bridge-${kind}-row`}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-1">
            <PortIdField value={p.id} taken={ports.filter((_, j) => j !== i).map((x) => x.id)} onCommit={(id) => set(i, { id })} label={`Nome da ${kind === 'inputs' ? 'entrada' : 'saída'} ${i + 1}`} />
            <Field aria-label={`Rótulo da ${kind === 'inputs' ? 'entrada' : 'saída'} ${i + 1}`} value={p.label} maxLength={60} onChange={(e) => set(i, { label: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Select aria-label={`Tipo da ${kind === 'inputs' ? 'entrada' : 'saída'} ${i + 1}`} value={p.type} onChange={(e) => set(i, { type: e.target.value })} className="flex-1 min-w-[8rem]">{PORT_TYPE_OPTIONS(types)}</Select>
            <Button aria-label={`Remover ${kind === 'inputs' ? 'entrada' : 'saída'} ${p.id}`} onClick={() => onChange(ports.filter((_, j) => j !== i))}>Remover</Button>
          </div>
          <div className="text-[10px]">{status(p)}</div>
        </div>
      ))}
      {ports.length < BRIDGE_LIMITS.maxPorts && (
        <Button data-testid={`bridge-add-${kind}`} onClick={() => onChange([...ports, { id: nextPortId(ports, kind === 'inputs' ? 'entrada' : 'saida'), label: kind === 'inputs' ? 'Entrada' : 'Saída', type: kind === 'inputs' ? 'any' : 'number' }])}>+ {kind === 'inputs' ? 'Entrada' : 'Saída'}</Button>
      )}
    </div>
  );
}

function PortIdField({ value, taken, onCommit, label }: { value: string; taken: string[]; onCommit: (id: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isValidPortId(draft) && !taken.includes(draft);
  return (
    <div className="min-w-0">
      <Field aria-label={label} value={draft} maxLength={32} spellCheck={false} className="font-mono" onChange={(e) => setDraft(e.target.value)} onBlur={() => (valid ? onCommit(draft) : setDraft(value))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {!valid && <div className="text-[10px] text-warn">Use letras, números e _ (começando por letra), sem repetir.</div>}
    </div>
  );
}

function useOutputs(elementId: string) {
  useSyncExternalStore(subscribeOutputs, outputsVersion);
  return outputEntry(elementId);
}

function SandboxInspector({ element, data, update, api }: WidgetProps<SandboxData>) {
  const flow = useDataflow();
  const elements = useEditor((s) => s.elements);
  const grants = useEditor((s) => s.htmlAiGrants);
  const entry = useOutputs(element.id);
  const b = data.bridge;
  // H2-C: limpa o estado gravado e a marca de dados protegidos (o painel também esquece a memória da execução).
  const clearState = () => update((d) => { const { stateTaint: _drop, ...rest } = d; void _drop; return { ...rest, state: null }; });
  const setBridge = (patch: Partial<BridgeConfig>) => {
    const bridge = sanitizeBridge({ ...(data.bridge ?? emptyBridge()), ...patch });
    if (data.artifact && (patch.inputs || patch.outputs)) {
      const ports = artifactPorts(bridge);
      if (JSON.stringify(ports) === JSON.stringify(artifactPorts(data.bridge))) return;
      const next = reviseArtifact(data, data.html, ports, 'manual', false);
      const impact = artifactConnectionImpact(api.getElements(), element, next);
      if (impact) { api.toast(impact, 'error'); return; }
      update(next);
    } else update((d) => ({ ...d, bridge }));
  };
  const ins = flow.inputs.get(element.id) ?? {};
  // Conexões de dados que chegam a esta entrada (inclusive as inválidas: porta inexistente, tipo errado, ciclo).
  const edgeStatus = (port: string) => elements.flatMap((x) => {
    if (!isLinear(x) || x.connection.kind !== 'data' || x.endBinding?.elementId !== element.id) return [];
    const r = flow.edges.get(x.id);
    if (!r || (x.connection.targetPort ? x.connection.targetPort !== port : r.toPort?.id !== port)) return [];
    return [r];
  });
  const key = useMemo(() => htmlGrantKey(elements, element, data), [elements, element, data]);
  const authorized = !!b && b.ai.mode === 'outputs' && grants.includes(key);
  const taint = useMemo(() => financialTaint(elements, element.id), [elements, element.id]);
  const finUp = useMemo(() => financialUpstreamOf(elements, element.id).length > 0, [elements, element.id]);
  const preview = b ? buildHtmlAIText(element.title, b, outputsOf(element.id, b.outputs)) : '';
  void entry;

  if (!b) {
    return (
      <div className="flex flex-col gap-1.5 text-[12px]" data-testid="bridge-inspector">
        <Label>Ponte de dados</Label>
        <div className="text-[11px] text-soft">Este bloco só guarda o próprio estado (<code>aurora.setState</code>). Ative a ponte para receber dados de conexões e publicar saídas tipadas para fórmulas, gráficos e IA.</div>
        <Button data-testid="bridge-enable" onClick={() => setBridge({})}>Ativar entradas e saídas</Button>
        <NetAccessPanel element={element} data={data} onClearState={clearState} />
        <Examples data={data} update={update} api={api} element={element} />
      </div>
    );
  }
  const revoke = async () => { setBridge({ ai: { ...b.ai, confirmedDigest: '', confirmedAt: 0 } }); await revokeHtmlAI(element.id); };
  return (
    <div className="flex flex-col gap-1 text-[12px]" data-testid="bridge-inspector">
      <Label>Entradas (do quadro → HTML)</Label>
      <PortEditor kind="inputs" ports={b.inputs} onChange={(inputs) => setBridge({ inputs })} status={(p) => {
        const n = ins[p.id]?.length ?? 0;
        const bad = edgeStatus(p.id).find((e) => e.status !== 'ok');
        if (bad) return <span className="text-warn" data-testid="bridge-port-error">{bad.message}</span>;
        return n ? <span className="text-ok">{n} conexão(ões)</span> : <Badge tone="warn">sem conexão</Badge>;
      }} />
      <Label>Saídas (HTML → quadro)</Label>
      <PortEditor kind="outputs" ports={b.outputs} onChange={(outputs) => setBridge({ outputs, ai: { ...b.ai, outputs: b.ai.outputs.filter((id) => outputs.some((o) => o.id === id)) } })} status={(p) => {
        const err = entry?.errors[p.id];
        if (err) return <span className="text-warn" data-testid="bridge-port-error">Recusado: {err}</span>;
        const json = entry?.json[p.id];
        return json ? <span className="text-ok">publicado ({json.length.toLocaleString('pt-BR')} bytes){entry?.stale ? ' · desatualizado (bloco fora de execução)' : ''}</span> : <span className="text-soft">nada publicado ainda</span>;
      }} />
      <div className="text-[10px] text-soft mt-1" data-testid="bridge-debug">
        Mensagens aceitas: {entry?.published ?? 0} · recusadas: {entry?.rejected ?? 0}. Valores de entrada e saída ficam só na memória: não vão para o quadro, o histórico ou o backup, nem para o console.
      </div>
      {finUp && <div className="text-[11px] text-warn mt-1" data-testid="bridge-financial">Este bloco recebe dados bancários (Consulta bancária). Não copie entradas para <code>aurora.setState</code>: o estado é gravado no quadro.</div>}

      <Label>Análise por IA</Label>
      <div className="rounded-lg border border-line/60 p-2 bg-[#0f1826] flex flex-col gap-1.5" data-testid="bridge-ai">
        <Segmented label="Envio deste bloco à IA" value={b.ai.mode} onChange={(mode) => { setBridge({ ai: { ...b.ai, mode, confirmedDigest: '', confirmedAt: 0 } }); void revokeHtmlAI(element.id); }} options={[{ value: 'none', label: 'Nada' }, { value: 'outputs', label: 'Saídas escolhidas' }]} />
        {b.ai.mode === 'outputs' && (
          <>
            {!b.outputs.length && <div className="text-[11px] text-soft">Declare saídas acima para escolher o que vai à IA.</div>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-2 gap-y-0.5 text-[11px]">
              {b.outputs.map((o) => (
                <label key={o.id} className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent-2" checked={b.ai.outputs.includes(o.id)} onChange={(e) => { setBridge({ ai: { ...b.ai, outputs: e.target.checked ? [...b.ai.outputs, o.id] : b.ai.outputs.filter((x) => x !== o.id), confirmedDigest: '', confirmedAt: 0 } }); void revokeHtmlAI(element.id); }} /> {o.label}</label>
              ))}
            </div>
            <div className="text-[10px] text-muted">Exatamente isto será enviado ao provedor de IA (valores atuais; o HTML, o estado e as entradas não vão):</div>
            <pre data-testid="bridge-ai-preview" className="max-h-40 overflow-auto text-[10px] whitespace-pre-wrap break-words text-muted bg-[#0a111c] p-1.5 rounded" data-scrollable>{preview || '(nada — escolha saídas publicadas)'}</pre>
            {taint ? (
              <div className="text-[11px] text-warn" data-testid="bridge-ai-status">{taint} Autorize a consulta bancária primeiro.</div>
            ) : authorized ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="text-ok min-w-0" data-testid="bridge-ai-status">✓ Autorizado neste navegador{b.ai.confirmedAt ? ` em ${new Date(b.ai.confirmedAt).toLocaleString('pt-BR')}` : ''}</span>
                <Button onClick={() => void revoke()}>Revogar</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {b.ai.confirmedDigest && <div className="text-[11px] text-warn" data-testid="bridge-ai-status">A configuração ou as conexões mudaram (ou a autorização veio de outro navegador): confirme de novo.</div>}
                <Button variant="primary" data-testid="bridge-ai-authorize" disabled={!preview} onClick={async () => {
                  const ok = await api.confirm('Autorizar saídas do bloco HTML para IA', `As saídas escolhidas (${b.ai.outputs.length}), como na prévia (${preview.length} caracteres agora), poderão ser enviadas ao provedor de IA quando um Assistente IA conectado a este bloco for usado.${finUp ? ' Elas derivam de dados bancários.' : ''} Mudar o HTML, as saídas ou as conexões revoga. Nada é enviado agora.`, 'Autorizar');
                  if (!ok) return;
                  const cur = getState().elements.find((x) => x.id === element.id);
                  if (!cur || cur.type !== 'widget') return;
                  const d = sanitizeSandbox(cur.data);
                  const k = htmlGrantKey(getState().elements, cur, d);
                  await grantHtmlAI(k);
                  setBridge({ ai: { ...b.ai, confirmedDigest: k.split(':')[1], confirmedAt: Date.now() } });
                }}>Autorizar estas saídas para IA</Button>
              </div>
            )}
          </>
        )}
        {b.ai.mode === 'none' && <div className="text-[11px] text-soft" data-testid="bridge-ai-status">Nada deste bloco é enviado à IA, mesmo conectado a um Assistente.</div>}
      </div>
      <NetAccessPanel element={element} data={data} onClearState={clearState} />
      <Examples data={data} update={update} api={api} element={element} />
    </div>
  );
}

function Examples({ data, update, api, element }: Pick<WidgetProps<SandboxData>, 'data' | 'update' | 'api' | 'element'>) {
  const [pick, setPick] = useState('');
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="bridge-examples">
      <Label>Exemplos editáveis</Label>
      <div className="flex flex-wrap gap-1">
        <Select aria-label="Exemplo de HTML" value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 min-w-[9rem]">
          <option value="">Escolha um exemplo…</option>
          {BRIDGE_EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        <Button disabled={!pick} data-testid="bridge-use-example" onClick={async () => {
          const ex = BRIDGE_EXAMPLES.find((x) => x.id === pick);
          if (!ex) return;
          if (data.html.trim() && data.html !== ex.html && !(await api.confirm('Usar exemplo', 'O HTML atual deste bloco será substituído pelo exemplo (desfazer com Ctrl+Z).', data.artifact ? 'Salvar pausado' : 'Substituir'))) return;
          const current = api.getElement(element.id);
          if (current?.type !== 'widget' || current.data !== element.data || current.locked) { api.toast('O painel mudou. Selecione o exemplo de novo.', 'warning'); return; }
          if (data.artifact) {
            const next = reviseArtifact(data, ex.html, artifactPorts(ex.bridge), 'example', false);
            const impact = artifactConnectionImpact(api.getElements(), current, next);
            if (impact) { api.toast(impact, 'error'); return; }
            update(next);
          } else update({ html: ex.html, activation: undefined, bridge: sanitizeBridge(ex.bridge) });
        }}>Usar</Button>
      </div>
      <div className="text-[10px] text-soft">API: <code>aurora.inputs</code>, <code>aurora.onInputs(cb)</code>, <code>aurora.publish(porta, valor)</code>, <code>aurora.setState(obj)</code>. Ver docs/HTML_DATA_BRIDGE.md.</div>
    </div>
  );
}
