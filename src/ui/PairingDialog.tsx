/**
 * Pareamento de computadores da rede local (IA e prévia de links usando o servidor do computador principal).
 * - No computador principal: gerar código de uso único, ver e revogar dispositivos.
 * - No outro computador: digitar o código; o token fica só nele e pode ser revogado no principal.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { apiFetch, deviceToken, postJSON, setDeviceToken } from '../integrations/apiFetch';
import { fetchAIStatus } from '../integrations/aiClient';
import { confirmDialog, toast } from '../store/ui';

const usePairingUI = create<{ open: boolean }>(() => ({ open: false }));
export const openPairing = () => usePairingUI.setState({ open: true });
const close = () => usePairingUI.setState({ open: false });

interface Device { id: string; name: string; createdAt: number; lastSeenAt: number; lastAddress?: string }
type Mode = { kind: 'loading' } | { kind: 'manager'; devices: Device[]; pending: { expiresAt: number } | null } | { kind: 'remote'; paired: { name: string } | null } | { kind: 'error'; message: string };

const btn = 'h-8 px-3 rounded-lg border border-line bg-panel-3 hover:bg-[#28405d] text-[12px] font-semibold text-fg-2 disabled:opacity-40';
const primary = 'h-8 px-3 rounded-lg bg-[#3174db] hover:bg-[#3b82f0] text-white text-[12px] font-semibold disabled:opacity-40';
const input = 'h-8 px-2 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[13px]';
const when = (t: number) => new Date(t).toLocaleString('pt-BR');

async function load(): Promise<Mode> {
  try {
    const r = await apiFetch('/api/pairing/devices');
    if (r.ok) { const b = await r.json(); return { kind: 'manager', devices: b.devices, pending: b.pending }; }
    if (r.status === 401 || r.status === 403) {
      // Outro computador: pareado (token válido) ou não.
      const s = await apiFetch('/api/pairing/status');
      if (s.ok) { const b = await s.json(); return { kind: 'remote', paired: b.device ?? { name: 'este computador' } }; }
      return { kind: 'remote', paired: null };
    }
    return { kind: 'error', message: `O servidor local respondeu ${r.status}. Rode "npm run dev" no computador principal.` };
  } catch {
    return { kind: 'error', message: 'Servidor local indisponível.' };
  }
}

export function PairingDialog() {
  const open = usePairingUI((s) => s.open);
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('Meu outro PC');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refresh = async () => setMode(await load());
  useEffect(() => { if (open) { setCode(null); setTyped(''); void refresh(); } }, [open]);
  useEffect(() => { if (!code) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [code]);
  if (!open) return null;

  const generate = async () => {
    setBusy(true);
    try {
      const r = await postJSON('/api/pairing/code', {});
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erro ${r.status}`);
      setCode(await r.json());
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const revoke = async (d: Device) => {
    if (!(await confirmDialog('Revogar dispositivo', `“${d.name}” perde o acesso à IA e à prévia de links deste computador imediatamente.`, 'Revogar', true))) return;
    const r = await postJSON('/api/pairing/revoke', { id: d.id });
    if (r.ok) { toast('Dispositivo revogado.', 'success'); void refresh(); } else toast('Não foi possível revogar.', 'error');
  };
  const claim = async () => {
    setBusy(true);
    try {
      const r = await postJSON('/api/pairing/claim', { code: typed, name });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? `Erro ${r.status}`);
      setDeviceToken(b.token);
      await fetchAIStatus(true);
      toast('Computador pareado. Recarregue os blocos de IA se necessário.', 'success');
      void refresh();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const unpair = async () => {
    if (!(await confirmDialog('Desparear este computador', 'O token deste computador será apagado daqui. Para cortar o acesso de vez, revogue também no computador principal.', 'Desparear', true))) return;
    setDeviceToken(null);
    await fetchAIStatus(true);
    void refresh();
  };
  const secondsLeft = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  const lanUrl = typeof location !== 'undefined' && !/^(localhost|127\.|\[::1\])/.test(location.hostname) ? `${location.protocol}//${location.hostname}:5174` : 'http://<IP deste computador>:5174';

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-[#060a12bb] p-4" role="dialog" aria-modal="true" aria-label="Parear computadores" data-testid="pairing-dialog" onPointerDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
      <div className="w-full max-w-lg rounded-2xl border border-line bg-panel p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold">Parear computadores da sua rede</h2>
          <button aria-label="Fechar" className="p-1 rounded hover:bg-panel-3 text-muted" onClick={close}><X size={16} /></button>
        </div>
        {mode.kind === 'loading' && <div className="text-[12px] text-muted">Verificando…</div>}
        {mode.kind === 'error' && <div className="text-[12px] text-danger">{mode.message}</div>}

        {mode.kind === 'manager' && (
          <>
            <p className="text-[12px] text-muted">Outro computador seu, na mesma rede, pode usar a IA e a prévia de links com as chaves <b>deste</b> computador. Só funciona com o servidor de rede iniciado com <code>AURORA_LAN_PAIRING=1</code> e só para computadores pareados com um código gerado aqui.</p>
            {code ? (
              <div className="rounded-xl border border-accent/50 bg-[#0f1826] p-3 text-center" data-testid="pairing-code-box">
                <div className="text-[11px] text-muted">No outro computador, abra <b>{lanUrl}</b> → bloco de IA ou ícone de pareamento → digite:</div>
                <div className="text-[30px] font-extrabold tracking-[0.2em] my-1 font-mono" data-testid="pairing-code">{code.code}</div>
                <div className="text-[11px] text-soft">Uso único · expira em {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</div>
              </div>
            ) : (
              <button className={primary} disabled={busy} onClick={() => void generate()} data-testid="pairing-generate">Gerar código de pareamento</button>
            )}
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">Computadores pareados ({mode.devices.length})</div>
              {!mode.devices.length && <div className="text-[12px] text-soft">Nenhum.</div>}
              <ul className="flex flex-col gap-1" data-testid="pairing-devices">
                {mode.devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-line/60 px-2 py-1.5 text-[12px]">
                    <span className="min-w-0"><b>{d.name}</b><span className="block text-[10px] text-soft">pareado em {when(d.createdAt)} · visto {when(d.lastSeenAt)}{d.lastAddress ? ` · ${d.lastAddress}` : ''}</span></span>
                    <button className={btn} onClick={() => void revoke(d)}>Revogar</button>
                  </li>
                ))}
              </ul>
              {code && <button className="mt-2 text-[11px] text-accent underline" onClick={() => void refresh()}>Atualizar lista</button>}
            </div>
          </>
        )}

        {mode.kind === 'remote' && (mode.paired ? (
          <div className="flex flex-col gap-2 text-[12px]" data-testid="pairing-remote-paired">
            <div className="text-ok">✓ Este computador está pareado como <b>{mode.paired.name}</b>. A IA usa as chaves do computador principal.</div>
            <div className="text-[11px] text-soft">Seus quadros e finanças continuam separados em cada computador (ficam no navegador de cada um).</div>
            <div><button className={btn} onClick={() => void unpair()}>Desparear este computador</button></div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[12px]" data-testid="pairing-remote-form">
            <p className="text-muted">No computador principal, abra o Aurora Board (<code>localhost:5173</code>) → ícone de pareamento na barra superior → <b>Gerar código</b>. Digite o código aqui.</p>
            <input className={`${input} font-mono tracking-widest uppercase text-center text-[18px]`} placeholder="XXXX-XXXX" aria-label="Código de pareamento" value={typed} maxLength={9} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void claim()} />
            <input className={input} placeholder="Nome deste computador" aria-label="Nome deste computador" value={name} onChange={(e) => setName(e.target.value)} />
            <button className={primary} disabled={busy || typed.replace(/[^a-z0-9]/gi, '').length !== 8} onClick={() => void claim()} data-testid="pairing-claim">Parear</button>
            {deviceToken() && <div className="text-[11px] text-warn">Havia um token neste computador, mas ele não vale mais (foi revogado). Pareie de novo.</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
