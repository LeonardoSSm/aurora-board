/**
 * Aurora Command Center (issue #14) — busca local, pura e testável: normalização PT-BR, extração do que pode ser
 * buscado em cada elemento (com exclusões de privacidade), pontuação e trechos.
 *
 * PRIVACIDADE (primeiro ciclo): nunca entram no índice o razão bancário, transações/cartões, valores de blocos
 * financeiros, conversas/prompts/respostas de IA, HTML/JS de sandbox, URLs de documentos/assets, tokens e
 * credenciais. Desses tipos indexa-se no máximo o TÍTULO do próprio bloco, e o resultado informa que o conteúdo
 * não é pesquisável. O índice vive só em memória (nada é gravado), e nenhuma consulta sai do navegador.
 */
import type { AuroraElement } from './schema';
import { WIDGET } from './widgetIds';
import { displayLabel, sanitizeVisual } from './smartLinks';

/** Minúsculas, sem acentos, espaços colapsados. “Ação” ≡ “acao”. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function terms(query: string): string[] {
  return [...new Set(normalize(query).split(' ').filter(Boolean))].slice(0, 8);
}

export type DocKind = 'board' | 'checkpoint' | 'element' | 'task';

export interface SearchDoc {
  /** Chave única: `<kind>:<boardId>:<id>` (nunca mistura ids de quadros diferentes). */
  key: string;
  kind: DocKind;
  boardId: string;
  workspaceId: string;
  /** Id do elemento/checkpoint (para quadro, o próprio id do quadro). */
  id: string;
  title: string;
  /** Texto pesquisável além do título (já sem dados sensíveis). */
  body: string;
  /** Rótulo do tipo exibido no resultado (“Nota”, “Tarefas”, “Texto”…). */
  typeLabel: string;
  /** Filtro de tipo da paleta. */
  filter: SearchFilter;
  /** O conteúdo deste tipo não é pesquisável por privacidade (só o título). */
  contentHidden?: boolean;
  /** Para recência. */
  updatedAt: number;
  /** Para tarefas: status (todo/doing/done). */
  status?: string;
}

export type SearchFilter = 'all' | 'boards' | 'places' | 'notes' | 'tasks' | 'code' | 'other';
export const FILTER_LABEL: Record<SearchFilter, string> = { all: 'Tudo', boards: 'Quadros', places: 'Locais', notes: 'Notas e textos', tasks: 'Tarefas', code: 'Código', other: 'Outros' };

