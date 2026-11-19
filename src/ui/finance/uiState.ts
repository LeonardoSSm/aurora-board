/** Estado de interface do módulo “Minhas contas” (aberto/fechado, aba). Não é persistido. */
import { create } from 'zustand';

export type FinanceTab = 'overview' | 'accounts' | 'cards' | 'transactions' | 'imports' | 'connectors' | 'rules' | 'privacy';

export const useFinanceUI = create<{ open: boolean; tab: FinanceTab; accountId: string | null; importAccountId: string | null }>(() => ({ open: false, tab: 'overview', accountId: null, importAccountId: null }));

export function openFinanceHub(tab: FinanceTab = 'overview', opts: { accountId?: string; importAccountId?: string } = {}) {
  useFinanceUI.setState({ open: true, tab, accountId: opts.accountId ?? null, importAccountId: opts.importAccountId ?? null });
}
export function closeFinanceHub() {
  useFinanceUI.setState({ open: false, importAccountId: null });
}
