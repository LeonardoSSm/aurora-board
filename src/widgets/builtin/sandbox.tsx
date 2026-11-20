import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type React from 'react';
import { Box } from 'lucide-react';
import type { WidgetPlugin, WidgetProps } from '../registry';
import { sanitizeSandbox, type SandboxData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import { isLinear } from '../../core/schema';
import { aiConfigDigest, BRIDGE_INPUT_TYPES, BRIDGE_LIMITS, BRIDGE_OUTPUT_TYPES, BRIDGE_TYPE_LABELS, BRIDGE_VERSION, buildHtmlAIText, buildInputSnapshot, digest, emptyBridge, isValidPortId, sanitizeBridge, type BridgeConfig, type BridgePort, type InputSnapshot } from '../../core/htmlBridge';
import { dataUpstream, directInputEdges } from '../../core/dataUpstream';
import { beginGeneration, endGeneration, isCurrentToken, outputEntry, outputsOf, outputsVersion, publishOutput, randomToken, subscribeOutputs } from '../htmlOutputs';
import { useDataflow } from '../dataflow';
import { getState, useEditor } from '../../store/editor';
import { grantHtmlAI, revokeHtmlAI } from '../../store/actions';
import { financialTaint } from '../../integrations/aiContext';
import { Badge, Button, Field, Label, Segmented, Select } from '../../ui/primitives';
import { BRIDGE_EXAMPLES } from './sandboxExamples';

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

/** Limitador "a última vence": no máximo N entregas por segundo; a última pendente é entregue depois. */
export function createThrottle<T>(
  deliver: (v: T) => void,
  perSecond = MAX_UPDATES_PER_SECOND,
  now = () => Date.now(),
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
) {
  let windowStart = -Infinity, count = 0, pending: { v: T } | null = null, scheduled = false;
  const flush = () => {
    scheduled = false;
    windowStart = now();
    count = 0;
    if (pending) { const p = pending; pending = null; count = 1; deliver(p.v); }
  };
  return (v: T) => {
    const t = now();
    if (t - windowStart >= 1000) { windowStart = t; count = 0; }
    if (count < perSecond && !scheduled) { count++; deliver(v); return; }
    pending = { v };
    if (!scheduled) { scheduled = true; schedule(flush, Math.max(0, 1000 - (t - windowStart))); }
  };
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

export function SandboxFrame({ html, state, onState, title, bridge }: { html: string; state: unknown; onState: (s: unknown) => void; title: string; bridge?: FrameBridge }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const [navigated, setNavigated] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loads = useRef(0);
  const navigatedRef = useRef(false);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
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
  useLayoutEffect(() => {
    if (!elementId || !signature) return;
    const token = tokenRef.current;
    beginGeneration(elementId, token, signature);
    return () => endGeneration(elementId, token);
  }, [elementId, signature]);
  // useLayoutEffect: o listener existe antes de o iframe (inserido neste mesmo commit) conseguir postar a
  // primeira mensagem — com useEffect, o WebKit às vezes entregava o primeiro setState antes do registro.
  useLayoutEffect(() => {
    const deliver = createThrottle<unknown>((st) => { if (!navigatedRef.current) onStateRef.current(st); });
    let windowStart = 0, inWindow = 0, warned = false;
    const onMessage = (e: MessageEvent) => {
      // Só aceita mensagens do PRÓPRIO iframe (identidade da janela; a origem do srcdoc é opaca)
      // e nunca depois de o frame ter navegado para outro documento.
      if (!ref.current || e.source !== ref.current.contentWindow || navigatedRef.current) return;
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
      const r = parseSandboxMessage(e.data);
      if (!r) return;
      const tok = (e.data as { token?: unknown }).token;
      if (tok !== undefined && tok !== '' && tok !== tokenRef.current) return;
      if (r.ok) deliver(r.state);
      else setError(r.error);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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
        <button className="h-6 px-2 rounded border border-line text-[11px] hover:bg-panel-3" onClick={() => { loads.current = 0; navigatedRef.current = false; setNavigated(false); setNonce((n) => n + 1); }}>Recarregar widget</button>
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
          if (loads.current > 1) { navigatedRef.current = true; setNavigated(true); return; }
          const b = bridgeRef.current;
          loadedRef.current = true;
          if (b) sentInputs.current = b.snapshot.json;
          ref.current?.contentWindow?.postMessage({ type: 'aurora:load', html: htmlRef.current, state: stateRef.current, ...(b ? { bridge: { v: BRIDGE_VERSION, token: tokenRef.current, ports: b.ports, inputs: b.snapshot.inputs, connections: b.snapshot.connections } } : {}) }, '*');
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
  statusNote: 'Isolado por iframe sandbox + CSP. Sem rede; só recebe os dados das conexões que você ligar às entradas dele.',
  accent: '#9cb1cf',
  permissions: ['sandbox:scripts'],
  defaultSize: { width: 360, height: 300 },
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
    const blocked = data.activation?.state === 'blocked';
    const tooBig = data.html.length > MAX_HTML_CHARS;
    const slot = useFrameSlot(`${element.id}:${useId()}`, !editing && !blocked && !SAFE_MODE && !tooBig);
    const signature = useMemo(() => bridgeSignature(data), [data]);
    const bridgeInputs = data.bridge?.inputs;
    const snapshot = useMemo(() => (bridgeInputs ? buildInputSnapshot(bridgeInputs, inputs) : null), [bridgeInputs, inputs]);
    const frameBridge = useMemo<FrameBridge | undefined>(() => (data.bridge && snapshot ? { elementId: element.id, signature, ports: { inputs: data.bridge.inputs, outputs: data.bridge.outputs }, snapshot } : undefined), [data.bridge, snapshot, element.id, signature]);
    const activate = async () => {
      const ok = await api.confirm(
        'Ativar HTML personalizado',
        `Este widget veio de ${data.activation?.source === 'paste' ? 'conteúdo colado' : 'um arquivo importado'} e contém ${data.html.length.toLocaleString('pt-BR')} caracteres de HTML/JavaScript de terceiros. Ele roda isolado (sem acesso aos seus quadros, ao armazenamento ou à rede), mas pode exibir conteúdo enganoso. Ative apenas se você confia na origem do arquivo.`,
        'Ativar este widget',
      );
      if (ok) update({ activation: { state: 'allowed', source: data.activation?.source ?? 'import', at: Date.now() } });
    };
    let body: React.ReactNode;
    if (editing) {
      body = (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="flex-1 min-h-[120px] p-2 rounded-md bg-[#0a111c] border border-line font-mono text-[11px] resize-none" />
          <div className="flex justify-end gap-1.5">
            <button className="h-7 px-2 text-[11px] text-muted" onClick={() => { setDraft(data.html); setEditing(false); }}>Cancelar</button>
            {/* Aplicar uma edição é autoria do próprio usuário: o HTML passa a ser local (ativo). */}
            <button className="h-7 px-3 rounded-md bg-[#3174db] text-white text-[11px]" onClick={() => { update({ html: draft, activation: undefined }); setEditing(false); }}>Aplicar</button>
          </div>
        </>
      );
    } else if (SAFE_MODE) {
      body = <SandboxNotice testId="sandbox-safe-mode" title="Modo seguro">HTML personalizado desligado nesta sessão (endereço com <code>?safe</code>). Recarregue sem o parâmetro para executar.</SandboxNotice>;
    } else if (blocked) {
      body = (
        <SandboxNotice testId="sandbox-inactive" title="HTML personalizado desativado">
          <span>Veio de {data.activation?.source === 'paste' ? 'conteúdo colado' : 'um arquivo importado'} e não é executado até você ativá-lo. {data.html.length.toLocaleString('pt-BR')} caracteres.</span>
          <div className="flex gap-1.5">
            <button className="h-6 px-2 rounded border border-line hover:bg-panel-3" onClick={() => setShowCode((v) => !v)}>{showCode ? 'Ocultar código' : 'Ver código'}</button>
            <button data-testid="sandbox-activate" className="h-6 px-2 rounded border border-warn/60 text-warn hover:bg-warn/10" onClick={() => void activate()}>Ativar…</button>
          </div>
          {showCode && <pre className="font-mono text-[10px] whitespace-pre-wrap break-all max-h-40 overflow-auto bg-[#060b13] p-1.5 rounded">{data.html.slice(0, 20_000)}</pre>}
        </SandboxNotice>
      );
    } else if (tooBig) {
      body = <SandboxNotice testId="sandbox-too-big" title="HTML grande demais">O HTML tem mais de {MAX_HTML_CHARS.toLocaleString('pt-BR')} caracteres e não é executado.</SandboxNotice>;
    } else if (!slot) {
      body = <SandboxNotice testId="sandbox-paused" title="Pausado">Há {MAX_ACTIVE_FRAMES} widgets HTML em execução. Este começa quando outro for fechado.</SandboxNotice>;
    } else {
      body = <SandboxFrame key={signature} html={data.html} state={data.state} title={element.title} onState={(state) => update({ state }, { coalesce: true })} bridge={frameBridge} />;
    }
    return (
      <div className="flex flex-col gap-1.5 h-full">
        {body}
        {!editing && selected && <button className="self-start h-6 px-2 text-[11px] text-muted hover:text-fg" onClick={() => { setDraft(data.html); setEditing(true); }}>Editar HTML</button>}
      </div>
    );
  },
};

/* ------------------------------------------------------------------ HTML Data Bridge (issue #11) */

/** Assinatura das portas+HTML: muda quando a definição muda (o iframe recomeça e as saídas antigas caem). */
function bridgeSignature(d: SandboxData): string {
  return digest(JSON.stringify([d.html.length, digest(d.html), d.bridge ? [d.bridge.inputs, d.bridge.outputs] : null]));
}

/** Consultas bancárias a montante, com o resumo da autorização de cada uma (troca de autorização revoga). */
function financialUpstreamOf(elements: AuroraElement[], id: string): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return dataUpstream(elements, id).flatMap((u) => {
    const el = byId.get(u);
    if (el?.type !== 'widget' || el.widgetType !== WIDGET.bankQuery) return [];
    const share = (el.data as { aiShare?: { confirmedDigest?: unknown; mode?: unknown } } | null)?.aiShare;
    return [`${u}:${String(share?.mode ?? '')}:${String(share?.confirmedDigest ?? '')}`];
  });
}

export function htmlGrantKey(elements: AuroraElement[], el: WidgetElement, d: SandboxData): string {
  const bridge = d.bridge ?? emptyBridge();
  return `${el.id}:${aiConfigDigest({ elementId: el.id, html: d.html, bridge, inputEdges: directInputEdges(elements, el.id), financialUpstream: financialUpstreamOf(elements, el.id) })}`;
}

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
  const setBridge = (patch: Partial<BridgeConfig>) => update((d) => ({ ...d, bridge: sanitizeBridge({ ...(d.bridge ?? emptyBridge()), ...patch }) }));
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
        <Examples data={data} update={update} api={api} />
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
      <Examples data={data} update={update} api={api} />
    </div>
  );
}

function Examples({ data, update, api }: Pick<WidgetProps<SandboxData>, 'data' | 'update' | 'api'>) {
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
          if (data.html.trim() && data.html !== ex.html && !(await api.confirm('Usar exemplo', 'O HTML atual deste bloco será substituído pelo exemplo (desfazer com Ctrl+Z).', 'Substituir'))) return;
          update({ html: ex.html, activation: undefined, bridge: sanitizeBridge(ex.bridge) });
        }}>Usar</Button>
      </div>
      <div className="text-[10px] text-soft">API: <code>aurora.inputs</code>, <code>aurora.onInputs(cb)</code>, <code>aurora.publish(porta, valor)</code>, <code>aurora.setState(obj)</code>. Ver docs/HTML_DATA_BRIDGE.md.</div>
    </div>
  );
}
