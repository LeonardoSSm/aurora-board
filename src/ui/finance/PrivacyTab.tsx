/** Regras/categorias e Privacidade/backups do módulo financeiro. */
import { useState } from 'react';
import type { MovementKind } from '../../finance/model';
import { KIND_LABELS, MOVEMENT_KINDS } from '../../finance/model';
import { addCategory, addRule, applyRulesNow, deleteRule, getFinance, renameCategory, restoreFinanceBackup, useFinance, wipeFinanceData } from '../../finance/store';
import { buildFinanceBackup, checkPassword, encryptBackup, readBackupFile, type PersonalBackup } from '../../finance/backup';
import { downloadText } from '../../persistence/exportImport';
import { buildWorkspaceExportText } from '../fileActions';
import { confirmDialog, promptDialog, toast } from '../../store/ui';
import { btnCls, Card, dangerCls, inputCls, primaryCls, todayISO } from './common';

export function RulesTab() {
  const s = useFinance();
  const [rule, setRule] = useState<{ match: string; category: string; kind: MovementKind | '' }>({ match: '', category: '', kind: '' });
  const [cat, setCat] = useState('');
  return (
    <div className="flex flex-col gap-3" data-testid="finance-rules">
      <Card title="Regras de categorização (locais)">
        <div className="text-[11px] text-muted mb-2">Aplicadas a novas importações e quando você pede. Nunca alteram o registro original do banco nem classificações feitas à mão.</div>
        <div className="flex flex-wrap gap-1.5 items-center">
          <input className={inputCls} placeholder="Descrição contém… (ex.: uber)" aria-label="Texto da regra" value={rule.match} onChange={(e) => setRule({ ...rule, match: e.target.value })} />
          <select className={inputCls} aria-label="Categoria da regra" value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })}><option value="">(categoria)</option>{s.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
          <select className={inputCls} aria-label="Tipo da regra" value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value as MovementKind })}><option value="">(tipo)</option>{MOVEMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>
          <button className={primaryCls} onClick={async () => { try { await addRule({ match: rule.match, category: rule.category || undefined, kind: rule.kind || undefined }); setRule({ match: '', category: '', kind: '' }); } catch (e) { toast((e as Error).message, 'error'); } }}>Adicionar regra</button>
          <button className={btnCls} onClick={async () => toast(`${await applyRulesNow()} movimentação(ões) reclassificada(s).`, 'success')}>Aplicar regras agora</button>
        </div>
        <ul className="mt-2 text-[12px]">
          {s.rules.map((r) => <li key={r.id} className="flex justify-between border-b border-line/40 py-1"><span>“{r.match}” → {r.category ?? ''}{r.kind ? ` · ${KIND_LABELS[r.kind]}` : ''}</span><button className="text-soft hover:text-danger" aria-label="Excluir regra" onClick={() => void deleteRule(r.id)}>✕</button></li>)}
          {!s.rules.length && <li className="text-soft text-[11px]">Nenhuma regra.</li>}
        </ul>
      </Card>
      <Card title="Categorias">
        <div className="flex gap-1.5 mb-2"><input className={inputCls} placeholder="Nova categoria" aria-label="Nova categoria" value={cat} onChange={(e) => setCat(e.target.value)} /><button className={btnCls} onClick={async () => { try { await addCategory(cat); setCat(''); } catch (e) { toast((e as Error).message, 'error'); } }}>Adicionar</button></div>
        <div className="flex flex-wrap gap-1">
          {s.categories.map((c) => <button key={c.id} className="text-[11px] px-2 py-0.5 rounded-full border border-line hover:border-accent" title="Renomear" onClick={async () => { const n = await promptDialog('Renomear categoria', 'As movimentações com esta categoria passam a usar o novo nome.', c.name); if (n) await renameCategory(c.id, n); }}>{c.name}</button>)}
        </div>
      </Card>
    </div>
  );
}

