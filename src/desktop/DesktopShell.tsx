/**
 * D1-C — integração do frontend com o aplicativo desktop (só existe com `window.auroraDesktop`):
 * - encerramento seguro: ao fechar a janela, grava o pendente e confirma ao processo principal;
 * - armazenamento persistente (o Chromium não descarta o IndexedDB do perfil por falta de espaço);
 * - boas-vindas na primeira abertura (não bloqueia o quadro) com o caminho de migração do navegador;
 * - assistente de migração por backup (quadros + finanças), com inventário do que migra e do que não migra.
 */
import { useEffect, useState } from 'react';
import { uid } from '../core/elements';
import { getState, setState } from '../store/editor';
import { flushTextEditor, openBoard, refreshBoards } from '../store/actions';
import { openDialog, toast } from '../store/ui';
import { flushCurrentBoard, getAdapter, hasPendingChanges } from '../persistence/autosave';
import { applyImport, checkImportFileSize, ImportError, type ImportResult } from '../persistence/exportImport';
import { invalidateDatasets } from '../data/store';
import { ensureFinanceLoaded, restoreFinanceBackup } from '../finance/store';
import { desktopBridge } from './bridge';
import { executeMigration, MIGRATION_INVENTORY, MigrationError, planMigration, type MigrationPlan } from './migration';
import { openDesktopSettings } from './settings';

const WELCOME_KEY = 'desktopWelcomeDone';

/** Registra os ganchos do desktop (chamado uma vez na inicialização, só no app desktop). */
export function registerDesktopLifecycle() {
  const b = desktopBridge();
  if (!b) return;
  b.lifecycle.onBeforeClose(async () => {
    // Texto ainda no editor (estado local do React) entra no quadro antes de gravar (Codex, PR #40).
    flushTextEditor();
    await flushCurrentBoard();
    return !hasPendingChanges();
  });
  try { void navigator.storage?.persist?.(); } catch { /* sem suporte: o perfil do app não é limpo automaticamente */ }
}

async function importBoards(r: ImportResult): Promise<{ boardIds: string[] }> {
  const ws = getState().workspaces.find((w) => w.id === getState().workspaceId);
  if (!ws) throw new ImportError('Nenhum workspace aberto.');
  const { boardIds, workspace, assetIds } = await applyImport(getAdapter(), r, ws, () => uid('b_'));
  invalidateDatasets(assetIds);
  setState({ workspaces: getState().workspaces.map((w) => (w.id === ws.id ? workspace : w)) });
  await refreshBoards();
  if (boardIds[0]) await openBoard(boardIds[0]);
  return { boardIds };
}

function Inventory() {
  return (
    <ul className="flex flex-col gap-1 text-[11px]" data-testid="migration-inventory">
      {MIGRATION_INVENTORY.map((i) => (
        <li key={i.what} className="flex gap-1.5"><span className={i.auto ? 'text-ok' : 'text-warn'}>{i.auto ? '✓' : '!'}</span><span><b className="text-fg">{i.what}</b> — {i.how}</span></li>
      ))}
    </ul>
  );
}

