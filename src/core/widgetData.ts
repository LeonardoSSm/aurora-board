/** Estruturas de dados dos widgets nativos + saneamento (para importação e migração). */
import { uid } from './elements';
import { sanitizeCompanion } from './companion';
import { sanitizeBridge, type BridgeConfig } from './htmlBridge';
import { sanitizeVisual, type LinkVisual } from './smartLinks';
import { sanitizeArtifact, type ArtifactMetadata } from './artifact';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* Notas ------------------------------------------------------------- */
export interface NotesData { markdown: string; mode: 'edit' | 'preview' }
export const sanitizeNotes = (raw: unknown): NotesData => {
  const d = obj(raw);
  return { markdown: str(d.markdown), mode: d.mode === 'preview' ? 'preview' : 'edit' };
};

/* Tarefas ----------------------------------------------------------- */
export type TaskStatus = 'todo' | 'doing' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export interface TaskItem { id: string; text: string; status: TaskStatus; priority: TaskPriority; dueDate: string }
export interface TasksData { items: TaskItem[]; hideDone: boolean }
export const sanitizeTasks = (raw: unknown): TasksData => {
  const d = obj(raw);
  return {
    hideDone: !!d.hideDone,
    items: arr(d.items).map((x) => {
      const i = obj(x);
      const status = i.status === 'doing' || i.status === 'done' ? i.status : i.done === true ? 'done' : 'todo';
      const priority = i.priority === 'low' || i.priority === 'high' ? i.priority : 'medium';
      return { id: str(i.id) || uid(), text: str(i.text), status, priority, dueDate: str(i.dueDate) } as TaskItem;
    }),
  };
};

/* Calendário -------------------------------------------------------- */
export interface CalendarEvent { id: string; title: string; date: string; time: string; endTime: string; notes: string }
export interface CalendarData { events: CalendarEvent[]; month: string; source: 'local' | 'google' }
export const sanitizeCalendar = (raw: unknown): CalendarData => {
  const d = obj(raw);
  const today = new Date().toISOString().slice(0, 7);
  return {
    month: /^\d{4}-\d{2}$/.test(str(d.month)) ? str(d.month) : today,
    source: 'local',
    events: arr(d.events)
      .map((x) => {
        const e = obj(x);
        return { id: str(e.id) || uid(), title: str(e.title), date: str(e.date), time: str(e.time), endTime: str(e.endTime), notes: str(e.notes) };
      })
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)),
  };
};

/* IA ---------------------------------------------------------------- */
export interface AIMessage { id: string; role: 'user' | 'assistant'; content: string; at: number; provider?: string; model?: string; artifact?: true }
export interface AIData {
  provider: string;
  model: string;
  instruction: string;
  messages: AIMessage[];
  /** Autorização por fonte conectada (id do elemento → enviado ou não). */
  authorized: Record<string, boolean>;
  /** Propostas já aplicadas (chave da mensagem → quando). Gravado junto com a aplicação: desfazer reabre a proposta. */
  applied: Record<string, number>;
  /** Issue #13: visual do assistente (clássico/personagem), preset, nome e dock. Ausente = clássico. */
  companion?: import('./companion').CompanionData;
}
export const sanitizeAI = (raw: unknown): AIData => {
  const d = obj(raw);
  const authorized: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(obj(d.authorized))) authorized[k] = v === true;
  const applied: Record<string, number> = {};
  // Até 2 chaves por mensagem (proposta da IA + interpretação local), e as mensagens são limitadas a 200.
  for (const [k, v] of Object.entries(obj(d.applied)).slice(-400)) if (k !== '__proto__' && k.length <= 200 && typeof v === 'number' && Number.isFinite(v)) applied[k] = v;
  const companion = sanitizeCompanion(d.companion);
  return {
    provider: str(d.provider),
    model: str(d.model),
    instruction: str(d.instruction, str(d.prompt, 'Analise as informações conectadas e sugira os próximos passos.')),
    messages: arr(d.messages)
      .map((x) => {
        const m = obj(x);
        return { id: str(m.id) || uid(), role: m.role === 'assistant' ? 'assistant' : 'user', content: str(m.content), at: Number(m.at) || Date.now(), provider: str(m.provider) || undefined, model: str(m.model) || undefined, ...(m.artifact === true ? { artifact: true } : {}) } as AIMessage;
      })
      .slice(-200),
    authorized,
    applied,
    ...(companion ? { companion } : {}),
  };
};

/* Link -------------------------------------------------------------- */
export interface LinkPreview { title: string; description: string; image: string; siteName: string; fetchedAt: number }
/**
 * `url`, `description` e `preview` são o formato histórico (backups antigos dependem deles — nunca renomear).
 * `visual` (issue #22) é opcional: ausente = modo Clássico idêntico ao anterior; presente = Atalho Visual ou
 * Clássico escolhido explicitamente (a conversão preserva os três campos históricos).
 */
export interface LinkData { url: string; description: string; preview: LinkPreview | null; visual?: LinkVisual }
export const sanitizeLink = (raw: unknown): LinkData => {
  const d = obj(raw);
  const p = d.preview ? obj(d.preview) : null;
  const visual = sanitizeVisual(d.visual);
  return {
    url: str(d.url),
    description: str(d.description),
    preview: p ? { title: str(p.title), description: str(p.description), image: str(p.image), siteName: str(p.siteName), fetchedAt: Number(p.fetchedAt) || 0 } : null,
    ...(visual ? { visual } : {}),
  };
};

