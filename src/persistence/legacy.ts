/**
 * Importação de dados do protótipo Aurora Board v0.2 / v0.3 (formato `{ version: 2, boards: [...] }`,
 * gravado no localStorage em `aurora-board-v2-data`).
 *
 * Campos reconhecidos são convertidos; o restante gera avisos no relatório de importação.
 */
import type { Asset, AuroraElement, Board, ElementStyle, FontFamily, LinkKind } from '../core/schema';
import { createBoard, createFreedraw, createImage, createLinear, createShape, createText, createWidget, normalizeFreedraw, uid } from '../core/elements';
import { updateBoundArrows } from '../core/bindings';
import { fitTextElement } from '../core/text';
import { WIDGET } from '../core/widgetIds';
import { sanitizeFinance, type FinanceEntry } from '../core/finance';

export const LEGACY_STORAGE_KEY = 'aurora-board-v2-data';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface LegacyImportResult {
  boards: Board[];
  assets: Asset[];
  warnings: string[];
  stats: { boards: number; elements: number; connections: number; strokes: number };
}

export function isLegacyFormat(data: unknown): boolean {
  const d = obj(data);
  return d.version === 2 && Array.isArray(d.boards);
}

const KNOWN_NODE_FIELDS = new Set(['id', 'type', 'x', 'y', 'w', 'h', 'title', 'desc', 'color', 'data', 'groupId', 'style']);

function legacyStyle(s: Raw): Partial<ElementStyle> {
  const fonts: Record<string, FontFamily> = { hand: 'hand', clean: 'sans', mono: 'mono', serif: 'serif' };
  const out: Partial<ElementStyle> = {};
  if (typeof s.stroke === 'string') out.strokeColor = s.stroke;
  if (typeof s.fill === 'string') out.backgroundColor = s.fill;
  if (typeof s.sw === 'number') out.strokeWidth = s.sw;
  if (s.dash === 'dashed' || s.dash === 'dotted' || s.dash === 'solid') out.strokeStyle = s.dash;
  if (typeof s.rounded === 'boolean') out.roundness = s.rounded ? 'round' : 'sharp';
  if (typeof s.opacity === 'number') out.opacity = Math.max(0, Math.min(100, s.opacity));
  if (typeof s.font === 'string' && fonts[s.font]) out.fontFamily = fonts[s.font];
  if (typeof s.size === 'number') out.fontSize = s.size;
  if (s.align === 'left' || s.align === 'center' || s.align === 'right') out.textAlign = s.align;
  // O protótipo usava traço limpo: preserva com rugosidade 0 (estilo "arquiteto").
  out.roughness = 0;
  return out;
}

