/** Estruturas de dados dos widgets nativos + saneamento (para importação e migração). */
import { uid } from './elements';

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
export interface AIMessage { id: string; role: 'user' | 'assistant'; content: string; at: number; provider?: string; model?: string }
export interface AIData {
  provider: string;
  model: string;
  instruction: string;
  messages: AIMessage[];
  /** Autorização por fonte conectada (id do elemento → enviado ou não). */
  authorized: Record<string, boolean>;
}
export const sanitizeAI = (raw: unknown): AIData => {
  const d = obj(raw);
  const authorized: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(obj(d.authorized))) authorized[k] = v === true;
  return {
    provider: str(d.provider),
    model: str(d.model),
    instruction: str(d.instruction, str(d.prompt, 'Analise as informações conectadas e sugira os próximos passos.')),
    messages: arr(d.messages)
      .map((x) => {
        const m = obj(x);
        return { id: str(m.id) || uid(), role: m.role === 'assistant' ? 'assistant' : 'user', content: str(m.content), at: Number(m.at) || Date.now(), provider: str(m.provider) || undefined, model: str(m.model) || undefined } as AIMessage;
      })
      .slice(-200),
    authorized,
  };
};

/* Link -------------------------------------------------------------- */
export interface LinkPreview { title: string; description: string; image: string; siteName: string; fetchedAt: number }
export interface LinkData { url: string; description: string; preview: LinkPreview | null }
export const sanitizeLink = (raw: unknown): LinkData => {
  const d = obj(raw);
  const p = d.preview ? obj(d.preview) : null;
  return {
    url: str(d.url),
    description: str(d.description),
    preview: p ? { title: str(p.title), description: str(p.description), image: str(p.image), siteName: str(p.siteName), fetchedAt: Number(p.fetchedAt) || 0 } : null,
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
export interface SandboxData { html: string; state: unknown }
export const sanitizeSandbox = (raw: unknown): SandboxData => {
  const d = obj(raw);
  return { html: str(d.html), state: d.state ?? null };
};