export function PrivacyTab() {
  const s = useFinance();
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [restorePwd, setRestorePwd] = useState('');

  const encrypted = password.length > 0;
  const pwdError = encrypted ? checkPassword(password) ?? (password !== password2 ? 'As senhas não conferem.' : null) : null;

  const exportFinance = async (personal: boolean) => {
    if (pwdError) { toast(pwdError, 'error'); return; }
    const ok = await confirmDialog(personal ? 'Backup pessoal completo' : 'Backup financeiro', `${personal ? 'O arquivo terá seus quadros (com os dados importados usados neles) E seus dados financeiros.' : 'O arquivo terá dados financeiros'} (${selected.length ? `${selected.length} conta(s)` : 'todas as contas'}): contas, movimentações, importações, categorias e regras. ${encrypted ? 'Ele será cifrado com a sua senha (AES-GCM). Sem a senha, o arquivo é irrecuperável — ninguém consegue recuperá-la.' : 'Ele NÃO será cifrado: qualquer pessoa com o arquivo lê seus dados.'} Consentimentos de conexões não entram.`, 'Gerar backup', !encrypted);
    if (!ok) return;
    setBusy(true);
    try {
      const fin = buildFinanceBackup(getFinance(), selected.length ? selected : undefined);
      let body = JSON.stringify(fin);
      if (personal) {
        // Backup pessoal COMPLETO: inclui os dados importados (Data Hub), como avisado na confirmação.
        const ws = await buildWorkspaceExportText({ datasets: true });
        const p: PersonalBackup = { format: 'aurora-personal-backup', version: 1, exportedAt: Date.now(), sensitive: true, boards: JSON.parse(ws.text), finance: fin };
        body = JSON.stringify(p);
      }
      if (encrypted) body = JSON.stringify(await encryptBackup(body, password, personal ? 'personal' : 'finance'));
      downloadText(`aurora-${personal ? 'pessoal' : 'financas'}-${todayISO()}${encrypted ? '.cifrado' : ''}.json`, body);
      toast('Backup gerado. Guarde o arquivo em local seguro.', 'success', 6000);
      setPassword(''); setPassword2('');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const restore = async (file: File) => {
    setBusy(true);
    try {
      const { finance, boards } = await readBackupFile(await file.text(), restorePwd || undefined);
      const ok = await confirmDialog('Restaurar dados financeiros', `${finance.accounts.length} conta(s) e ${finance.transactions.length} movimentação(ões) no arquivo. Só o que ainda não existe aqui será acrescentado; nada existente é sobrescrito.${boards ? ' Este backup também tem quadros: importe-os em Importar → Arquivo JSON (barra superior).' : ''}`, 'Restaurar');
      if (!ok) return;
      const r = await restoreFinanceBackup(finance);
      toast(`Restauradas ${r.added} movimentação(ões); ${r.skipped} já existiam.`, 'success', 6000);
      setRestorePwd('');
    } catch (e) { toast((e as Error).message, 'error', 6000); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="finance-privacy">
      <Card title="Como seus dados financeiros ficam protegidos">
        <ul className="text-[12px] text-fg-2 list-disc pl-5 flex flex-col gap-1">
          <li>Ficam só neste navegador, num banco local separado dos quadros (<code>aurora-finance</code>). Nada é enviado a servidores.</li>
          <li><b>Não há criptografia própria no armazenamento local</b>: a proteção é a do seu usuário do sistema operacional, do perfil do navegador e da criptografia de disco (BitLocker/FileVault), se ativada. Quem usa seu perfil do navegador consegue ver estes dados.</li>
          <li>Backups dos quadros (Exportar) não incluem extratos. Blocos de consulta bancária guardam só a consulta.</li>
          <li>A IA só recebe dados financeiros que você autorizar e confirmar em cada bloco de consulta.</li>
          <li>Números de conta e cartão ficam só com os 4 últimos dígitos. Senhas bancárias, códigos e tokens nunca são pedidos nem guardados.</li>
        </ul>
      </Card>
      <Card title="Backups (separados dos quadros)">
        <div className="text-[11px] text-muted mb-1">Contas incluídas (nenhuma marcada = todas):</div>
        <div className="flex flex-wrap gap-2 text-[11px] mb-2">{s.accounts.map((a) => <label key={a.id} className="flex items-center gap-1"><input type="checkbox" checked={selected.includes(a.id)} onChange={(e) => setSelected((x) => (e.target.checked ? [...x, a.id] : x.filter((y) => y !== a.id)))} /> {a.name}</label>)}</div>
        <div className="flex flex-wrap gap-1.5 items-center">
          <input className={inputCls} type="password" autoComplete="new-password" placeholder="Senha do backup (opcional)" aria-label="Senha do backup" value={password} onChange={(e) => setPassword(e.target.value)} />
          {encrypted && <input className={inputCls} type="password" autoComplete="new-password" placeholder="Repita a senha" aria-label="Repita a senha" value={password2} onChange={(e) => setPassword2(e.target.value)} />}
        </div>
        {encrypted && <div className={`text-[11px] mt-1 ${pwdError ? 'text-warn' : 'text-ok'}`}>{pwdError ?? 'Cifra AES-GCM 256 com chave derivada da senha (PBKDF2-SHA-256, 600 mil iterações). A senha não é guardada.'}</div>}
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button className={primaryCls} disabled={busy || !s.accounts.length} data-testid="export-finance" onClick={() => void exportFinance(false)}>Exportar backup financeiro</button>
          <button className={btnCls} disabled={busy} data-testid="export-personal" onClick={() => void exportFinance(true)}>Backup pessoal completo (quadros + finanças)</button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 items-center text-[11px]">
          <span>Restaurar:</span>
          <input className={inputCls} type="password" autoComplete="off" placeholder="Senha (se cifrado)" aria-label="Senha para restaurar" value={restorePwd} onChange={(e) => setRestorePwd(e.target.value)} />
          <input type="file" accept=".json,application/json" data-testid="restore-finance" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f); }} />
        </div>
      </Card>
      <Card title="Apagar dados financeiros locais">
        <div className="text-[12px] text-muted mb-2">Remove contas, movimentações, importações, regras e registros de conexão deste navegador. Não revoga autorizações em instituições externas (faça isso em Conectores ou na própria instituição). Os quadros não são afetados; blocos de consulta passam a mostrar “indisponível”.</div>
        <button className={dangerCls} data-testid="wipe-finance" onClick={async () => {
          const typed = await promptDialog('Apagar todos os dados financeiros', 'Esta ação não pode ser desfeita. Digite APAGAR para confirmar.', '', 'APAGAR', 'Apagar tudo');
          if (typed !== 'APAGAR') { if (typed !== null) toast('Texto de confirmação incorreto. Nada foi apagado.', 'warning'); return; }
          await wipeFinanceData();
          toast('Dados financeiros locais apagados.', 'success');
        }}>Apagar todos os dados financeiros</button>
      </Card>
    </div>
  );
}