export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/* Código ------------------------------------------------------------ */
export interface CodeData { language: string; code: string; wrap: boolean }
export const CODE_LANGUAGES = ['typescript', 'javascript', 'python', 'json', 'css', 'xml', 'bash', 'sql', 'markdown', 'plaintext'] as const;
export const sanitizeCode = (raw: unknown): CodeData => {
  const d = obj(raw);
  const lang = str(d.language, 'typescript');
  return { language: (CODE_LANGUAGES as readonly string[]).includes(lang) ? lang : 'plaintext', code: str(d.code), wrap: !!d.wrap };
};

/* Documentos -------------------------------------------------------- */
export interface DocumentItem { id: string; name: string; mimeType: string; size: number; assetId: string; url: string; description: string; tags: string[]; addedAt: number }
export interface DocumentsData { docs: DocumentItem[]; selected: string }
export const sanitizeDocuments = (raw: unknown): DocumentsData => {
  const d = obj(raw);
  return {
    selected: str(d.selected),
    docs: arr(d.docs).map((x) => {
      const i = obj(x);
      return {
        id: str(i.id) || uid(),
        name: str(i.name, 'Documento'),
        mimeType: str(i.mimeType),
        size: Number(i.size) || 0,
        assetId: str(i.assetId),
        url: str(i.url),
        description: str(i.description),
        tags: arr(i.tags).map((t) => String(t)),
        addedAt: Number(i.addedAt) || Date.now(),
      };
    }),
  };
};

/* Gráfico ----------------------------------------------------------- */
export interface ChartData { mode: 'categories' | 'income-expense' | 'sources'; chartType: 'bar' | 'donut' | 'line' | 'kpi' }
export const sanitizeChart = (raw: unknown): ChartData => {
  const d = obj(raw);
  return {
    mode: d.mode === 'income-expense' || d.mode === 'sources' ? d.mode : 'categories',
    chartType: d.chartType === 'donut' || d.chartType === 'line' || d.chartType === 'kpi' ? d.chartType : 'bar',
  };
};

/* HTML isolado (plugin de terceiros / experimento) ------------------ */
/**
 * Política de conteúdo ativo (S1-SEC-003): HTML que chegou por importação ou colagem externa fica
 * `blocked` até o usuário ativá-lo. A marcação é feita pelo IMPORTADOR (sobrescreve o que vier no arquivo),
 * então um backup não consegue se declarar "já ativado". Ausente = conteúdo criado neste navegador.
 */
export interface SandboxActivation { state: 'blocked' | 'allowed'; source: 'import' | 'paste' | 'artifact'; at: number }
/** `bridge`: portas da ponte de dados (issue #11). Ausente = bloco legado (só `aurora.setState`). */
/**
 * H2 (HTML Network Bridge): o estado foi gravado por uma execução que recebia dados PROTEGIDOS (bancários, dados
 * importados, finanças). Só restringe — enquanto existir, a rede do bloco exige a autorização específica dessas
 * fontes (ou fica bloqueada se alguma não existir mais). Some ao limpar o estado.
 */
export interface SandboxStateTaint { sources: string[]; at: number }
export interface SandboxData { html: string; state: unknown; activation?: SandboxActivation; bridge?: BridgeConfig; stateTaint?: SandboxStateTaint; artifact?: ArtifactMetadata }
export const MAX_STATE_TAINT_SOURCES = 50;
export const sanitizeSandbox = (raw: unknown): SandboxData => {
  const d = obj(raw);
  const a = obj(d.activation);
  const out: SandboxData = { html: str(d.html), state: d.state ?? null };
  if (a.state === 'blocked' || a.state === 'allowed') out.activation = { state: a.state, source: a.source === 'paste' || a.source === 'artifact' ? a.source : 'import', at: Number(a.at) || 0 };
  const artifact = sanitizeArtifact(d.artifact);
  if (artifact) out.artifact = artifact;
  const bridge = sanitizeBridge(d.bridge);
  if (bridge) out.bridge = bridge;
  const t = obj(d.stateTaint);
  if (Array.isArray(t.sources)) {
    const sources = [...new Set(t.sources.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x)))].slice(0, MAX_STATE_TAINT_SOURCES);
    // Marca malformada não pode virar “sem marca” por acidente: sem ids válidos, uma fonte desconhecida.
    out.stateTaint = { sources: sources.length || !t.sources.length ? sources : ['desconhecida'], at: Number(t.at) || 0 };
    if (!out.stateTaint.sources.length) delete out.stateTaint;
  }
  return out;
};

/** Marca widgets HTML como desativados (importação/colagem). Retorna quantos foram marcados. */
export function blockActiveContent(elements: { type: string; widgetType?: string; data?: unknown }[], source: SandboxActivation['source'], sandboxType = 'aurora.sandbox-html'): number {
  let n = 0;
  for (const el of elements) {
    if (el.type !== 'widget' || el.widgetType !== sandboxType) continue;
    el.data = { ...obj(el.data), activation: { state: 'blocked', source, at: Date.now() } satisfies SandboxActivation };
    n++;
  }
  return n;
}
