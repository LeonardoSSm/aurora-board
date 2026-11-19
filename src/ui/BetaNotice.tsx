/**
 * Aviso do beta público (ciclo S1, Etapa 15): onde os dados ficam e por que exportar backups.
 * Só no build público (sem servidor local). A dispensa é guardada no próprio navegador — se o armazenamento
 * estiver indisponível, o aviso simplesmente volta a aparecer (nunca bloqueia o uso).
 */
import { useState } from 'react';
import { LOCAL_API_ENABLED } from '../config/runtime';
import { exportWorkspaceJSON } from './fileActions';

const KEY = 'aurora-beta-notice-v1';

function dismissed(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function BetaNotice() {
  const [open, setOpen] = useState(() => !LOCAL_API_ENABLED && !dismissed());
  if (!open) return null;
  const close = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* armazenamento indisponível */ }
    setOpen(false);
  };
  return (
    <div role="status" data-testid="beta-notice" className="absolute left-1/2 -translate-x-1/2 top-14 z-40 w-[min(560px,calc(100%-32px))] rounded-xl border border-accent/40 bg-[#122033]/95 shadow-[0_12px_40px_#0009] p-3 text-[12px] text-fg-2 flex flex-col gap-1.5">
      <b className="text-[13px] text-fg">Aurora Board — beta público</b>
      <span>Seus quadros ficam armazenados <b>neste navegador</b>. Não são sincronizados com nossos servidores.</span>
      <span>Exporte backups regularmente. Limpar os dados deste site pode apagar os quadros armazenados localmente.</span>
      <span className="text-soft">As integrações de IA não estão disponíveis nesta versão pública.</span>
      <div className="flex gap-2 justify-end mt-1">
        <button className="h-7 px-2 rounded-md border border-line hover:bg-panel-3" onClick={() => void exportWorkspaceJSON()}>Exportar backup agora</button>
        <button className="h-7 px-3 rounded-md bg-[#3174db] text-white" onClick={close}>Entendi</button>
      </div>
    </div>
  );
}
