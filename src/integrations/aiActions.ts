/**
 * Ações estruturadas propostas pela IA — contrato v2 (ver docs/AI_ACTIONS.md).
 *
 * Princípios:
 * - A resposta do modelo é DADO NÃO CONFIÁVEL. Toda ação é validada com Zod, ação por ação; inválidas são
 *   recusadas com motivo (as demais seguem), nunca corrigidas por adivinhação.
 * - Dinheiro nunca passa por ponto flutuante: `amount` é texto decimal ("2000.00") convertido para centavos
 *   inteiros por aritmética de inteiros; números JSON só são aceitos quando sua forma decimal exata tem até 2 casas.
 * - Dados ausentes (data, categoria, competência, descrição) NÃO são inventados: ficam vazios ou recebem o padrão
 *   documentado do sistema, sempre exibido na prévia.
 * - Nada é executado aqui: o módulo só valida, descreve e monta um plano. Aplicar exige confirmação na interface
 *   e acontece em UMA entrada de histórico (desfazer/refazer).
 * - O formato antigo ({ notes, tasks, connections }) continua aceito e é convertido para ações v2.
 */
import '../core/zodSetup';
import { z } from 'zod';
import type { AuroraElement, WidgetElement } from '../core/schema';
import { isLinear } from '../core/schema';
import { createLinear, createWidget } from '../core/elements';
import { resolveLinear } from '../core/bindings';
import { WIDGET } from '../core/widgetIds';
import { MAX_CENTS } from '../core/decimal';
import { computeFinance, emptyFinance, formatMoney, sanitizeFinance, type Currency, type FinanceData, type FinanceEntry } from '../core/finance';
import { createValueData, sanitizeValue, VALUE_SIZES, type ValueTileData } from '../core/valueTile';
import { PERIOD_RE, ROLE_LABEL, normalizeName, periodLabel, type FinancialRole } from '../core/scalar';
import { sanitizeAI, sanitizeTasks } from '../core/widgetData';
import { appendTasks } from '../widgets/builtin/tasks';

export const AI_ACTIONS_VERSION = 2;
export const MAX_ACTIONS = 80;

/* ------------------------------------------------------------------ */
/* Dinheiro                                                            */
/* ------------------------------------------------------------------ */

/** Texto decimal com ponto, sem milhar, até 2 casas: "2000", "2000.5", "2000.00". */
const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Converte o `amount` da IA em centavos inteiros, sem ponto flutuante.
 * - string: precisa casar AMOUNT_RE ("2.000,00", "2,000.00", "-5", "1e3" são recusados).
 * - number: só se a forma decimal mais curta (String(n)) casar AMOUNT_RE — 2000 e 2000.5 passam;
 *   2000.005, 1e21, NaN e negativos não. Assim o arredondamento binário nunca decide centavos.
 */
export function amountToCents(v: unknown): number | null {
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) s = String(v);
  else return null;
  if (!AMOUNT_RE.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  const cents = BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2));
  return cents > MAX_CENTS ? null : Number(cents);
}