function MigrationBody({ done }: { done: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const analyze = async () => {
    if (!file) return;
    setBusy(true); setError(''); setPlan(null); setResult('');
    try {
      checkImportFileSize(file.size);
      setPlan(await planMigration(await file.text(), password, getState().workspaceId));
    } catch (e) {
      setError(e instanceof MigrationError || e instanceof ImportError ? e.message : 'Não foi possível ler o arquivo.');
    } finally { setBusy(false); }
  };
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    if (plan.finance) await ensureFinanceLoaded();
    const out = await executeMigration(plan, { restoreFinance: restoreFinanceBackup, importBoards });
    setBusy(false);
    const fin = out.finance ? `Finanças: ${out.finance.added} registro(s) novo(s), ${out.finance.skipped} já existente(s). ` : '';
    const nWarn = plan.boards?.warnings.length ?? 0;
    const brd = out.boardIds.length ? `${out.boardIds.length} quadro(s) importado(s)${nWarn ? ` com ${nWarn} aviso(s): parte do conteúdo não veio (ver a lista).` : '.'}` : '';
    if (out.failed) {
      setError(out.failed.step === 'finance'
        ? `Nada foi gravado: falha nas finanças (${out.failed.message}).`
        : `${fin}Os quadros NÃO foram gravados (${out.failed.message}); nenhum quadro existente foi alterado. Repetir a migração é seguro: as finanças repetidas são ignoradas.`);
      return;
    }
    setResult(`${fin}${brd}`.trim() || 'Nada novo a importar.');
    toast(nWarn ? 'Migração concluída com avisos.' : 'Migração concluída.', nWarn ? 'warning' : 'success');
    done();
  };
  return (
    <div className="flex flex-col gap-2 text-[12px] text-fg-2" data-testid="migration">
      <ol className="list-decimal pl-5 flex flex-col gap-0.5">
        <li>No navegador, abra o Aurora Board e vá em <b>Minhas contas → Privacidade e backups → Backup pessoal completo</b> (recomendado cifrar com senha). Sem finanças, use <b>Exportar → Backup do workspace</b>.</li>
        <li>Escolha o arquivo aqui. Tudo é validado antes de gravar; nada existente é substituído.</li>
      </ol>
      <div className="flex flex-wrap gap-1.5 items-center">
        <input type="file" accept=".json,application/json" data-testid="migration-file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); setError(''); setResult(''); }} />
        <input type="password" autoComplete="off" placeholder="Senha (se cifrado)" aria-label="Senha do backup" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8 px-2 rounded-md border border-line bg-[#0f1826]" />
        <button disabled={!file || busy} onClick={() => void analyze()} data-testid="migration-analyze" className="h-8 px-2.5 rounded-md border border-line disabled:opacity-40">Analisar</button>
      </div>
      {error && <div className="rounded-md border border-danger/50 bg-danger/10 p-2 text-fg-2" data-testid="migration-error">{error}</div>}
      {plan && !result && (
        <div className="rounded-md border border-accent/40 bg-accent/10 p-2 flex flex-col gap-1" data-testid="migration-plan">
          <div>{plan.kind === 'personal' ? 'Backup pessoal completo' : plan.kind === 'finance' ? 'Backup financeiro' : 'Backup de quadros'}{plan.encrypted ? ' (cifrado)' : ''}: <b>{plan.counts.boards}</b> quadro(s), <b>{plan.counts.elements}</b> elemento(s), <b>{plan.counts.accounts}</b> conta(s), <b>{plan.counts.transactions}</b> movimentação(ões).</div>
          {plan.counts.activeContent > 0 && <div className="text-warn">{plan.counts.activeContent} widget(s) HTML personalizado(s) chegarão desativados.</div>}
          <button disabled={busy} onClick={() => void run()} data-testid="migration-run" className="self-start h-8 px-3 rounded-md bg-[#3174db] text-white disabled:opacity-40">Migrar agora</button>
        </div>
      )}
      {plan?.boards && plan.boards.warnings.length > 0 && (
        // Avisos da leitura do backup (arquivos inválidos/ausentes): visíveis antes de confirmar e depois de migrar,
        // para distinguir migração completa de recuperação parcial antes de apagar os dados do navegador (Codex, PR #40).
        <details open={plan.boards.warnings.length < 6} className="rounded-md border border-warn/40 bg-warn/10 p-2" data-testid="migration-warnings">
          <summary className="cursor-pointer text-warn">{plan.boards.warnings.length} aviso(s): parte do conteúdo não será migrada. Confira antes de apagar os dados do navegador.</summary>
          <ul className="list-disc pl-5 max-h-40 overflow-auto text-[11px] text-muted mt-1">{plan.boards.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {result && <div className="rounded-md border border-ok/40 bg-ok/10 p-2" data-testid="migration-result">{result}</div>}
      <details>
        <summary className="cursor-pointer text-[11px] text-soft">O que migra e o que não migra</summary>
        <Inventory />
      </details>
    </div>
  );
}

export async function openMigrationDialog() {
  await openDialog({ title: 'Migrar dados do navegador', wide: true, body: <MigrationBody done={() => undefined} />, buttons: [{ label: 'Fechar', value: 'ok', variant: 'ghost' }] });
}

/** Cartão de boas-vindas da primeira abertura do desktop (não bloqueia o quadro). */
export function DesktopWelcome() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!desktopBridge()) return;
    let alive = true;
    const t = setInterval(async () => {
      if (getState().status !== 'ready') return;
      clearInterval(t);
      const seen = await getAdapter().getSetting<boolean>(WELCOME_KEY).catch(() => true);
      if (alive && !seen) setOpen(true);
    }, 200);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!open) return null;
  const close = () => { setOpen(false); void getAdapter().setSetting(WELCOME_KEY, true).catch(() => undefined); };
  return (
    <div role="status" data-testid="desktop-welcome" className="absolute right-4 bottom-4 z-40 w-[min(460px,calc(100%-32px))] rounded-xl border border-accent/40 bg-[#122033]/95 shadow-[0_12px_40px_#0009] p-3 text-[12px] text-fg-2 flex flex-col gap-1.5">
      <b className="text-[13px] text-fg">Bem-vindo ao Aurora Board Desktop</b>
      <span>Seus dados ficam no seu computador, no perfil do aplicativo. Já usava o Aurora Board no navegador? Traga quadros e finanças com um backup.</span>
      <div className="flex flex-wrap gap-2 justify-end mt-1">
        <button className="h-7 px-2 rounded-md border border-line hover:bg-panel-3" onClick={() => { close(); void openMigrationDialog(); }}>Migrar do navegador…</button>
        <button className="h-7 px-2 rounded-md border border-line hover:bg-panel-3" onClick={() => { close(); void openDesktopSettings(); }}>Configurar IA…</button>
        <button className="h-7 px-3 rounded-md bg-[#3174db] text-white" onClick={close}>Começar</button>
      </div>
    </div>
  );
}
