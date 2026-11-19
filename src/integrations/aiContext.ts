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
import { summarizeElement } from '../widgets/registry';

export interface ContextSource {
  id: string;
  title: string;
  type: string;
  kind: LinkKind;
  edgeId: string;
  includable: boolean;
  authorized: boolean;
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
    const includable = e.connection.kind === 'context' || e.connection.kind === 'data';
    const prev = out.get(otherId);
    if (prev && prev.includable) continue;
    out.set(otherId, {
      id: otherId,
      title: elementTitle(other),
      type: other.type === 'widget' ? other.widgetType : other.type,
      kind: e.connection.kind,
      edgeId: e.id,
      includable,
      authorized: includable && authorized[otherId] !== false,
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
    let body = summarizeElement(el).trim();
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
    lines.push(
      'Quando o usuário pedir para gerar blocos, organizar tarefas ou propor conexões, além da explicação inclua AO FINAL um único bloco ```json com o formato:',
      '{"notes":[{"title":"...","content":"markdown"}],"tasks":[{"text":"...","priority":"low|medium|high"}],"connections":[{"from":"<id existente>","to":"<id existente>","label":"..."}]}',
      'Use apenas ids que aparecem no contexto para "connections". Listas podem ficar vazias. Nada será criado sem confirmação do usuário.',
    );
  }
  return lines.join('\n\n');
}

const ProposalSchema = z.object({
  notes: z.array(z.object({ title: z.string().max(200), content: z.string().max(20000) })).max(20).default([]),
  tasks: z.array(z.object({ text: z.string().max(500), priority: z.enum(['low', 'medium', 'high']).optional() })).max(100).default([]),
  connections: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(120).optional() })).max(50).default([]),
});
export type AIProposal = z.infer<typeof ProposalSchema>;

/** Extrai a proposta estruturada (último bloco ```json) de uma resposta. */
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