const MAX_BODY = 4000;
const clip = (s: string) => (s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s);
/**
 * URLs saem INTEIRAS antes de qualquer troca de pontuação: trocar `-`, `_`, `#`… por espaço antes partia a URL e
 * deixava o resto (ex.: `access_token=…`) pesquisável e visível no trecho (apontamento do PR #18). Cobre
 * qualquer esquema (`https:`, `ftp:`, `mailto:`, `data:`…) e endereços `www.`.
 */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|data:|www\.)[^\s<>"'`]+/gi;
export const stripUrls = (s: string) => s.replace(URL_RE, ' ');
const stripMarkdown = (md: string) => stripUrls(md.replace(/```[\s\S]*?```/g, ' ')).replace(/[#>*_`~\-[\]()!|]/g, ' ');

/** Widgets cujo conteúdo NUNCA é indexado (privacidade): só o título. */
export const CONTENT_EXCLUDED = new Set<string>([
  WIDGET.ai, WIDGET.aiTile, WIDGET.sandbox, WIDGET.bankQuery, WIDGET.finance, WIDGET.financePeriod, WIDGET.value, WIDGET.formula, WIDGET.chart,
]);

const STATUS_LABEL: Record<string, string> = { todo: 'a fazer', doing: 'em andamento', done: 'concluída' };

/** Documentos pesquisáveis de um elemento (0, 1 ou vários: cada tarefa vira um resultado próprio). */
export function elementDocs(el: AuroraElement, boardId: string, workspaceId: string, widgetName: (type: string) => string): SearchDoc[] {
  const base = { boardId, workspaceId, updatedAt: el.updatedAt ?? 0 };
  const key = (k: DocKind, id: string) => `${k}:${boardId}:${id}`;
  switch (el.type) {
    case 'text':
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
    case 'sticky':
    case 'frame': {
      const text = (el as { text?: string }).text ?? '';
      const name = el.type === 'frame' ? ((el as { name?: string }).name ?? '') : '';
      if (!text.trim() && !name.trim()) return [];
      const label = el.type === 'sticky' ? 'Nota adesiva' : el.type === 'text' ? 'Texto' : el.type === 'frame' ? 'Frame' : 'Forma';
      const first = (name || text).split('\n')[0].slice(0, 80);
      return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title: first, body: clip(`${name}\n${text}`), typeLabel: label, filter: 'notes' }];
    }
    case 'arrow':
    case 'line': {
      const text = (el as { text?: string }).text ?? '';
      const rel = (el as { connection?: { relation?: string } }).connection?.relation ?? '';
      if (!text.trim() && !rel.trim()) return [];
      return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title: (text || rel).slice(0, 80), body: clip(`${text}\n${rel}`), typeLabel: 'Conexão', filter: 'other' }];
    }
    case 'widget': {
      const w = el as Extract<AuroraElement, { type: 'widget' }>;
      const type = w.widgetType;
      const title = w.title || widgetName(type);
      const label = widgetName(type);
      const data = (w.data ?? {}) as Record<string, unknown>;
      if (CONTENT_EXCLUDED.has(type)) {
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: '', typeLabel: label, filter: 'other', contentHidden: true }];
      }
      if (type === WIDGET.notes) {
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: clip(stripMarkdown(String(data.markdown ?? ''))), typeLabel: label, filter: 'notes' }];
      }
      if (type === WIDGET.tasks) {
        const items = Array.isArray(data.items) ? (data.items as { id?: unknown; text?: unknown; status?: unknown; dueDate?: unknown }[]) : [];
        const out: SearchDoc[] = [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: '', typeLabel: label, filter: 'tasks' }];
        for (const it of items.slice(0, 500)) {
          const text = typeof it.text === 'string' ? it.text : '';
          if (!text.trim() || typeof it.id !== 'string') continue;
          const status = typeof it.status === 'string' ? it.status : 'todo';
          out.push({ ...base, key: key('task', `${el.id}/${it.id}`), kind: 'task', id: el.id, title: text.slice(0, 120), body: clip(`${text}\n${STATUS_LABEL[status] ?? ''}\n${typeof it.dueDate === 'string' ? it.dueDate : ''}`), typeLabel: `Tarefa · ${STATUS_LABEL[status] ?? status}`, filter: 'tasks', status });
        }
        return out;
      }
      if (type === WIDGET.code) {
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: clip(`${String(data.language ?? '')}\n${String(data.code ?? '')}`), typeLabel: label, filter: 'code' }];
      }
      if (type === WIDGET.documents) {
        // Só metadados (nome, descrição, etiquetas) — nunca o conteúdo nem a URL do arquivo.
        const docs = Array.isArray(data.docs) ? (data.docs as { name?: unknown; description?: unknown; tags?: unknown }[]) : [];
        const meta = docs.slice(0, 200).map((d) => `${typeof d.name === 'string' ? d.name : ''} ${typeof d.description === 'string' ? d.description : ''} ${Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string').join(' ') : ''}`).join('\n');
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: clip(meta), typeLabel: label, filter: 'other' }];
      }
      if (type === WIDGET.calendar) {
        const ev = Array.isArray(data.events) ? (data.events as { title?: unknown; date?: unknown }[]) : [];
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: clip(ev.slice(0, 300).map((e) => `${typeof e.title === 'string' ? e.title : ''} ${typeof e.date === 'string' ? e.date : ''}`).join('\n')), typeLabel: label, filter: 'other' }];
      }
      if (type === WIDGET.link) {
        let host = '';
        try { host = new URL(String(data.url ?? '')).hostname; } catch { /* sem URL válida */ }
        // Issue #22: nome exibido do atalho como título; corpo só domínio + descrição — nunca a URL completa.
        const shown = displayLabel(w.title, String(data.url ?? ''), sanitizeVisual(data.visual));
        return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title: shown, body: clip(`${host}\n${String(data.description ?? '')}`), typeLabel: label, filter: 'other' }];
      }
      // Widgets de terceiros e futuros: só o título (conteúdo desconhecido não é indexado por padrão).
      return [{ ...base, key: key('element', el.id), kind: 'element', id: el.id, title, body: '', typeLabel: label, filter: 'other', contentHidden: true }];
    }
    default:
      return [];
  }
}

