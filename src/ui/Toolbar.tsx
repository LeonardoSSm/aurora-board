import { Lock, LockOpen } from 'lucide-react';
import { useEditor, setState } from '../store/editor';
import { setConnectionKind, setTool } from '../store/actions';
import type { LinkKind } from '../core/schema';
import { TOOLS } from './tools';
import { HintBar } from './HintBar';

const KINDS: { id: LinkKind; label: string; hint: string; color: string }[] = [
  { id: 'visual', label: 'Visual', hint: 'Apenas relacionamento/documentação', color: '#8fa6c8' },
  { id: 'context', label: 'Contexto', hint: 'Fornece informação (ex.: para a IA), mediante autorização', color: '#c0a0ff' },
  { id: 'data', label: 'Dados', hint: 'Transmite valores tipados entre widgets compatíveis', color: '#5addaa' },
  { id: 'execution', label: 'Execução', hint: 'Uma ação pode acionar outra — sempre com confirmação', color: '#f3a35c' },
];

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const locked = useEditor((s) => s.toolLocked);
  const kind = useEditor((s) => s.connectionKind);
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 max-w-[calc(100%-24px)] pointer-events-none">
      <div className="glass rounded-xl p-1 flex items-center gap-0.5 overflow-x-auto max-w-full pointer-events-auto" role="toolbar" aria-label="Ferramentas">
        <button
          className={`grid place-items-center w-9 h-9 rounded-lg ${locked ? 'text-accent bg-panel-3' : 'text-muted hover:bg-panel-3'}`}
          aria-pressed={locked}
          title={`Manter ferramenta ativa após desenhar (Q) — ${locked ? 'ligado' : 'desligado'}`}
          aria-label="Manter ferramenta ativa"
          onClick={() => setState({ toolLocked: !locked })}
        >
          {locked ? <Lock size={15} /> : <LockOpen size={15} />}
        </button>
        <div className="w-px h-6 bg-line mx-0.5" />
        {TOOLS.map((t, i) => (
          <span key={t.id} className="contents">
            {(i === 2 || i === 9 || i === 13) && <div className="w-px h-6 bg-line mx-0.5" />}
            <button
              data-tool-button={t.id}
              className={`relative grid place-items-center w-9 h-9 rounded-lg transition-colors ${tool === t.id ? 'bg-[#2c3a6e] text-[#d8dcff] ring-1 ring-[#6b74d8]' : 'text-fg-2 hover:bg-panel-3'}`}
              title={`${t.label} — ${t.keys.join(' ou ')}`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              <t.icon size={17} strokeWidth={1.8} />
              <span className="absolute right-0.5 bottom-0 text-[8px] text-soft font-semibold">{t.keys[1] ?? t.keys[0]}</span>
            </button>
          </span>
        ))}
      </div>
      {tool === 'connect' && (
        <div className="glass rounded-lg p-1 flex items-center gap-1 text-[11px] pointer-events-auto" role="radiogroup" aria-label="Tipo de conexão">
          <span className="px-1.5 text-muted">Tipo:</span>
          {KINDS.map((k) => (
            <button
              key={k.id}
              role="radio"
              aria-checked={kind === k.id}
              title={k.hint}
              onClick={() => setConnectionKind(k.id)}
              className={`h-7 px-2 rounded-md border ${kind === k.id ? 'bg-panel-3' : 'border-transparent text-muted hover:text-fg'}`}
              style={kind === k.id ? { borderColor: k.color, color: k.color } : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <HintBar />
    </div>
  );
}

export { KINDS as CONNECTION_KINDS };
