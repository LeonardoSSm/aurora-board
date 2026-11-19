import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { Box } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeSandbox, type SandboxData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';

/**
 * Host de widgets isolados. O conteúdo roda em <iframe sandbox="allow-scripts"> SEM allow-same-origin:
 * não acessa cookies, IndexedDB, DOM do app nem a rede com credenciais do app.
 * Comunicação apenas por postMessage, com mensagens validadas e limite de tamanho.
 *
 * Protocolo:
 *   app → iframe: { type: 'aurora:init', state }
 *   iframe → app: { type: 'aurora:setState', state }   (JSON, até 100 KB)
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
  if (Object.keys(data as object).some((k) => k !== 'type' && k !== 'state')) return { ok: false, error: 'Mensagem com campos inesperados ignorada.' };
  try {
    const json = JSON.stringify((data as { state?: unknown }).state ?? null);
    if (json === undefined) return { ok: false, error: 'Estado inválido recebido do widget.' };
    if (json.length > MAX_STATE) return { ok: false, error: 'Estado excede 100 KB e foi ignorado.' };
    return { ok: true, state: JSON.parse(json) };
  } catch {
    return { ok: false, error: 'Estado inválido recebido do widget.' };
  }
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

export function SandboxFrame({ html, state, onState, title }: { html: string; state: unknown; onState: (s: unknown) => void; title: string }) {
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
  // useLayoutEffect: o listener existe antes de o iframe (inserido neste mesmo commit) conseguir postar a
  // primeira mensagem — com useEffect, o WebKit às vezes entregava o primeiro setState antes do registro.
  useLayoutEffect(() => {
    const deliver = createThrottle<unknown>((st) => { if (!navigatedRef.current) onStateRef.current(st); });
    const onMessage = (e: MessageEvent) => {
      // Só aceita mensagens do PRÓPRIO iframe (identidade da janela; a origem do srcdoc é opaca)
      // e nunca depois de o frame ter navegado para outro documento.
      if (!ref.current || e.source !== ref.current.contentWindow || navigatedRef.current) return;
      const r = parseSandboxMessage(e.data);
      if (!r) return;
      if (r.ok) deliver(r.state);
      else setError(r.error);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
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
          ref.current?.contentWindow?.postMessage({ type: 'aurora:load', html: htmlRef.current, state: stateRef.current }, '*');
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
  statusNote: 'Isolado por iframe sandbox + CSP. Sem rede, sem acesso aos dados do quadro.',
  accent: '#9cb1cf',
  permissions: ['sandbox:scripts'],
  defaultSize: { width: 360, height: 300 },
  inputs: [],
  outputs: [{ id: 'state', label: 'Estado', type: 'any' }],
  createData: () => ({ html: EXAMPLE, state: null }),
  sanitize: sanitizeSandbox,
  compute: (d) => ({ state: d.state }),
  summarize: (d) => `Widget HTML isolado. Estado: ${JSON.stringify(d.state).slice(0, 500)}`,
  Component: function Sandbox({ data, update, element, selected, api }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(data.html);
    const [showCode, setShowCode] = useState(false);
    const blocked = data.activation?.state === 'blocked';
    const tooBig = data.html.length > MAX_HTML_CHARS;
    const slot = useFrameSlot(`${element.id}:${useId()}`, !editing && !blocked && !SAFE_MODE && !tooBig);
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
      body = <SandboxFrame key={data.html} html={data.html} state={data.state} title={element.title} onState={(state) => update({ state }, { coalesce: true })} />;
    }
    return (
      <div className="flex flex-col gap-1.5 h-full">
        {body}
        {!editing && selected && <button className="self-start h-6 px-2 text-[11px] text-muted hover:text-fg" onClick={() => { setDraft(data.html); setEditing(true); }}>Editar HTML</button>}
      </div>
    );
  },
};
