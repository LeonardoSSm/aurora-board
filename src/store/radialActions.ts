/**
 * Aurora Wheel (issue #15) — o que cada fatia faz. Tudo passa pelas ações já existentes (addElements, addWidget,
 * createTextAt, startTextEdit, setTool, pickImages): mesma seleção, mesmo histórico (uma entrada por criação),
 * mesmas regras de frames. Nenhum item é criado degenerado: Forma usa o tamanho padrão do clique sem arrastar;
 * Seta/Linha/Conectar só ativam a ferramenta.
 */
import type { ComponentType } from 'react';
import { Bot, Cable, Circle, CircleDollarSign, Diamond, Frame, LayoutGrid, ListChecks, Minus, MoveRight, Shapes, Square, StickyNote, Type } from 'lucide-react';
import { createShape } from '../core/elements';
import type { Vec } from '../core/geometry';
import { DEFAULT_FAVORITES, sanitizeFavorites, type RadialItemId } from '../core/radial';
import { WIDGET } from '../core/widgetIds';
import { getWidget, listWidgets } from '../widgets/registry';
import { getAdapter } from '../persistence/autosave';
import { addElements, addWidget, createTextAt, setTool, startTextEdit } from './actions';
import { getState, setState } from './editor';
import { toast } from './ui';
import type { Tool } from './types';

type Icon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface RadialItemDef {
  id: string;
  label: string;
  /** Descrição curta (tooltip e nome acessível). */
  hint: string;
  icon: Icon;
  /** Abre um anel secundário em vez de executar. */
  sub?: 'shape' | 'connector' | 'more';
}

const SHAPE_SIZE = { w: 160, h: 100 };

function createShapeAt(type: 'rectangle' | 'diamond' | 'ellipse' | 'sticky' | 'frame', p: Vec) {
  const size = type === 'sticky' ? { w: 200, h: 200 } : type === 'frame' ? { w: 480, h: 320 } : SHAPE_SIZE;
  const style = type === 'sticky' || type === 'frame' ? {} : getState().currentStyle;
  const el = createShape(type, p.x - size.w / 2, p.y - size.h / 2, size.w, size.h, style);
  addElements([el]);
  setState({ tool: 'select' });
  return el;
}

function activateTool(tool: Tool, hint: string) {
  setTool(tool);
  toast(hint, 'info');
}

/** Itens nativos da roda principal. */
export const BUILTIN_ITEMS: Record<Exclude<RadialItemId, `widget:${string}`>, RadialItemDef> = {
  note: { id: 'note', label: 'Nota', hint: 'Nota adesiva aqui, já em edição', icon: StickyNote },
  text: { id: 'text', label: 'Texto', hint: 'Texto aqui, já em edição', icon: Type },
  task: { id: 'task', label: 'Tarefa', hint: 'Bloco de tarefas aqui', icon: ListChecks },
  shape: { id: 'shape', label: 'Forma', hint: 'Escolher uma forma', icon: Shapes, sub: 'shape' },
  connector: { id: 'connector', label: 'Conexão', hint: 'Seta, linha ou conexão entre elementos', icon: MoveRight, sub: 'connector' },
  ai: { id: 'ai', label: 'Assistente IA', hint: 'Bloco de assistente de IA aqui', icon: Bot },
  value: { id: 'value', label: 'Valor', hint: 'Bloco de valor aqui', icon: CircleDollarSign },
  more: { id: 'more', label: 'Mais', hint: 'Todos os widgets, busca e personalização', icon: LayoutGrid, sub: 'more' },
};

export const SUB_ITEMS: Record<'shape' | 'connector', RadialItemDef[]> = {
  shape: [
    { id: 'shape:rectangle', label: 'Retângulo', hint: 'Retângulo aqui', icon: Square },
    { id: 'shape:ellipse', label: 'Elipse', hint: 'Elipse aqui', icon: Circle },
    { id: 'shape:diamond', label: 'Losango', hint: 'Losango aqui', icon: Diamond },
    { id: 'shape:frame', label: 'Frame', hint: 'Área (frame) aqui', icon: Frame },
  ],
  connector: [
    { id: 'tool:arrow', label: 'Seta', hint: 'Ativa a ferramenta Seta', icon: MoveRight },
    { id: 'tool:line', label: 'Linha', hint: 'Ativa a ferramenta Linha', icon: Minus },
    { id: 'tool:connect', label: 'Conectar', hint: 'Ativa “Conectar elementos”', icon: Cable },
  ],
};

/** Widgets que podem entrar na roda/lista (registrados e disponíveis). */
export function availableWidgets() {
  return listWidgets().filter((w) => w.status !== 'planned');
}

export function isKnownRadialItem(id: string): boolean {
  if (!id.startsWith('widget:')) return id in BUILTIN_ITEMS;
  const w = getWidget(id.slice(7));
  return !!w && w.status !== 'planned';
}

export function radialItemDef(id: RadialItemId): RadialItemDef | null {
  if (!id.startsWith('widget:')) return BUILTIN_ITEMS[id as keyof typeof BUILTIN_ITEMS] ?? null;
  const w = getWidget(id.slice(7));
  return w ? { id, label: w.name, hint: `${w.name} aqui`, icon: w.icon as Icon } : null;
}

/** Executa um item (da roda, de um anel secundário ou da lista “Mais”) no ponto do mundo original. */
export function runRadialItem(id: string, world: Vec): boolean {
  if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return false;
  switch (id) {
    case 'note': { const el = createShapeAt('sticky', world); startTextEdit(el.id); return true; }
    case 'text': createTextAt(world); return true;
    case 'task': return !!addWidget(WIDGET.tasks, world);
    case 'ai': return !!addWidget(WIDGET.ai, world);
    case 'value': return !!addWidget(WIDGET.value, world);
    case 'shape:rectangle': createShapeAt('rectangle', world); return true;
    case 'shape:ellipse': createShapeAt('ellipse', world); return true;
    case 'shape:diamond': createShapeAt('diamond', world); return true;
    case 'shape:frame': createShapeAt('frame', world); return true;
    case 'tool:arrow': activateTool('arrow', 'Seta: arraste no quadro para desenhar.'); return true;
    case 'tool:line': activateTool('line', 'Linha: arraste no quadro para desenhar.'); return true;
    case 'tool:connect': activateTool('connect', 'Conectar: arraste de um elemento até outro.'); return true;
  }
  if (id.startsWith('widget:')) return !!addWidget(id.slice(7), world);
  if (id.startsWith('preset:')) return !!addWidget(id.slice(7), world);
  return false;
}

/* ------------------------------------------------------------------ */
/* Favoritos (configuração local, fora dos quadros e backups)          */
/* ------------------------------------------------------------------ */

export function loadedFavorites(raw: unknown): RadialItemId[] {
  return sanitizeFavorites(raw, isKnownRadialItem);
}

export async function setRadialFavorites(list: string[]) {
  const next = sanitizeFavorites(list, isKnownRadialItem);
  setState({ radialFavorites: next });
  await getAdapter().setSetting('radialFavorites', next);
}

export async function resetRadialFavorites() {
  await setRadialFavorites([...DEFAULT_FAVORITES]);
}
