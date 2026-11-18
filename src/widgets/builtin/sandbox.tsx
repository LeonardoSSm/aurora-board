import { useEffect, useRef, useState } from 'react';
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

export function SandboxFrame({ html, state, onState, title }: { html: string; state: unknown; onState: (s: unknown) => void; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const msg = e.data as { type?: string; state?: unknown };
      if (msg?.type !== 'aurora:setState') return;
      try {
        const json = JSON.stringify(msg.state ?? null);
        if (json.length > MAX_STATE) { setError('Estado excede 100 KB e foi ignorado.'); return; }
        onState(JSON.parse(json));
      } catch {
        setError('Estado inválido recebido do widget.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onState]);
  const bridge = `<script>window.aurora={setState:function(s){parent.postMessage({type:'aurora:setState',state:s},'*')},state:null};window.addEventListener('message',function(e){if(e.data&&e.data.type==='aurora:init'){window.aurora.state=e.data.state;window.dispatchEvent(new CustomEvent('aurora:init',{detail:e.data.state}))}});</script>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;"><style>body{margin:0;font:13px system-ui;color:#e6ecf6;background:transparent}</style>${bridge}</head><body>${html}</body></html>`;
  return (
    <div className="flex flex-col h-full gap-1">
      <iframe
        ref={ref}
        title={title}
        sandbox="allow-scripts"
        srcDoc={doc}
        className="flex-1 w-full rounded-md border border-line/60 bg-[#0a111c]"
        onLoad={() => ref.current?.contentWindow?.postMessage({ type: 'aurora:init', state }, '*')}
      />
      {error && <div className="text-[11px] text-warn">{error}</div>}
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
  Component: function Sandbox({ data, update, element, selected }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(data.html);
    return (
      <div className="flex flex-col gap-1.5 h-full">
        {editing ? (
          <>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="flex-1 min-h-[120px] p-2 rounded-md bg-[#0a111c] border border-line font-mono text-[11px] resize-none" />
            <div className="flex justify-end gap-1.5">
              <button className="h-7 px-2 text-[11px] text-muted" onClick={() => { setDraft(data.html); setEditing(false); }}>Cancelar</button>
              <button className="h-7 px-3 rounded-md bg-[#3174db] text-white text-[11px]" onClick={() => { update({ html: draft }); setEditing(false); }}>Aplicar</button>
            </div>
          </>
        ) : (
          <>
            <SandboxFrame key={data.html} html={data.html} state={data.state} title={element.title} onState={(state) => update({ state }, { coalesce: true })} />
            {selected && <button className="self-start h-6 px-2 text-[11px] text-muted hover:text-fg" onClick={() => { setDraft(data.html); setEditing(true); }}>Editar HTML</button>}
          </>
        )}
      </div>
    );
  },
};
