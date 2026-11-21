/**
 * D1-C — migração navegador → aplicativo desktop (e restauração de backups) por EXPORTAÇÃO/IMPORTAÇÃO.
 *
 * Nunca lê o perfil interno de um navegador nem copia arquivos de IndexedDB entre origens. Aceita:
 * - backup pessoal completo (`aurora-personal-backup`, quadros + finanças), cifrado ou não — o caminho recomendado;
 * - backup financeiro (`aurora-finance` / cifrado);
 * - backup de quadros/workspace (`aurora-board`) e dados do protótipo v0.2/v0.3.
 *
 * Ordem segura: TUDO é validado antes de gravar (esquema dos quadros, limites, assets, finanças); depois as finanças
 * (restauração só ACRESCENTA e ignora repetidos — repetir é seguro) e por último os quadros (uma única transação:
 * ou entram todos, ou nenhum). Se os quadros falharem depois das finanças, repetir a migração não duplica nada nas
 * finanças. Autorizações locais (IA, rede, dados importados) e credenciais nunca vêm de arquivo.
 */
import { parseImport, applyImport, ImportError, type ImportResult } from '../persistence/exportImport';
import { readBackupFile, BackupError, type FinanceBackup } from '../finance/backup';
import type { Workspace } from '../core/schema';

export interface MigrationPlan {
  kind: 'personal' | 'finance' | 'boards';
  encrypted: boolean;
  finance: FinanceBackup | null;
  boards: ImportResult | null;
  counts: { boards: number; elements: number; accounts: number; transactions: number; activeContent: number };
}

export class MigrationError extends Error {}

/** Valida o arquivo inteiro e diz o que será migrado — nada é gravado aqui. */
export async function planMigration(text: string, password: string | undefined, workspaceId: string): Promise<MigrationPlan> {
  let top: Record<string, unknown> | null = null;
  try { const j = JSON.parse(text); top = j && typeof j === 'object' ? (j as Record<string, unknown>) : null; } catch { throw new MigrationError('O arquivo não é um JSON válido do Aurora Board.'); }
  const fmt = top?.format;
  let finance: FinanceBackup | null = null;
  let boardsRaw: unknown = null;
  let encrypted = false;
  let kind: MigrationPlan['kind'] = 'boards';
  if (fmt === 'aurora-finance' || fmt === 'aurora-finance-encrypted' || fmt === 'aurora-personal-backup') {
    try {
      const r = await readBackupFile(text, password || undefined);
      finance = r.finance;
      boardsRaw = r.boards ?? null;
      encrypted = r.encrypted;
      kind = r.boards ? 'personal' : 'finance';
    } catch (e) {
      if (e instanceof BackupError) throw new MigrationError(e.message);
      throw new MigrationError('Não foi possível ler o backup (senha incorreta ou arquivo danificado).');
    }
  } else {
    boardsRaw = top;
  }
  let boards: ImportResult | null = null;
  if (boardsRaw) {
    try { boards = parseImport(JSON.stringify(boardsRaw), workspaceId); } catch (e) {
      throw new MigrationError(e instanceof ImportError ? `Quadros recusados: ${e.message}` : 'Quadros do backup inválidos.');
    }
  }
  if (!finance && !boards) throw new MigrationError('O arquivo não tem quadros nem dados financeiros.');
  return {
    kind,
    encrypted,
    finance,
    boards,
    counts: {
      boards: boards?.stats.boards ?? 0,
      elements: boards?.stats.elements ?? 0,
      accounts: finance?.accounts.length ?? 0,
      transactions: finance?.transactions.length ?? 0,
      activeContent: boards?.stats.activeContent ?? 0,
    },
  };
}

export interface MigrationDeps {
  restoreFinance: (b: FinanceBackup) => Promise<{ added: number; skipped: number }>;
  /** Rejeita só se a GRAVAÇÃO falhou (nada gravado). Falha ao abrir depois de gravar vem em `openError`. */
  importBoards: (r: ImportResult) => Promise<{ boardIds: string[]; openError?: string }>;
}

/**
 * Grava os quadros e depois tenta abri-los. Uma falha DEPOIS da gravação (atualizar a lista, abrir o quadro, gravar
 * a preferência de último quadro…) não pode ser relatada como “nada foi gravado”: repetir a migração criaria cópias
 * (Codex, PR #40). Só erros de `commit` rejeitam.
 */
export async function importThenOpen(commit: () => Promise<string[]>, open: (boardIds: string[]) => Promise<void>): Promise<{ boardIds: string[]; openError?: string }> {
  const boardIds = await commit();
  try { await open(boardIds); } catch (e) {
    return { boardIds, openError: (e as Error)?.message || 'não foi possível abrir o quadro importado' };
  }
  return { boardIds };
}

export interface MigrationOutcome {
  finance: { added: number; skipped: number } | null;
  boardIds: string[];
  /** Quadros GRAVADOS, mas a abertura falhou depois (não repetir a migração: criaria cópias). */
  openError?: string;
  /** Etapa que falhou (o que veio antes dela foi gravado; o que vem depois, não). */
  failed?: { step: 'finance' | 'boards'; message: string };
}

/** Grava o plano: finanças (idempotente) e depois quadros (atômico). Nunca lança: informa onde parou. */
export async function executeMigration(plan: MigrationPlan, deps: MigrationDeps): Promise<MigrationOutcome> {
  const out: MigrationOutcome = { finance: null, boardIds: [] };
  if (plan.finance) {
    try { out.finance = await deps.restoreFinance(plan.finance); } catch (e) {
      return { ...out, failed: { step: 'finance', message: (e as Error).message || 'Falha ao gravar as finanças.' } };
    }
  }
  if (plan.boards) {
    try {
      const r = await deps.importBoards(plan.boards);
      out.boardIds = r.boardIds;
      if (r.openError) out.openError = r.openError;
    } catch (e) {
      return { ...out, failed: { step: 'boards', message: (e as Error).message || 'Falha ao gravar os quadros.' } };
    }
  }
  return out;
}

/** Inventário exibido no assistente e documentado em docs/desktop/MIGRATION.md. */
export const MIGRATION_INVENTORY: { what: string; how: string; auto: boolean }[] = [
  { what: 'Quadros, workspaces, elementos, imagens, documentos, GIFs e dados importados (Data Hub)', how: 'Backup pessoal completo ou backup do workspace', auto: true },
  { what: 'Finanças (contas, movimentações, importações, categorias, regras)', how: 'Backup pessoal completo ou backup financeiro (cifrado recomendado)', auto: true },
  { what: 'Widgets HTML personalizados', how: 'Vêm nos quadros, mas chegam DESATIVADOS: ative cada um conscientemente', auto: false },
  { what: 'Autorizações locais (IA dos blocos HTML, dados importados e consultas bancárias; acesso à rede dos widgets)', how: 'Não são migradas: autorize de novo no desktop quando usar', auto: false },
  { what: 'Chaves de IA e credenciais do Meu Pluggy', how: 'Nunca estão em backups: configure em Configurações do aplicativo (cofre do sistema)', auto: false },
  { what: 'Consentimentos de provedores financeiros', how: 'Não entram em backups: reconecte no desktop', auto: false },
  { what: 'Preferências locais (zoom, navegação, animações, larguras dos painéis, favoritos do menu radial, Companions)', how: 'Ficam no navegador: ajuste de novo no desktop', auto: false },
];

export type { ImportResult, Workspace };
export { applyImport };
