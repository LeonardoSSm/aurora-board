/**
 * Acesso tipado à ponte do aplicativo desktop (`window.auroraDesktop`, exposta pelo preload). Na versão web não
 * existe: todas as funções aqui devolvem null/indisponível.
 */
import type { ApiResult } from '../integrations/apiRoutes';
import type { ImportFileResult } from '../../desktop/importFile';

export type SecretName = 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY' | 'OPENAI_MODEL' | 'ANTHROPIC_MODEL' | 'GEMINI_MODEL' | 'PLUGGY_CLIENT_ID' | 'PLUGGY_CLIENT_SECRET' | 'PLUGGY_ITEM_IDS';
export interface SecretStatus { name: SecretName; configured: boolean; source: 'vault' | 'session' | 'env' | 'none'; secret: boolean }
export interface VaultInfo { kind: 'dpapi' | 'secret-service' | 'kwallet' | 'keychain' | 'none'; strong: boolean; detail: string }
export interface SecretsStatus { vault: VaultInfo; items: SecretStatus[]; error?: string }
export interface SecretsResult { ok: boolean; error?: string; status?: SecretsStatus }

export interface DesktopBridge {
  isDesktop: true;
  platform: 'windows' | 'linux' | 'other';
  api: { call(id: string, op: unknown, body?: unknown): Promise<ApiResult>; cancel(id: string): void };
  secrets: { status(): Promise<SecretsStatus | null>; set(name: SecretName, value: string, mode: 'vault' | 'session'): Promise<SecretsResult>; clear(name: SecretName): Promise<SecretsResult> };
  files: { pickImport(): Promise<ImportFileResult> };
  lifecycle: { onBeforeClose(handler: () => Promise<boolean>): void; onMenu(handler: (action: string) => void): void };
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { auroraDesktop?: DesktopBridge }).auroraDesktop;
  return b && b.isDesktop === true ? b : null;
}