/** Valor por extenso para conferência: 200000 → "2000.00". Exato (inteiros). */
export function centsToDecimalText(cents: number): string {
  const c = BigInt(cents);
  return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Data civil real AAAA-MM-DD (rejeita 2026-02-30). */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

/* ------------------------------------------------------------------ */
/* Esquemas (entrada bruta do modelo)                                  */
/* ------------------------------------------------------------------ */

const text = (max: number) => z.string().trim().max(max, { error: `máximo de ${max} caracteres` });
const CurrencySchema = z.enum(['BRL', 'USD', 'EUR'], { error: 'moeda deve ser BRL, USD ou EUR' });
const moneyFields = {
  amount: z.union([z.string().max(40), z.number()], { error: 'amount deve ser texto decimal (ex.: "2000.00")' }).optional(),
  amountCents: z.number({ error: 'amountCents deve ser número inteiro de centavos' }).optional(),
  currency: CurrencySchema.optional(),
  ambiguous: z.boolean().optional(),
};
const idField = z.string().min(1).max(120);

const CreateNoteSchema = z.object({
  type: z.literal('create_note'),
  title: text(200).optional(),
  content: z.string().max(20000, { error: 'conteúdo longo demais' }).default(''),
});
const CreateTasksSchema = z.object({
  type: z.literal('create_tasks'),
  title: text(200).optional(),
  tasks: z
    .array(z.object({ text: text(500).min(1, { error: 'tarefa vazia' }), priority: z.enum(['low', 'medium', 'high']).optional() }))
    .min(1, { error: 'lista de tarefas vazia' })
    .max(100, { error: 'no máximo 100 tarefas' }),
});
const ConnectSchema = z.object({ type: z.literal('connect'), from: idField, to: idField, label: text(120).optional() });
const CreateValueSchema = z.object({
  type: z.literal('create_value'),
  title: text(80).optional(),
  role: z.enum(['income', 'expense', 'neutral'], { error: 'role deve ser income, expense ou neutral' }).optional(),
  period: z.string().regex(PERIOD_RE, { error: 'competência deve ser AAAA-MM' }).optional(),
  category: text(60).optional(),
  note: text(300).optional(),
  ...moneyFields,
});
const AddEntrySchema = z.object({
  type: z.literal('add_finance_entry'),
  target: idField.nullable().optional(),
  kind: z.enum(['income', 'expense'], { error: 'kind deve ser income ou expense' }),
  description: text(200).optional(),
  category: text(60).optional(),
  date: z.string().refine(isValidDate, { error: 'data inválida (use AAAA-MM-DD)' }).optional(),
  paid: z.boolean().optional(),
  installments: z.number().int({ error: 'parcelas devem ser inteiras' }).min(1).max(360).optional(),
  installmentMode: z.enum(['split', 'repeat']).optional(),
  ...moneyFields,
});

const SCHEMAS = {
  create_note: CreateNoteSchema,
  create_tasks: CreateTasksSchema,
  connect: ConnectSchema,
  create_value: CreateValueSchema,
  add_finance_entry: AddEntrySchema,
} as const;
export type AIActionType = keyof typeof SCHEMAS;
export const AI_ACTION_TYPES = Object.keys(SCHEMAS) as AIActionType[];

/* ------------------------------------------------------------------ */
/* Ações normalizadas                                                  */
/* ------------------------------------------------------------------ */

export interface NoteAction { type: 'note'; title: string; content: string }
export interface TasksAction { type: 'tasks'; title: string; tasks: { text: string; priority?: 'low' | 'medium' | 'high' }[] }
export interface ConnectAction { type: 'connect'; from: string; to: string; label: string }
export interface MoneyAction {
  type: 'money';
  /** Ação original: bloco de valor independente ou lançamento em Finanças. */
  origin: 'create_value' | 'add_finance_entry';
  role: FinancialRole;
  /** Papel informado? (create_value sem role usa o padrão do sistema: neutro). */
  roleGiven: boolean;
  amountCents: number;
  /** null = não informada (usa BRL ou a moeda do bloco de destino). */
  currency: Currency | null;
  /** Título do bloco ou descrição do lançamento ('' = padrão). */
  title: string;
  category: string;
  /** AAAA-MM ou ''. */
  period: string;
  /** AAAA-MM-DD ou ''. */
  date: string;
  note: string;
  paid: boolean;
  installments: number;
  installmentMode: 'split' | 'repeat';
  /** Bloco de Finanças sugerido pela IA (validado depois contra os destinos permitidos). */
  target: string | null;
  /** A IA declarou não saber se é bloco independente ou lançamento. */
  ambiguous: boolean;
}
export type ProposedAction = NoteAction | TasksAction | ConnectAction | MoneyAction;

export interface RejectedAction { index: number; type: string; reason: string }
export interface ParsedProposal {
  version: 1 | 2;
  actions: ProposedAction[];
  rejected: RejectedAction[];
  notices: string[];
  /** Trecho da resposta de onde a proposta foi lida ('' quando não veio da resposta). */
  raw: string;
}

function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

type Validated = { ok: true; action: ProposedAction } | { ok: false; reason: string };

function centsOf(a: { amount?: string | number; amountCents?: number }): { ok: true; cents: number } | { ok: false; reason: string } {
  const fromAmount = a.amount === undefined ? undefined : amountToCents(a.amount);
  if (fromAmount === null) return { ok: false, reason: 'valor inválido: use texto decimal com ponto e até 2 casas, sem milhar (ex.: "2000.00")' };
  const fromCents = a.amountCents === undefined ? undefined : Number.isSafeInteger(a.amountCents) && a.amountCents >= 0 && a.amountCents <= Number(MAX_CENTS) ? a.amountCents : null;
  if (fromCents === null) return { ok: false, reason: 'amountCents deve ser inteiro de centavos, não negativo e dentro do limite' };
  if (fromAmount === undefined && fromCents === undefined) return { ok: false, reason: 'valor ausente' };
  if (fromAmount !== undefined && fromCents !== undefined && fromAmount !== fromCents) return { ok: false, reason: 'amount e amountCents divergem' };
  const cents = (fromAmount ?? fromCents)!;
  if (cents === 0) return { ok: false, reason: 'valor deve ser maior que zero' };
  return { ok: true, cents };
}

function validateOne(raw: unknown, validIds: ReadonlySet<string>): Validated {
  const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined;
  const schema = typeof type === 'string' && Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type as AIActionType] : null;
  if (!schema) return { ok: false, reason: 'tipo de ação desconhecido' };
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, reason: issueText(r.error) };
  const a = r.data;
  switch (a.type) {
    case 'create_note':
      return { ok: true, action: { type: 'note', title: a.title || 'Nota', content: a.content } };
    case 'create_tasks':
      return { ok: true, action: { type: 'tasks', title: a.title || 'Tarefas sugeridas', tasks: a.tasks } };
    case 'connect':
      if (a.from === a.to) return { ok: false, reason: 'conexão de um bloco com ele mesmo' };
      if (!validIds.has(a.from) || !validIds.has(a.to)) return { ok: false, reason: 'conexão cita bloco fora do contexto autorizado' };
      return { ok: true, action: { type: 'connect', from: a.from, to: a.to, label: a.label ?? '' } };
    case 'create_value': {
      const c = centsOf(a);
      if (!c.ok) return c;
      return {
        ok: true,
        action: {
          type: 'money', origin: 'create_value', role: a.role ?? 'neutral', roleGiven: !!a.role, amountCents: c.cents, currency: a.currency ?? null,
          title: a.title ?? '', category: a.category ?? '', period: a.period ?? '', date: '', note: a.note ?? '', paid: false, installments: 1,
          installmentMode: 'split', target: null, ambiguous: !!a.ambiguous,
        },
      };
    }
    case 'add_finance_entry': {
      const c = centsOf(a);
      if (!c.ok) return c;
      const installments = a.installments ?? 1;
      if (installments > 1 && !a.date) return { ok: false, reason: 'parcelas exigem a data do primeiro vencimento' };
      return {
        ok: true,
        action: {
          type: 'money', origin: 'add_finance_entry', role: a.kind, roleGiven: true, amountCents: c.cents, currency: a.currency ?? null,
          title: a.description ?? '', category: a.category ?? '', period: '', date: a.date ?? '', note: '', paid: a.paid ?? false, installments,
          installmentMode: a.installmentMode ?? 'split', target: a.target ?? null, ambiguous: !!a.ambiguous,
        },
      };
    }
  }
}

