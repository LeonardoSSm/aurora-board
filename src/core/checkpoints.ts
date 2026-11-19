/**
 * Checkpoints espaciais: pontos nomeados em coordenadas do MUNDO, por quadro.
 * Ficam nos metadados do quadro (`board.checkpoints`), nunca em `elements`: não entram em seleção,
 * Ctrl+A, Enquadrar tudo, fluxo de dados, fórmulas nem exportação de imagem.
 */
import { z } from 'zod';
import { MAX_ZOOM, MIN_ZOOM } from './camera';

export const CHECKPOINT_LIMITS = { name: 60, description: 280, max: 500 };
export const CHECKPOINT_ICONS = ['pin', 'flag', 'star', 'wallet', 'building', 'rocket', 'lightbulb', 'plane', 'book', 'bot'] as const;
export type CheckpointIcon = (typeof CHECKPOINT_ICONS)[number];
export const CHECKPOINT_COLORS = ['#8f9bff', '#5addaa', '#f3c577', '#fb8590', '#6ca7ff', '#b998ff', '#63d7dd', '#f59abf'];

const finite = z.number().refine(Number.isFinite, 'coordenada inválida');

export const CheckpointSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(CHECKPOINT_LIMITS.name),
  description: z.string().max(CHECKPOINT_LIMITS.description).default(''),
  x: finite.refine((v) => Math.abs(v) <= 1e9),
  y: finite.refine((v) => Math.abs(v) <= 1e9),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#8f9bff'),
  icon: z.enum(CHECKPOINT_ICONS).default('pin'),
  /** Zoom memorizado (opcional). */
  savedZoom: z.number().min(MIN_ZOOM).max(MAX_ZOOM).nullable().default(null),
  /** Navegar restaura `savedZoom` (desligado = mantém o zoom atual). */
  restoreZoom: z.boolean().default(false),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
});
export type SpatialCheckpoint = z.infer<typeof CheckpointSchema>;

/**
 * Saneia checkpoints importados/antigos um a um: inválidos são descartados com aviso (sem derrubar
 * o quadro), textos longos são cortados, ícone/cor desconhecidos viram padrão, ids repetidos são renomeados.
 */
export function sanitizeCheckpoints(raw: unknown, newId: () => string): { checkpoints: SpatialCheckpoint[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: SpatialCheckpoint[] = [];
  const seen = new Set<string>();
  if (raw !== undefined && !Array.isArray(raw)) return { checkpoints: [], warnings: ['Lista de checkpoints inválida ignorada.'] };
  for (const item of (raw as unknown[] | undefined) ?? []) {
    if (out.length >= CHECKPOINT_LIMITS.max) { warnings.push(`Mais de ${CHECKPOINT_LIMITS.max} checkpoints: excedentes ignorados.`); break; }
    const o = item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : null;
    if (!o) { warnings.push('Checkpoint inválido ignorado.'); continue; }
    if (typeof o.name === 'string') o.name = o.name.trim().slice(0, CHECKPOINT_LIMITS.name);
    if (typeof o.description === 'string') o.description = o.description.slice(0, CHECKPOINT_LIMITS.description);
    if (typeof o.icon !== 'string' || !(CHECKPOINT_ICONS as readonly string[]).includes(o.icon)) delete o.icon;
    if (typeof o.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.color)) delete o.color;
    if (typeof o.savedZoom !== 'number' || !Number.isFinite(o.savedZoom)) o.savedZoom = null;
    else o.savedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, o.savedZoom));
    if (typeof o.id !== 'string' || !o.id) o.id = newId();
    const r = CheckpointSchema.safeParse(o);
    if (!r.success) { warnings.push(`Checkpoint “${String(o.name ?? '')}” inválido ignorado (${r.error.issues[0]?.path.join('.') || 'dados'}).`); continue; }
    const cp = r.data;
    if (seen.has(cp.id)) { cp.id = newId(); warnings.push(`Checkpoint com id repetido renomeado: “${cp.name}”.`); }
    seen.add(cp.id);
    out.push(cp);
  }
  return { checkpoints: out, warnings };
}

export function createCheckpoint(fields: Partial<SpatialCheckpoint> & { name: string; x: number; y: number }, id: string, now = Date.now()): SpatialCheckpoint {
  return CheckpointSchema.parse({ description: '', color: '#8f9bff', icon: 'pin', savedZoom: null, restoreZoom: false, ...fields, id, createdAt: now, updatedAt: now });
}

export type CheckpointPatch = Partial<Omit<SpatialCheckpoint, 'id' | 'createdAt'>>;

/** Aplica uma edição validada; devolve null se o resultado for inválido (ex.: nome vazio). */
export function patchCheckpoint(cp: SpatialCheckpoint, patch: CheckpointPatch, now = Date.now()): SpatialCheckpoint | null {
  const next = { ...cp, ...patch, updatedAt: now };
  if (typeof next.name === 'string') next.name = next.name.trim();
  const r = CheckpointSchema.safeParse(next);
  return r.success ? r.data : null;
}
