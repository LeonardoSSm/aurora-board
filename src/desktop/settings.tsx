/**
 * D1-C — Configurações do aplicativo desktop: chaves de IA e credenciais do Meu Pluggy.
 *
 * Os valores vão direto para o processo principal (cofre do sistema ou só esta sessão) e NUNCA voltam ao renderer:
 * a tela mostra só “configurada / de onde vem”. Nada disso entra no IndexedDB, em quadros ou em backups.
 */
import { useEffect, useState } from 'react';
import { openDialog, toast } from '../store/ui';
import { desktopBridge, type SecretName, type SecretsStatus } from './bridge';
import { fetchAIStatus } from '../integrations/aiClient';

const LABELS: Record<SecretName, string> = {
  OPENAI_API_KEY: 'OpenAI — chave de API',
  OPENAI_MODEL: 'OpenAI — modelo (opcional)',
  ANTHROPIC_API_KEY: 'Anthropic (Claude) — chave de API',
  ANTHROPIC_MODEL: 'Anthropic — modelo (opcional)',
  GEMINI_API_KEY: 'Google Gemini — chave de API',
  GEMINI_MODEL: 'Gemini — modelo (opcional)',
  PLUGGY_CLIENT_ID: 'Meu Pluggy — Client ID',
  PLUGGY_CLIENT_SECRET: 'Meu Pluggy — Client Secret',
  PLUGGY_ITEM_IDS: 'Meu Pluggy — IDs dos itens (separados por vírgula)',
};
const SOURCE: Record<string, string> = { vault: 'no cofre do sistema', session: 'só nesta sessão', env: 'variável de ambiente do sistema', none: 'não configurada' };

function Row({ name, status, onChange }: { name: SecretName; status: SecretsStatus; onChange: (s: SecretsStatus) => void }) {
  const item = status.items.find((i) => i.name === name)!;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const b = desktopBridge();
  const save = async (mode: 'vault' | 'session') => {
    if (!b || !value.trim()) return;
    setBusy(true);
    const r = await b.secrets.set(name, value, mode);
    setBusy(false);
    if (r.status) onChange(r.status);
    if (!r.ok) { toast(r.error ?? 'Não foi possível salvar.', 'error'); return; }
    setValue('');
    void fetchAIStatus(true);
    toast(mode === 'vault' ? 'Salvo no cofre do sistema.' : 'Definido só para esta sessão.', 'success');
  };
  const clear = async () => {
    if (!b) return;
    const r = await b.secrets.clear(name);
    if (r.status) onChange(r.status);
    void fetchAIStatus(true);
  };
  return (
    <div className="rounded-lg border border-line/60 p-2 flex flex-col gap-1.5" data-testid={`secret-${name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`sec-${name}`} className="text-[12px] text-fg font-semibold">{LABELS[name]}</label>
        <span className={`text-[11px] ${item.configured ? 'text-ok' : 'text-soft'}`} data-testid={`secret-status-${name}`}>{item.configured ? '✓ ' : ''}{SOURCE[item.source]}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <input id={`sec-${name}`} type={item.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder={item.configured ? 'Digite para substituir' : 'Cole aqui'} className="flex-1 min-w-[12rem] h-8 px-2 rounded-md border border-line bg-[#0f1826] text-[12px] font-mono" />
        <button disabled={busy || !value.trim() || !status.vault.strong} onClick={() => void save('vault')} className="h-8 px-2.5 rounded-md bg-[#3174db] text-white text-[11px] disabled:opacity-40">Salvar no cofre</button>
        <button disabled={busy || !value.trim()} onClick={() => void save('session')} className="h-8 px-2.5 rounded-md border border-line text-[11px] disabled:opacity-40">Só nesta sessão</button>
        {(item.source === 'vault' || item.source === 'session') && <button onClick={() => void clear()} className="h-8 px-2.5 rounded-md border border-danger/50 text-danger text-[11px]">Remover</button>}
      </div>
    </div>
  );
}

function SettingsBody() {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  useEffect(() => { void desktopBridge()?.secrets.status().then(setStatus); }, []);
  if (!status) return <div className="text-[12px] text-muted">Carregando…</div>;
  return (
    <div className="flex flex-col gap-2 text-[12px] text-fg-2" data-testid="desktop-settings">
      <div className={`rounded-lg border p-2 ${status.vault.strong ? 'border-ok/40 bg-ok/10' : 'border-warn/50 bg-warn/10'}`} data-testid="vault-status">
        <b>{status.vault.strong ? 'Cofre do sistema disponível' : 'Sem cofre seguro do sistema'}</b> — {status.vault.detail}
        {!status.vault.strong && <div className="mt-1">As chaves NÃO serão gravadas em disco. Use “Só nesta sessão” ou, no Linux, instale/abra o GNOME Keyring (Secret Service) ou o KWallet e reinicie o app.</div>}
      </div>
      {status.error && <div className="rounded-lg border border-warn/50 bg-warn/10 p-2" data-testid="vault-error">{status.error}</div>}
      <p className="text-[11px] text-soft">Os valores vão direto para o processo principal do aplicativo e nunca voltam para a tela, para quadros ou para backups. Variáveis de ambiente do sistema também funcionam; um valor definido aqui tem prioridade.</p>
      <div className="flex flex-col gap-1.5 max-h-[55vh] overflow-auto pr-1">
        {status.items.map((i) => <Row key={i.name} name={i.name} status={status} onChange={setStatus} />)}
      </div>
    </div>
  );
}

export async function openDesktopSettings() {
  if (!desktopBridge()) return;
  await openDialog({ title: 'Configurações do aplicativo', wide: true, body: <SettingsBody />, buttons: [{ label: 'Fechar', value: 'ok', variant: 'primary' }] });
}