const PROPOSAL_MARKERS = ['{"version"', '{"actions"', '{"notes"', '{"tasks"', '{"connections"'];

/**
 * Onde está a proposta na resposta. O contrato pede um único bloco ```json ao final, mas modelos reais desviam
 * (observado com gpt-4.1-mini: JSON puro, sem cerca). Em ordem:
 * 1. último bloco ```json / ```JSON, ou ``` sem linguagem cujo conteúdo começa com "{";
 * 2. a resposta inteira, se for um objeto JSON;
 * 3. um objeto JSON no FIM da resposta que comece por uma chave do contrato ({"version", {"actions"…).
 * `raw` é o trecho exato (para ocultá-lo do texto exibido). Tudo continua passando pela validação.
 */
export function proposalSource(text: string): { raw: string; json: string } | null {
  const fenced = [...text.matchAll(/```(json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const body = fenced[i][2].trim();
    if (fenced[i][1] || body.startsWith('{')) return { raw: fenced[i][0], json: body };
  }
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return { raw: t, json: t };
  if (!t.endsWith('}')) return null;
  const starts = PROPOSAL_MARKERS.map((m) => t.indexOf(m)).filter((i) => i >= 0);
  if (!starts.length) return null;
  const tail = t.slice(Math.min(...starts));
  return { raw: tail, json: tail };
}

/** Texto da resposta sem o trecho da proposta (o que a conversa exibe). */
export function proposalDisplayText(text: string, proposal: ParsedProposal | null): string {
  if (!proposal) return text;
  return text.replace(proposal.raw, '').replace(/```(json|JSON)\s*[\s\S]*?```/g, '').trim();
}

/** Converte o formato v1 ({ notes, tasks, connections }) em ações v2. */
function legacyItems(o: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(o.notes)) for (const n of o.notes) out.push({ ...(n && typeof n === 'object' ? n : {}), type: 'create_note' });
  if (Array.isArray(o.tasks) && o.tasks.length) out.push({ type: 'create_tasks', title: 'Tarefas sugeridas', tasks: o.tasks });
  if (Array.isArray(o.connections)) for (const c of o.connections) out.push({ ...(c && typeof c === 'object' ? c : {}), type: 'connect' });
  return out;
}

/**
 * Extrai e valida a proposta estruturada de uma resposta da IA.
 * `validIds` = ids do contexto autorizado (únicos aceitos em conexões).
 * Retorna null quando não há proposta (sem bloco json, json inválido ou nada aproveitável).
 */
export function parseAIProposal(text: string, validIds: ReadonlySet<string>): ParsedProposal | null {
  const src = proposalSource(text);
  if (src === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(src.json);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.version === 3) return null;
  const v2 = Array.isArray(o.actions);
  const v1 = 'notes' in o || 'tasks' in o || 'connections' in o;
  if (!v2 && !v1) return null;
  const notices: string[] = [];
  if (v2 && o.version !== undefined && o.version !== AI_ACTIONS_VERSION) notices.push(`Versão de contrato ${String(o.version).slice(0, 10)} não reconhecida; ações validadas pelo contrato v${AI_ACTIONS_VERSION}.`);
  const items = [...(v2 ? (o.actions as unknown[]) : []), ...legacyItems(o)];
  const actions: ProposedAction[] = [];
  const rejected: RejectedAction[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const type = item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string' ? String((item as { type: string }).type).slice(0, 40) : '?';
    if (index >= MAX_ACTIONS) {
      rejected.push({ index, type, reason: `limite de ${MAX_ACTIONS} ações por proposta` });
      return;
    }
    const r = validateOne(item, validIds);
    if (!r.ok) {
      rejected.push({ index, type, reason: r.reason });
      return;
    }
    const key = JSON.stringify(r.action);
    if (seen.has(key)) {
      notices.push('Ação repetida na proposta foi ignorada (evita lançamento duplicado).');
      return;
    }
    seen.add(key);
    actions.push(r.action);
  });
  if (!actions.length && !rejected.length) return null;
  return { version: v2 ? 2 : 1, actions, rejected, notices: [...new Set(notices)], raw: src.raw };
}

/* ------------------------------------------------------------------ */
/* Destinos financeiros                                                */
/* ------------------------------------------------------------------ */

export interface FinanceTarget { id: string; title: string; data: FinanceData; via: 'context' | 'execution' }

/**
 * Blocos de Finanças em que a IA pode propor lançamentos: os do contexto autorizado e os ligados ao
 * assistente por conexão de execução (mesma regra das tarefas). Nenhum outro bloco é alcançável.
 */
export function financeTargets(elements: AuroraElement[], aiId: string, validIds: ReadonlySet<string>): FinanceTarget[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Map<string, FinanceTarget>();
  const add = (id: string, via: FinanceTarget['via']) => {
    const el = byId.get(id);
    if (!el || el.type !== 'widget' || el.widgetType !== WIDGET.finance || out.has(id)) return;
    out.set(id, { id, title: el.title, data: sanitizeFinance(el.data), via });
  };
  for (const id of validIds) add(id, 'context');
  for (const e of elements) {
    if (isLinear(e) && e.connection.kind === 'execution' && e.startBinding?.elementId === aiId && e.endBinding) add(e.endBinding.elementId, 'execution');
  }
  return [...out.values()];
}

export type Destination = { kind: 'value' } | { kind: 'entry'; targetId: string } | { kind: 'new-finance' };
export const destinationKey = (d: Destination) => (d.kind === 'entry' ? `entry:${d.targetId}` : d.kind);
export function destinationFromKey(key: string): Destination | null {
  if (key === 'value' || key === 'new-finance') return { kind: key };
  if (key.startsWith('entry:') && key.length > 6) return { kind: 'entry', targetId: key.slice(6) };
  return null;
}

export interface DestinationOption { key: string; dest: Destination; label: string; disabled: boolean; reason?: string }

export function destinationOptions(a: MoneyAction, targets: FinanceTarget[]): DestinationOption[] {
  const opts: DestinationOption[] = [];
  const valueBlocked = a.installments > 1 ? 'bloco de valor não tem parcelas' : undefined;
  opts.push({ key: 'value', dest: { kind: 'value' }, label: 'Novo bloco de valor (aurora.value)', disabled: !!valueBlocked, reason: valueBlocked });
  for (const t of targets) {
    const reason = a.role === 'neutral' ? 'lançamento precisa ser receita ou despesa' : a.currency && a.currency !== t.data.currency ? `moeda ${a.currency} ≠ ${t.data.currency} do bloco (sem conversão)` : undefined;
    opts.push({ key: `entry:${t.id}`, dest: { kind: 'entry', targetId: t.id }, label: `Lançamento em “${t.title}” (aurora.finance)`, disabled: !!reason, reason });
  }
  const nfBlocked = a.role === 'neutral' ? 'lançamento precisa ser receita ou despesa' : undefined;
  opts.push({ key: 'new-finance', dest: { kind: 'new-finance' }, label: 'Novo bloco de Finanças com este lançamento', disabled: !!nfBlocked, reason: nfBlocked });
  return opts;
}

/**
 * Destino pré-selecionado, ou null quando o usuário precisa escolher (ambiguidade relevante):
 * IA declarou ambiguidade, lançamento sem destino com 0 ou 2+ blocos possíveis, ou destino fora dos permitidos.
 */
export function suggestedDestination(a: MoneyAction, targets: FinanceTarget[]): Destination | null {
  if (a.ambiguous) return null;
  const enabled = new Set(destinationOptions(a, targets).filter((o) => !o.disabled).map((o) => o.key));
  if (a.origin === 'create_value') return enabled.has('value') ? { kind: 'value' } : null;
  if (a.target) return enabled.has(`entry:${a.target}`) ? { kind: 'entry', targetId: a.target } : null;
  const usable = targets.filter((t) => enabled.has(`entry:${t.id}`));
  return usable.length === 1 ? { kind: 'entry', targetId: usable[0].id } : null;
}

/** Aviso quando a IA citou um bloco de Finanças que não é um destino permitido. */
export function targetWarning(a: MoneyAction, targets: FinanceTarget[]): string | null {
  if (a.origin !== 'add_finance_entry' || !a.target || targets.some((t) => t.id === a.target)) return null;
  return 'O bloco de Finanças indicado pela IA não está no contexto autorizado nem ligado por execução — escolha o destino.';
}

export const ROLE_TITLE: Record<FinancialRole, string> = { income: 'Receita', expense: 'Despesa', neutral: 'Valor' };

export interface ResolvedMoney {
  dest: Destination;
  currency: Currency;
  /** Linha principal da prévia/confirmação. */
  effect: string;
  /** Campos preenchidos com o padrão do sistema (exibidos). */
  defaults: string[];
  warnings: string[];
  errors: string[];
  valueData?: ValueTileData;
  valueTitle?: string;
  entry?: FinanceEntry;
  target?: FinanceTarget;
}

/**
 * Chave da marca “aplicada” (AIData.applied). Limitada a 126 caracteres: ids de mensagem vêm de quadros importados
 * e `sanitizeAI` descarta chaves longas — sem o limite, a marca se perderia e a proposta poderia ser reaplicada.
 */
export function proposalKey(messageId: string, origin: 'ai' | 'local'): string {
  return `${messageId.slice(0, 120)}${origin === 'local' ? ':local' : ''}`;
}

/** Identificador determinístico do lançamento criado pela ação (impede aplicar duas vezes no mesmo bloco). */
export function aiEntryId(messageId: string, index: number) {
  return `ai-${messageId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-${index}`;
}

const sameText = (a: string, b: string) => normalizeName(a.trim()) === normalizeName(b.trim());

/**
 * Bloco de valor já existente com o mesmo papel, valor e moeda. Cobre a duplicidade ENTRE mensagens
 * (ex.: interpretação local numa resposta e a mesma ação vinda da IA na resposta seguinte).
 */
export function equalValueTile(a: MoneyAction, currency: Currency, elements: AuroraElement[]): WidgetElement | null {
  for (const e of elements) {
    if (e.type !== 'widget' || e.widgetType !== WIDGET.value) continue;
    const d = sanitizeValue(e.data);
    if (d.valueType === 'money' && d.financialRole === a.role && d.amountCents === a.amountCents && d.currency === currency) return e;
  }
  return null;
}

export function resolveMoney(a: MoneyAction, dest: Destination, targets: FinanceTarget[], entryId: string, elements?: AuroraElement[]): ResolvedMoney {
  const defaults: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const opt = destinationOptions(a, targets).find((o) => o.key === destinationKey(dest));
  if (!opt) errors.push('Destino não permitido.');
  else if (opt.disabled) errors.push(`Destino indisponível: ${opt.reason}.`);
  if (!a.roleGiven) defaults.push('Classificação: Neutro (padrão do sistema)');

  if (dest.kind === 'value') {
    const currency = a.currency ?? 'BRL';
    if (!a.currency) defaults.push('Moeda: BRL (padrão do sistema)');
    const title = a.title || ROLE_TITLE[a.role];
    if (!a.title) defaults.push(`Título: “${title}” (padrão do tipo)`);
    const period = a.period || (a.date ? a.date.slice(0, 7) : '');
    if (!a.period && a.date) warnings.push(`A data ${a.date} vira a competência ${periodLabel(period)} (bloco de valor não guarda dia).`);
    if (!period) defaults.push('Competência: do mês conectado (padrão)');
    if (!a.category) defaults.push('Categoria: nenhuma');
    if (a.paid) warnings.push('“Pago” não se aplica a bloco de valor e será ignorado.');
    const dup = elements ? equalValueTile(a, currency, elements) : null;
    if (dup) warnings.push(`Já existe bloco de valor igual no quadro (“${dup.title}”, ${formatMoney(a.amountCents, currency)}) — confira se não é duplicado.`);
    const valueData = createValueData({ valueType: 'money', currency, amountCents: a.amountCents, financialRole: a.role, period, category: a.category, note: a.note });
    return {
      dest, currency, defaults, warnings, errors, valueData, valueTitle: title,
      effect: `Cria bloco de valor “${title}” (aurora.value): ${ROLE_LABEL[a.role]} de ${formatMoney(a.amountCents, currency)}`,
    };
  }

  const target = dest.kind === 'entry' ? targets.find((t) => t.id === dest.targetId) : undefined;
  if (dest.kind === 'entry' && !target) errors.push('O bloco de Finanças de destino não existe mais.');
  const currency = a.currency ?? target?.data.currency ?? 'BRL';
  if (!a.currency) defaults.push(target ? `Moeda: ${currency} (do bloco de destino)` : 'Moeda: BRL (padrão do sistema)');
  if (!a.date) {
    if (a.period) warnings.push(`A competência ${periodLabel(a.period)} não vira data: o lançamento fica sem vencimento.`);
    defaults.push('Data: sem vencimento (aparece só em “Todo o período”)');
  }
  if (!a.category) defaults.push('Categoria: Sem categoria');
  if (!a.title) defaults.push('Descrição: vazia');
  if (!a.paid) defaults.push('Situação: não pago/recebido');
  const kind = a.role === 'income' ? 'income' : 'expense';
  const entry: FinanceEntry = {
    id: entryId, description: a.title, amountCents: a.amountCents, kind, category: a.category, date: a.date, paid: a.paid,
    installments: a.installments, installmentMode: a.installmentMode,
  };
  const sign = kind === 'income' ? '+' : '−';
  const money = formatMoney(a.amountCents, currency);
  const parcel = a.installments > 1 ? ` em ${a.installments} parcelas (${a.installmentMode === 'split' ? 'total dividido' : 'valor por parcela'})` : '';
  if (dest.kind === 'new-finance' || !target) {
    return { dest, currency, defaults, warnings, errors, entry, effect: `Cria bloco de Finanças com lançamento de ${ROLE_LABEL[a.role].toLowerCase()} ${sign}${money}${parcel}` };
  }
  if (target.data.entries.some((e) => e.id === entryId)) errors.push(`Este lançamento já foi aplicado em “${target.title}”.`);
  else if (target.data.entries.some((e) => e.kind === kind && e.amountCents === a.amountCents && e.date === a.date && sameText(e.description, a.title)))
    warnings.push(`Já existe lançamento igual em “${target.title}” — confira se não é duplicado.`);
  const before = computeFinance({ ...target.data, period: 'all' }).summary.balanceCents;
  const after = computeFinance({ ...target.data, period: 'all', entries: [...target.data.entries, entry] }).summary.balanceCents;
  return {
    dest, currency, defaults, warnings, errors, entry, target,
    effect: `Adiciona ${ROLE_LABEL[a.role].toLowerCase()} ${sign}${money}${parcel} em “${target.title}” — saldo previsto ${formatMoney(before, currency)} → ${formatMoney(after, currency)}`,
  };
}

/* ------------------------------------------------------------------ */
/* Plano de aplicação (uma única entrada de histórico)                 */
/* ------------------------------------------------------------------ */

export interface WidgetDataUpdate { id: string; update: (raw: unknown) => unknown }
export interface ApplyPlan { add: AuroraElement[]; updates: WidgetDataUpdate[]; lines: string[]; warnings: string[]; financial: boolean }

export interface PlanInput {
  actions: ProposedAction[];
  include: boolean[];
  destinations: (Destination | null)[];
  elements: AuroraElement[];
  ai: WidgetElement;
  /** Chave de aplicação (id da mensagem; ":local" para a interpretação local). */
  applyKey: string;
  validIds: ReadonlySet<string>;
}

/**
 * Revalida tudo contra o estado ATUAL do quadro e monta o plano. Não altera nada.
 * Inclui a marca “proposta aplicada” no próprio bloco de IA, na mesma alteração: desfazer remove
 * os elementos e a marca juntos; refazer devolve os dois.
 */
export function buildApplyPlan(p: PlanInput): { ok: true; plan: ApplyPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (sanitizeAI(p.ai.data).applied[p.applyKey]) return { ok: false, errors: ['Esta proposta já foi aplicada.'] };
  const byId = new Map(p.elements.map((e) => [e.id, e]));
  const targets = financeTargets(p.elements, p.ai.id, p.validIds);
  const add: AuroraElement[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  const entriesByTarget = new Map<string, FinanceEntry[]>();
  let financial = false;
  const x0 = p.ai.x + p.ai.width + 60;
  let y = p.ai.y;
  const place = (h: number) => { const at = y; y += h + 20; return at; };

  p.actions.forEach((a, i) => {
    if (!p.include[i]) return;
    if (a.type === 'note') {
      const w = createWidget(WIDGET.notes, '1.0.0', a.title, x0, place(220), 320, 220, { markdown: a.content, mode: 'preview' });
      w.style.strokeColor = '#f3c577';
      add.push(w);
      lines.push(`Nota “${a.title}”`);
    } else if (a.type === 'tasks') {
      const t = createWidget(WIDGET.tasks, '1.0.0', a.title, x0, place(300), 320, 300, appendTasks(sanitizeTasks({}), a.tasks));
      t.style.strokeColor = '#5addaa';
      add.push(t);
      lines.push(`Lista “${a.title}” com ${a.tasks.length} tarefa(s)`);
    } else if (a.type === 'connect') {
      if (!byId.has(a.from) || !byId.has(a.to) || !p.validIds.has(a.from) || !p.validIds.has(a.to)) {
        errors.push('Uma conexão cita bloco que não existe mais ou saiu do contexto autorizado.');
        return;
      }
      const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: '#8fa6c8' }, 'visual');
      l.startBinding = { elementId: a.from, fixedPoint: null };
      l.endBinding = { elementId: a.to, fixedPoint: null };
      l.text = a.label;
      l.connection.relation = 'sugerida pela IA';
      add.push(resolveLinear(l, byId));
      lines.push(`Conexão ${titleOf(byId.get(a.from))} → ${titleOf(byId.get(a.to))}`);
    } else {
      financial = true;
      const dest = p.destinations[i];
      if (!dest) {
        errors.push('Escolha o destino de cada valor financeiro.');
        return;
      }
      const r = resolveMoney(a, dest, targets, aiEntryId(p.applyKey, i), p.elements);
      if (r.errors.length) {
        errors.push(...r.errors);
        return;
      }
      lines.push(r.effect);
      warnings.push(...r.warnings);
      if (dest.kind === 'value') {
        const w = createWidget(WIDGET.value, '1.0.0', r.valueTitle!, x0, place(VALUE_SIZES.normal.height), VALUE_SIZES.normal.width, VALUE_SIZES.normal.height, r.valueData);
        w.style.strokeColor = '#8fb4ff';
        add.push(w);
      } else if (dest.kind === 'new-finance') {
        const f = createWidget(WIDGET.finance, '1.0.0', 'Finanças', x0, place(420), 360, 420, { ...emptyFinance(r.currency), entries: [r.entry!] });
        f.style.strokeColor = '#5addaa';
        add.push(f);
      } else {
        const list = entriesByTarget.get(dest.targetId) ?? [];
        list.push(r.entry!);
        entriesByTarget.set(dest.targetId, list);
      }
    }
  });

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const updates: WidgetDataUpdate[] = [...entriesByTarget].map(([id, entries]) => ({
    id,
    // Reaplicação defensiva: ids já presentes no bloco não são inseridos de novo.
    update: (raw) => {
      const d = sanitizeFinance(raw);
      const have = new Set(d.entries.map((e) => e.id));
      return { ...d, entries: [...d.entries, ...entries.filter((e) => !have.has(e.id))] };
    },
  }));
  if (!add.length && !updates.length) return { ok: false, errors: ['Nenhuma ação selecionada.'] };
  updates.push({ id: p.ai.id, update: (raw) => { const d = sanitizeAI(raw); return { ...d, applied: { ...d.applied, [p.applyKey]: Date.now() } }; } });
  return { ok: true, plan: { add, updates, lines, warnings: [...new Set(warnings)], financial } };
}

function titleOf(el: AuroraElement | undefined): string {
  if (!el) return '?';
  if (el.type === 'widget') return `“${el.title}”`;
  const t = el.text.trim().split('\n')[0];
  return t ? `“${t.slice(0, 40)}”` : el.type;
}

/* ------------------------------------------------------------------ */
/* Interpretação local do pedido (conferência independente do modelo)  */
/* ------------------------------------------------------------------ */

export interface FinancialRequest {
  role: 'income' | 'expense' | null;
  /** Centavos do único valor monetário citado (null se nenhum ou mais de um). */
  amountCents: number | null;
  currency: Currency | null;
  /** 'value' = bloco independente; 'entry' = lançamento em Finanças; null = não dá para saber. */
  intent: 'value' | 'entry' | null;
}

const MONEY_RE = /(R\$|US\$|€)?\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+\.\d{1,2}|\d+)(?:\s?(reais|real|d[óo]lares|euros)(?!\p{L}))?/giu;

/** "2.000,00" → 200000; "2000.5" → 200050; "2.000" → 200000. Inteiros apenas, sem ponto flutuante. */
export function localizedAmountToCents(s: string): number | null {
  let int: string, frac = '';
  if (s.includes(',')) [int, frac] = [s.slice(0, s.lastIndexOf(',')).replace(/\./g, ''), s.slice(s.lastIndexOf(',') + 1)];
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) int = s.replace(/\./g, '');
  else if (s.includes('.')) [int, frac] = s.split('.');
  else int = s;
  if (!/^\d{1,13}$/.test(int) || !/^\d{0,2}$/.test(frac)) return null;
  return Number(BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2)));
}

const word = (w: string) => new RegExp(`(?<!\\p{L})(?:${w})(?!\\p{L})`, 'iu');
const INCOME_RE = word('receitas?|entradas?|ganhos?|rendas?|recebimentos?|sal[áa]rios?');
const EXPENSE_RE = word('despesas?|gastos?|sa[íi]das?|custos?');
const ENTRY_RE = word('lan[çc]amentos?|lan[çc]ar|lance|lan[çc]e|finan[çc]as');
const BLOCK_RE = word('blocos?|cards?|cart[ãa]o|tiles?');

/** Lê um pedido financeiro simples. Null quando o texto não fala de receita/despesa nem de dinheiro. */
export function interpretFinancialRequest(text: string): FinancialRequest | null {
  const t = text.slice(0, 2000);
  const income = INCOME_RE.test(t), expense = EXPENSE_RE.test(t);
  const amounts: { cents: number; currency: Currency }[] = [];
  for (const m of t.matchAll(MONEY_RE)) {
    if (!m[1] && !m[3]) continue; // número sem moeda (parcelas, datas…) não é dinheiro
    const cents = localizedAmountToCents(m[2]);
    if (cents === null) continue;
    const mark = (m[1] ?? m[3] ?? '').toLowerCase();
    const currency: Currency = mark === 'us$' || mark.startsWith('d') ? 'USD' : mark === '€' || mark === 'euros' ? 'EUR' : 'BRL';
    amounts.push({ cents, currency });
  }
  if (!income && !expense && !amounts.length) return null;
  const distinct = new Set(amounts.map((a) => `${a.cents}:${a.currency}`));
  const one = distinct.size === 1 ? amounts[0] : null;
  return {
    role: income === expense ? null : income ? 'income' : 'expense',
    amountCents: one ? one.cents : null,
    currency: one ? one.currency : null,
    intent: ENTRY_RE.test(t) ? 'entry' : BLOCK_RE.test(t) ? 'value' : null,
  };
}

/** Ação derivada só do pedido do usuário — usada quando a IA não propôs nenhuma ação financeira. */
export function localMoneyAction(req: FinancialRequest | null): MoneyAction | null {
  if (!req || !req.role || req.amountCents === null || req.amountCents === 0 || !req.intent) return null;
  return {
    type: 'money', origin: req.intent === 'entry' ? 'add_finance_entry' : 'create_value', role: req.role, roleGiven: true, amountCents: req.amountCents,
    currency: req.currency, title: '', category: '', period: '', date: '', note: '', paid: false, installments: 1, installmentMode: 'split', target: null, ambiguous: false,
  };
}

/** Avisos quando a ação da IA diverge do que o usuário pediu (valor, moeda ou tipo). */
export function crossCheck(a: MoneyAction, req: FinancialRequest | null): string[] {
  if (!req) return [];
  const out: string[] = [];
  if (req.amountCents !== null && req.amountCents !== a.amountCents)
    out.push(`Valor diferente do pedido: você escreveu ${formatMoney(req.amountCents, req.currency ?? 'BRL')}, a IA propôs ${formatMoney(a.amountCents, a.currency ?? req.currency ?? 'BRL')}.`);
  if (req.currency && a.currency && req.currency !== a.currency) out.push(`Moeda diferente do pedido: ${req.currency} ≠ ${a.currency}.`);
  if (req.role && a.role !== req.role) out.push(`Classificação diferente do pedido: ${ROLE_LABEL[req.role]} ≠ ${ROLE_LABEL[a.role]}.`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Instruções para o modelo                                            */
/* ------------------------------------------------------------------ */

export const ACTIONS_PROMPT = [
  'Quando o usuário pedir para criar blocos, organizar tarefas, propor conexões ou registrar valores financeiros, além da explicação inclua AO FINAL um único bloco ```json no formato {"version":2,"actions":[...]}. Ações permitidas:',
  '- {"type":"create_note","title":"...","content":"markdown"}',
  '- {"type":"create_tasks","title":"...","tasks":[{"text":"...","priority":"low|medium|high"}]}',
  '- {"type":"connect","from":"<id do contexto>","to":"<id do contexto>","label":"..."}',
  '- {"type":"create_value","role":"income|expense|neutral","currency":"BRL|USD|EUR","amount":"2000.00","title":"...","period":"AAAA-MM","category":"...","note":"..."} — cria um bloco de valor independente (aurora.value).',
  '- {"type":"add_finance_entry","target":"<id de um bloco aurora.finance do contexto>","kind":"income|expense","currency":"BRL|USD|EUR","amount":"2000.00","description":"...","date":"AAAA-MM-DD","category":"...","paid":false,"installments":1,"installmentMode":"split|repeat"} — adiciona um lançamento a um bloco de Finanças existente.',
  'Regras para dinheiro: "amount" é TEXTO decimal com ponto, no máximo 2 casas e sem separador de milhar (R$ 2.000,00 → "2000.00"). Receita = "income", despesa = "expense". R$ = "BRL".',
  '"Crie um bloco de receita/despesa/valor" → create_value (não use create_note para valores). "Lance/adicione nas finanças" → add_finance_entry. Se não estiver claro se é bloco independente ou lançamento, use create_value com "ambiguous":true: o usuário escolhe o destino.',
  'Omita os campos que o usuário não informou (título, data, competência, categoria, descrição): não invente dados. Use em "target" e "connect" apenas ids que aparecem no contexto.',
  'Exemplo — "Crie um bloco de receita de R$ 2.000,00" → {"version":2,"actions":[{"type":"create_value","role":"income","currency":"BRL","amount":"2000.00"}]}',
  'Não peça confirmação em texto e não pergunte "Confirma?": a interface do Aurora Board mostra a prévia e pede a confirmação do usuário antes de criar ou alterar qualquer coisa. Inclua o bloco json já nesta resposta, sempre entre ```json e ```.',
].join('\n');
