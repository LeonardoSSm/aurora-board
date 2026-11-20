/**
 * Contexto para IA — somente o que foi explicitamente autorizado.
 *
 * Regras:
 * - Apenas elementos ligados ao bloco de IA por conexões do tipo "context" ou "data" são candidatos.
 * - Cada fonte pode ser desmarcada (data.authorized[id] = false) e então NÃO é enviada.
 * - Conexões "visual" e "execution" nunca enviam conteúdo.
 */
import '../core/zodSetup';
import { z } from 'zod';
import type { AuroraElement, LinkKind } from '../core/schema';
import { isLinear } from '../core/schema';
import { aiPolicyOf, summarizeElement } from '../widgets/registry';
import { WIDGET } from '../core/widgetIds';
import { dataUpstream } from '../core/dataUpstream';
import { ACTIONS_PROMPT } from './aiActions';

export interface ContextSource {
  id: string;
  title: string;
  type: string;
  kind: LinkKind;
  edgeId: string;
  includable: boolean;
  authorized: boolean;
  /** Motivo de não ser enviável (ex.: dados financeiros sem autorização). */
  note?: string;
}

/**
 * Ciclo F1 + issue #11: um bloco cujo valor vem (por conexões de DADOS, direta ou indiretamente) de uma fonte
 * PROTEGIDA sem autorização para IA também não pode ser enviado — senão um Mês, uma Fórmula ou um bloco HTML
 * vazaria o que a fonte protege. Fontes protegidas: Consulta bancária e blocos HTML (saídas só com autorização
 * local) e, desde a issue #24, Dados importados (`aurora.dataset`). Retorna o motivo, ou null.
 */
export function financialTaint(elements: AuroraElement[], id: string): string | null {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const cur of dataUpstream(elements, id)) {
    const el = byId.get(cur);
    if (el?.type !== 'widget') continue;
    if (el.widgetType === WIDGET.bankQuery) {
      const pol = aiPolicyOf(el);
      if (!pol?.allowed) return `Depende de dados bancários sem autorização para IA (“${el.title}”).`;
    } else if (el.widgetType === WIDGET.sandbox) {
      const pol = aiPolicyOf(el);
      if (!pol?.allowed) return `Depende de saídas de um bloco HTML não autorizadas para IA (“${el.title}”).`;
    } else if (el.widgetType === WIDGET.dataset) {
      // Data Hub (issue #24): dados importados são privados; nada derivado deles (fórmula, HTML…) vai à IA.
      const pol = aiPolicyOf(el);
      if (!pol?.allowed) return `Depende de dados importados não autorizados para IA (“${el.title}”).`;
    }
  }
  return null;
}

const MAX_SOURCE_CHARS = 6000;

export function elementTitle(el: AuroraElement): string {
  if (el.type === 'widget') return el.title;
  const t = el.text.trim().split('\n')[0];
  const names: Record<string, string> = { rectangle: 'Retângulo', ellipse: 'Elipse', diamond: 'Losango', sticky: 'Nota adesiva', frame: 'Frame', text: 'Texto', image: 'Imagem', freedraw: 'Desenho', line: 'Linha', arrow: 'Seta' };
  return t ? t.slice(0, 60) : names[el.type] ?? el.type;
}

export function contextSources(elements: AuroraElement[], aiId: string, authorized: Record<string, boolean>): ContextSource[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Map<string, ContextSource>();
  for (const e of elements) {
    if (!isLinear(e) || !e.startBinding || !e.endBinding) continue;
    const a = e.startBinding.elementId, b = e.endBinding.elementId;
    if (a !== aiId && b !== aiId) continue;
    const otherId = a === aiId ? b : a;
    const other = byId.get(otherId);
    if (!other || otherId === aiId) continue;
    const linkOk = e.connection.kind === 'context' || e.connection.kind === 'data';
    const prev = out.get(otherId);
    if (prev && prev.includable) continue;
    // Política do próprio bloco (ex.: consulta bancária) e dados derivados de consultas não autorizadas.
    const policy = linkOk ? aiPolicyOf(other) : null;
    const note = linkOk ? (policy && !policy.allowed ? policy.reason ?? 'Conteúdo protegido: não autorizado para IA.' : financialTaint(elements, otherId)) : null;
    const includable = linkOk && !note;
    out.set(otherId, {
      id: otherId,
      title: elementTitle(other),
      type: other.type === 'widget' ? other.widgetType : other.type,
      kind: e.connection.kind,
      edgeId: e.id,
      includable,
      authorized: includable && authorized[otherId] !== false,
      note: note ?? undefined,
    });
  }
  return [...out.values()];
}

export function buildContextText(elements: AuroraElement[], sources: ContextSource[]): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const parts: string[] = [];
  for (const s of sources) {
    if (!s.authorized) continue;
    const el = byId.get(s.id);
    if (!el) continue;
    // Revalida no momento do envio (a autorização pode ter caído depois de listar as fontes).
    const policy = aiPolicyOf(el);
    if (policy && !policy.allowed) continue;
    if (financialTaint(elements, s.id)) continue;
    let body = (policy ? policy.text : summarizeElement(el)).trim();
    if (body.length > MAX_SOURCE_CHARS) body = body.slice(0, MAX_SOURCE_CHARS) + '\n[…conteúdo truncado]';
    parts.push(`### ${s.title}\nid: ${s.id}\ntipo: ${s.type}\n${body || '(vazio)'}`);
  }
  return parts.join('\n\n');
}

export type QuickMode = 'chat' | 'structure';

export function buildSystemPrompt(instruction: string, contextText: string, mode: QuickMode): string {
  const lines = [
    'Você é o assistente do Aurora Board, um quadro branco visual. Responda em português do Brasil, de forma objetiva.',
    'Você só conhece as informações abaixo, que o usuário autorizou explicitamente. Não invente dados que não estejam no contexto.',
  ];
  if (instruction.trim()) lines.push(`Instrução permanente do usuário: ${instruction.trim()}`);
  lines.push(contextText ? `CONTEXTO AUTORIZADO:\n\n${contextText}` : 'CONTEXTO AUTORIZADO: (nenhum bloco conectado/autorizado)');
  if (mode === 'structure') {
    lines.push(ACTIONS_PROMPT);
  }
  return lines.join('\n\n');
}

const ProposalSchema = z.object({
  notes: z.array(z.object({ title: z.string().max(200), content: z.string().max(20000) })).max(20).default([]),
  tasks: z.array(z.object({ text: z.string().max(500), priority: z.enum(['low', 'medium', 'high']).optional() })).max(100).default([]),
  connections: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(120).optional() })).max(50).default([]),
});
export type AIProposal = z.infer<typeof ProposalSchema>;

/**
 * Formato v1 (legado): { notes, tasks, connections }. A interface usa `parseAIProposal` (aiActions.ts),
 * que aceita v1 e v2; esta função fica para compatibilidade de quem já a importa.
 */
export function parseProposal(text: string, validIds: Set<string>): AIProposal | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : null;
  if (!raw) return null;
  try {
    const parsed = ProposalSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const p = parsed.data;
    p.connections = p.connections.filter((c) => validIds.has(c.from) && validIds.has(c.to) && c.from !== c.to);
    if (!p.notes.length && !p.tasks.length && !p.connections.length) return null;
    return p;
  } catch {
    return null;
  }
}

export function stripProposal(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```/g, '').trim();
}
