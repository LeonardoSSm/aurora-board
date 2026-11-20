/**
 * Captura rápida (issue #14, N1-C): Ctrl+Shift+Espaço ou o botão na barra superior. Nota ou Tarefa, título,
 * detalhes opcionais e destino (quadro atual ou o Inbox da workspace). Enter grava; a tela não muda.
 */
import { useEffect, useRef, useState } from 'react';
import { Inbox, X } from 'lucide-react';
import { useEditor, getState, setState } from '../store/editor';
import { CAPTURE_LIMITS, capture, getInboxBoardId, setInboxBoardId, type CaptureKind } from '../store/quickCapture';
import { toast } from '../store/ui';

export function QuickCapture() {
  const open = useEditor((s) => s.captureOpen);
  if (!open) return null;
  return <CaptureForm />;
}

function CaptureForm() {
  const allBoards = useEditor((s) => s.boards);
  const boards = allBoards.filter((b) => !b.archived);
  const boardId = useEditor((s) => s.boardId);
  const [kind, setKind] = useState<CaptureKind>('note');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [target, setTarget] = useState<string>('current');
  const [inbox, setInbox] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    void getInboxBoardId().then((id) => { setInbox(id); if (id && id !== getState().boardId) setTarget(id); });
    return () => { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);
  const close = () => setState({ captureOpen: false });
  const submit = async () => {
    if (busy) return;
    if (!title.trim()) { setError('Escreva um título.'); titleRef.current?.focus(); return; }
    setBusy(true);
    setError('');
    try {
      const r = await capture({ kind, title, details }, target);
      close();
      toast(`${kind === 'note' ? 'Nota' : 'Tarefa'} capturada em “${r.boardName}”. Ctrl+K → “Abrir item capturado”.`, 'success', 4500);
    } catch (e) {
      // Nada se perde: o formulário continua aberto com o texto.
      setError((e as Error).message || 'Não foi possível gravar. O texto foi mantido.');
    } finally {
      setBusy(false);
    }
  };
  const onTarget = (v: string) => {
    if (v.startsWith('inbox:')) {
      const id = v.slice(6);
      setTarget(id);
      setInbox(id);
      void setInboxBoardId(id);
      return;
    }
    setTarget(v);
  };
  return (
    <div className="fixed inset-0 z-[85] flex items-start justify-center bg-[#060a12aa] p-3 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-title"
        data-testid="quick-capture"
        className="w-full max-w-[460px] rounded-2xl border border-[#405a78] bg-[#1a293c] shadow-[0_30px_80px_#000b] p-4 flex flex-col gap-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); close(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="capture-title" className="text-[15px] font-bold flex items-center gap-1.5"><Inbox size={15} className="text-accent" /> Captura rápida</h2>
          <button type="button" aria-label="Fechar captura" className="p-1 rounded hover:bg-panel-3" onClick={close}><X size={15} /></button>
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="Tipo">
          {(['note', 'task'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`h-7 px-3 rounded-lg text-[12px] ${kind === k ? 'bg-[#2c3a6e] text-[#d8dcff] ring-1 ring-[#6b74d8]' : 'border border-line text-fg-2'}`}>{k === 'note' ? 'Nota' : 'Tarefa'}</button>
          ))}
        </div>
        <input
          ref={titleRef}
          aria-label="Título"
          maxLength={CAPTURE_LIMITS.title}
          value={title}
          onChange={(e) => { setTitle(e.target.value); setError(''); }}
          placeholder={kind === 'note' ? 'Ideia, lembrete…' : 'O que precisa ser feito?'}
          className="h-9 px-2.5 rounded-lg border border-line bg-[#0f1826] text-[13px] outline-none focus:border-accent"
        />
        <textarea aria-label="Detalhes (opcional)" maxLength={CAPTURE_LIMITS.details} rows={3} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Detalhes (opcional) — Ctrl+Enter grava" className="px-2.5 py-1.5 rounded-lg border border-line bg-[#0f1826] text-[12px] outline-none focus:border-accent resize-none" />
        <label className="text-[11px] text-muted flex items-center gap-2">Destino
          <select aria-label="Destino" value={target === boardId ? 'current' : target} onChange={(e) => onTarget(e.target.value)} className="flex-1 min-w-0 h-8 px-1.5 rounded-lg bg-[#0f1826] border border-line text-[12px] text-fg">
            <option value="current">Quadro atual</option>
            {inbox && inbox !== boardId && <option value={inbox}>Inbox: {boards.find((b) => b.id === inbox)?.name ?? '—'}</option>}
            <optgroup label="Definir Inbox desta workspace">
              {boards.filter((b) => b.id !== boardId).map((b) => <option key={b.id} value={`inbox:${b.id}`}>{b.name}</option>)}
            </optgroup>
          </select>
        </label>
        {error && <div role="alert" className="text-[12px] text-danger" data-testid="capture-error">{error}</div>}
        <div className="flex justify-between items-center mt-1">
          <span className="text-[10px] text-soft">A tela, a câmera e a seleção não mudam.</span>
          <button type="submit" disabled={busy} className="h-8 px-3.5 rounded-lg border bg-[#3174db] border-[#4288f5] text-white text-[12px] font-semibold disabled:opacity-60">Capturar</button>
        </div>
      </form>
    </div>
  );
}