export interface Match { doc: SearchDoc; score: number }

/**
 * Todos os termos precisam aparecer (título ou corpo). Pontuação: título > início de palavra > corpo; bônus de
 * recência leve (até 1 ponto nos últimos 30 dias) e tipo (quadros e locais um pouco à frente).
 */
export function scoreDoc(doc: SearchDoc, ts: string[], normTitle: string, normBody: string, now = Date.now()): number {
  if (!ts.length) return 0;
  let score = 0;
  for (const t of ts) {
    const inTitle = normTitle.indexOf(t);
    const inBody = inTitle < 0 ? normBody.indexOf(t) : -1;
    if (inTitle < 0 && inBody < 0) return -1;
    if (inTitle >= 0) {
      score += 10;
      if (inTitle === 0) score += 4;
      else if (normTitle[inTitle - 1] === ' ') score += 2;
      if (normTitle === t) score += 6;
    } else {
      score += 3;
      if (inBody === 0 || /[\s\n]/.test(normBody[inBody - 1] ?? ' ')) score += 1;
    }
  }
  const ageDays = Math.max(0, (now - doc.updatedAt) / 86_400_000);
  score += Math.max(0, 1 - ageDays / 30);
  if (doc.kind === 'board') score += 2;
  if (doc.kind === 'checkpoint') score += 1.5;
  return score;
}

export interface Snippet { before: string; hit: string; after: string }

/** Trecho curto ao redor do primeiro termo encontrado no corpo (texto puro: a interface escapa ao renderizar). */
export function snippet(body: string, ts: string[], radius = 42): Snippet | null {
  if (!body || !ts.length) return null;
  // Índices na string normalizada coincidem com os da original quando a normalização só remove diacríticos
  // combinantes; por segurança, buscamos na versão normalizada caractere a caractere.
  const flat = body.replace(/\s+/g, ' ');
  const map: number[] = [];
  let norm = '';
  for (let i = 0; i < flat.length; i++) {
    const n = flat[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
  }
  for (const t of ts) {
    const at = norm.indexOf(t);
    if (at < 0) continue;
    const s = map[at], e = (map[at + t.length - 1] ?? s) + 1;
    const from = Math.max(0, s - radius), to = Math.min(flat.length, e + radius);
    return { before: (from > 0 ? '…' : '') + flat.slice(from, s), hit: flat.slice(s, e), after: flat.slice(e, to) + (to < flat.length ? '…' : '') };
  }
  return null;
}

/** Recentes: só o que ainda existe no índice; sem duplicatas; no máximo `max`. */
export interface RecentRef { key: string; at: number }
export function sanitizeRecents(raw: unknown, max = 12): RecentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const key = (r as RecentRef).key, at = (r as RecentRef).at;
    if (typeof key !== 'string' || key.length > 300 || !/^(board|checkpoint|element|task):/.test(key) || typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (out.some((x) => x.key === key)) continue;
    out.push({ key, at });
    if (out.length >= max) break;
  }
  return out;
}
export function pushRecent(list: RecentRef[], key: string, now = Date.now(), max = 12): RecentRef[] {
  return [{ key, at: now }, ...list.filter((r) => r.key !== key)].slice(0, max);
}
