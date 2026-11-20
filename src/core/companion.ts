/**
 * AI Companions (issue #13) — lógica pura: dados de visual do assistente (dentro do AIData, opcionais e
 * compatíveis), preferências pessoais de animação e a máquina de estados visual ligada a estados REAIS da
 * requisição. Sem DOM nem React.
 *
 * Estados visuais:
 *   idle      — standby; microanimações raras e locais (nunca chamam a API)
 *   attention — ponteiro/foco sobre o personagem ou mini chat aberto
 *   thinking  — sendChat pendente (aguardando resposta; NÃO é streaming, não há progresso falso)
 *   replying  — a resposta acabou de chegar (gesto curto), depois volta a idle
 *   error     — falhou, foi cancelada ou o provedor não está configurado
 *   unread    — chegou resposta com o mini chat/dock fechado; persiste até abrir
 */

/* ------------------------------------------------------------------ */
/* Dados persistidos no widget (AIData.companion)                      */
/* ------------------------------------------------------------------ */

export type DisplayMode = 'classic' | 'character';
export interface CompanionData {
  /** Versão do formato (para migrações futuras sem quebrar backups). */
  v: 1;
  displayMode: DisplayMode;
  /** Preset do personagem (manifesto). Desconhecido → avatar estático de fallback. */
  preset: string;
  /** Nome exibido (vazio = nome do preset). */
  name: string;
  /** Fixado no dock deste quadro. */
  docked: boolean;
}
export const DEFAULT_COMPANION: CompanionData = { v: 1, displayMode: 'classic', preset: 'aurora', name: '', docked: false };

/** Saneamento: ausente → undefined (backups antigos continuam clássicos e sem campo novo). */
export function sanitizeCompanion(raw: unknown): CompanionData | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const preset = typeof o.preset === 'string' && /^[a-z0-9-]{1,40}$/.test(o.preset) ? o.preset : DEFAULT_COMPANION.preset;
  const name = typeof o.name === 'string' ? o.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
  return { v: 1, displayMode: o.displayMode === 'character' ? 'character' : 'classic', preset, name, docked: o.docked === true };
}

/* ------------------------------------------------------------------ */
/* Preferências pessoais (configuração local, fora dos quadros)        */
/* ------------------------------------------------------------------ */

export type CompanionMotion = 'system' | 'off' | 'discreet' | 'normal' | 'expressive';
export interface CompanionPrefs { motion: CompanionMotion; ambientBubbles: boolean; dock: 'left' | 'right' | 'hidden'; sound: false }
export const DEFAULT_COMPANION_PREFS: CompanionPrefs = { motion: 'system', ambientBubbles: false, dock: 'right', sound: false };
export const COMPANION_MOTION_LABEL: Record<CompanionMotion, string> = { system: 'Sistema', off: 'Desligadas', discreet: 'Discretas', normal: 'Normais', expressive: 'Expressivas' };

export function sanitizeCompanionPrefs(raw: unknown): CompanionPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const motion = (['system', 'off', 'discreet', 'normal', 'expressive'] as const).includes(o.motion as CompanionMotion) ? (o.motion as CompanionMotion) : 'system';
  const dock = o.dock === 'left' || o.dock === 'hidden' ? o.dock : 'right';
  return { motion, ambientBubbles: o.ambientBubbles === true, dock, sound: false };
}

/** Intensidade efetiva: “Sistema” = Normais, ou Desligadas com movimento reduzido no sistema. */
export function effectiveMotion(p: CompanionPrefs, systemReduced: boolean): Exclude<CompanionMotion, 'system'> {
  if (p.motion === 'system') return systemReduced ? 'off' : 'normal';
  return p.motion;
}

/* ------------------------------------------------------------------ */
/* Estado da requisição (compartilhado entre clássico, personagem e dock) */
/* ------------------------------------------------------------------ */

export type RequestStatus = 'idle' | 'sending' | 'error' | 'cancelled';
export interface RequestState {
  status: RequestStatus;
  error: string;
  /** Quando a última resposta real chegou (ms). */
  repliedAt: number;
  /** Resposta chegou sem ninguém olhando (mini chat/dock/conversa fechados). */
  unread: boolean;
}
export const IDLE_REQUEST: RequestState = { status: 'idle', error: '', repliedAt: 0, unread: false };

export type VisualState = 'idle' | 'attention' | 'thinking' | 'replying' | 'error' | 'unread';
export const REPLYING_MS = 2400;

/** Estado visual derivado de fatos reais (requisição, interação, tempo). Prioridade: pensando > erro > respondendo > não lida > atenção > idle. */
export function visualState(req: RequestState, ui: { hover: boolean; open: boolean }, now: number): VisualState {
  if (req.status === 'sending') return 'thinking';
  if (req.status === 'error' || req.status === 'cancelled') return 'error';
  if (req.repliedAt && now - req.repliedAt < REPLYING_MS) return 'replying';
  if (req.unread && !ui.open) return 'unread';
  if (ui.hover || ui.open) return 'attention';
  return 'idle';
}

export const VISUAL_LABEL: Record<VisualState, string> = {
  idle: 'Disponível',
  attention: 'Atento',
  thinking: 'Aguardando a resposta…',
  replying: 'Respondeu',
  error: 'Erro',
  unread: 'Nova resposta',
};

/* ------------------------------------------------------------------ */
/* Microanimações de standby                                           */
/* ------------------------------------------------------------------ */

export const MICRO_ACTIONS = ['blink', 'look', 'hair', 'foot', 'posture', 'laptop', 'type', 'mug'] as const;
export type MicroAction = (typeof MICRO_ACTIONS)[number];

/** Intervalo entre microanimações por intensidade (ms): raras, nunca a cada segundo. */
export const MICRO_INTERVAL: Record<'discreet' | 'normal' | 'expressive', [number, number]> = {
  discreet: [14_000, 30_000],
  normal: [8_000, 18_000],
  expressive: [4_500, 10_000],
};
const DISCREET_SET: readonly MicroAction[] = ['blink', 'look', 'posture'];

/**
 * Próxima microanimação: ação e espera. Determinística dado `rand` (0–1) para testes. Nunca repete a mesma ação
 * duas vezes seguidas; “Discretas” só pisca, olha e ajeita a postura.
 */
export function nextMicro(intensity: 'discreet' | 'normal' | 'expressive', last: MicroAction | null, rand: () => number): { action: MicroAction; delay: number } {
  const [lo, hi] = MICRO_INTERVAL[intensity];
  const pool = (intensity === 'discreet' ? DISCREET_SET : MICRO_ACTIONS).filter((a) => a !== last);
  const action = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  const delay = Math.round(lo + (hi - lo) * rand());
  return { action, delay };
}

/** Limite de personagens animando ao mesmo tempo (os demais ficam parados, com chat funcional). */
export const MAX_ANIMATED = 6;