function parsePenPath(path: string): [number, number][] {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

export function importLegacy(data: unknown, workspaceId: string): LegacyImportResult {
  const d = obj(data);
  const warnings: string[] = [];
  const assets: Asset[] = [];
  const stats = { boards: 0, elements: 0, connections: 0, strokes: 0 };
  const boards: Board[] = [];

  for (const rb of arr(d.boards)) {
    const b = obj(rb);
    const board = createBoard(workspaceId, str(b.name, 'Quadro importado') + ' (v0.3)', 'Importado do Aurora Board v0.2/v0.3');
    const cam = obj(b.camera);
    board.camera = { x: num(cam.x, 0), y: num(cam.y, 0), zoom: Math.min(4, Math.max(0.1, num(cam.z, 1))) };
    const idMap = new Map<string, string>();
    const elements: AuroraElement[] = [];
    const groupMap = new Map<string, string>();

    for (const rn of arr(b.nodes)) {
      const n = obj(rn);
      const type = str(n.type);
      const x = num(n.x, 0), y = num(n.y, 0), w = num(n.w, 265), h = num(n.h, 0);
      const title = str(n.title);
      const desc = str(n.desc);
      const data = obj(n.data);
      const style = legacyStyle(obj(n.style));
      const unknownFields = Object.keys(n).filter((k) => !KNOWN_NODE_FIELDS.has(k));
      if (unknownFields.length) warnings.push(`Bloco "${title || type}": campos não reconhecidos ignorados (${unknownFields.join(', ')}).`);

      let el: AuroraElement | null = null;
      switch (type) {
        case 'manual_rect':
        case 'manual_ellipse':
        case 'manual_diamond': {
          const t = type === 'manual_rect' ? 'rectangle' : type === 'manual_ellipse' ? 'ellipse' : 'diamond';
          el = createShape(t, x, y, w || 160, h || 95, style);
          el.text = desc;
          break;
        }
        case 'manual_text': {
          const t = createText(x, y, desc, style);
          el = fitTextElement({ ...t, autoSize: false, width: Math.max(w, 40) });
          break;
        }
        case 'manual_line':
        case 'manual_arrow': {
          const positive = data.positiveSlope === true, fromLeft = data.fromLeft !== false;
          const hh = h || 85, ww = w || 190;
          const leftY = positive ? 0 : hh, rightY = positive ? hh : 0;
          const x1 = fromLeft ? 0 : ww, y1 = fromLeft ? leftY : rightY, x2 = fromLeft ? ww : 0, y2 = fromLeft ? rightY : leftY;
          el = createLinear(type === 'manual_arrow' ? 'arrow' : 'line', x + x1, y + y1, [[0, 0], [x2 - x1, y2 - y1]], style);
          el.text = desc;
          break;
        }
        case 'text':
        case 'group':
          el = createWidget(WIDGET.notes, '1.0.0', title || 'Anotação', x, y, Math.max(w, 240), 200, { markdown: desc, mode: 'edit' });
          if (type === 'group') warnings.push(`Bloco "Estrutura" "${title}" convertido em Nota.`);
          break;
        case 'task':
          el = createWidget(WIDGET.tasks, '1.0.0', title || 'Tarefas', x, y, Math.max(w, 260), 240, {
            hideDone: false,
            items: arr(data.items).map((i) => {
              const it = obj(i);
              return { id: str(it.id) || uid(), text: str(it.text), status: it.done ? 'done' : 'todo', priority: 'medium', dueDate: '' };
            }),
          });
          break;
        case 'finance': {
          const entries: FinanceEntry[] = arr(data.items).map((i) => {
            const it = obj(i);
            const v = num(it.value, 0);
            return {
              id: str(it.id) || uid(),
              description: str(it.text),
              amountCents: Math.round(Math.abs(v) * 100),
              kind: v >= 0 ? 'income' : 'expense',
              category: '',
              date: '',
              paid: true,
              installments: 1,
              installmentMode: 'split',
            };
          });
          el = createWidget(WIDGET.finance, '1.0.0', title || 'Finanças', x, y, Math.max(w, 300), 320, sanitizeFinance({ entries, currency: 'BRL' }));
          if (desc) warnings.push(`Finanças "${title}": descrição "${desc.slice(0, 40)}" não tem campo equivalente e foi descartada.`);
          break;
        }
        case 'calendar':
          el = createWidget(WIDGET.calendar, '1.0.0', title || 'Agenda', x, y, Math.max(w, 300), 320, {
            month: new Date().toISOString().slice(0, 7),
            events: arr(data.events).map((e) => {
              const ev = obj(e);
              return { id: str(ev.id) || uid(), title: str(ev.title), date: str(ev.date), time: '', endTime: '', notes: '' };
            }),
          });
          break;
        case 'ai':
          el = createWidget(WIDGET.ai, '1.0.0', title || 'Assistente', x, y, Math.max(w, 340), 380, {
            provider: '', model: '', instruction: str(data.prompt, desc), messages: [], authorized: {},
          });
          break;
        case 'link':
          el = createWidget(WIDGET.link, '1.0.0', title || 'Link', x, y, Math.max(w, 280), 150, { url: str(data.url), description: desc, preview: null });
          break;
        case 'image': {
          const src = str(data.src);
          if (src.startsWith('data:image/') || /^https?:\/\//.test(src)) {
            const asset: Asset = { id: uid('a_'), mimeType: src.startsWith('data:') ? src.slice(5, src.indexOf(';')) : 'image/*', dataURL: src, name: title || 'imagem', size: src.length, createdAt: Date.now() };
            assets.push(asset);
            el = createImage(x, y, Math.max(w, 80), h || Math.max(w, 80) * 0.66, asset.id);
          } else {
            el = createWidget(WIDGET.notes, '1.0.0', title || 'Imagem', x, y, Math.max(w, 240), 140, { markdown: desc || '_Imagem sem origem no arquivo importado._', mode: 'edit' });
            warnings.push(`Imagem "${title}" sem origem válida: convertida em nota.`);
          }
          break;
        }
        default:
          warnings.push(`Tipo de bloco desconhecido "${type}" (${title}) ignorado.`);
      }
      if (!el) continue;
      const nid = str(n.id);
      if (nid) idMap.set(nid, el.id);
      const gid = str(n.groupId);
      if (gid) {
        if (!groupMap.has(gid)) groupMap.set(gid, uid('g_'));
        el.groupIds = [groupMap.get(gid)!];
      }
      if (typeof n.color === 'string' && el.type === 'widget') el.style.strokeColor = n.color;
      elements.push(el);
      stats.elements++;
    }

    const kindMap: Record<string, { kind: LinkKind; relation: string }> = {
      reference: { kind: 'visual', relation: 'referência' },
      context: { kind: 'context', relation: '' },
      flow: { kind: 'visual', relation: 'fluxo / dependência' },
    };
    for (const re of arr(b.edges)) {
      const e = obj(re);
      const from = idMap.get(str(e.from)), to = idMap.get(str(e.to));
      if (!from || !to) { warnings.push('Conexão com bloco inexistente ignorada.'); continue; }
      const k = kindMap[str(e.kind)] ?? kindMap.reference;
      if (str(e.kind) === 'flow') warnings.push('Conexão "fluxo" importada como visual (dependência): não executa ações automaticamente.');
      const arrow = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: k.kind === 'context' ? '#c0a0ff' : '#7895b6', strokeStyle: k.kind === 'context' ? 'dashed' : 'solid' }, k.kind);
      arrow.connection.relation = k.relation;
      arrow.startBinding = { elementId: from, fixedPoint: null };
      arrow.endBinding = { elementId: to, fixedPoint: null };
      arrow.text = str(e.label);
      elements.push(arrow);
      stats.connections++;
    }

    for (const rs of arr(b.strokes)) {
      const s = obj(rs);
      const pts = parsePenPath(str(s.path));
      if (pts.length < 1) continue;
      const fd = createFreedraw(pts[0][0], pts[0][1], { strokeColor: str(s.color, '#77b9ff'), strokeWidth: 2.7 });
      fd.points = pts.map(([px, py]) => [px - pts[0][0], py - pts[0][1], 0.5]);
      elements.push(normalizeFreedraw(fd));
      stats.strokes++;
    }

    board.elements = updateBoundArrows(elements);
    boards.push(board);
    stats.boards++;
  }
  if (!boards.length) warnings.push('Nenhum quadro encontrado no arquivo.');
  return { boards, assets, warnings, stats };
}
