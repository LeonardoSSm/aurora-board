import {
  Cable,
  Circle,
  Diamond,
  Eraser,
  Frame,
  Hand,
  ImageIcon,
  Minus,
  MousePointer2,
  MoveRight,
  Pencil,
  Square,
  StickyNote,
  Type,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { Tool } from '../store/types';

export interface ToolDef {
  id: Tool;
  label: string;
  keys: string[];
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export const TOOLS: ToolDef[] = [
  { id: 'hand', label: 'Mão (pan)', keys: ['H'], icon: Hand },
  { id: 'select', label: 'Seleção', keys: ['V', '1'], icon: MousePointer2 },
  { id: 'rectangle', label: 'Retângulo', keys: ['R', '2'], icon: Square },
  { id: 'diamond', label: 'Losango', keys: ['D', '3'], icon: Diamond },
  { id: 'ellipse', label: 'Elipse', keys: ['O', '4'], icon: Circle },
  { id: 'arrow', label: 'Seta', keys: ['A', '5'], icon: MoveRight },
  { id: 'line', label: 'Linha', keys: ['L', '6'], icon: Minus },
  { id: 'freedraw', label: 'Desenho livre', keys: ['P', '7'], icon: Pencil },
  { id: 'text', label: 'Texto', keys: ['T', '8'], icon: Type },
  { id: 'image', label: 'Imagem', keys: ['I', '9'], icon: ImageIcon },
  { id: 'eraser', label: 'Borracha', keys: ['E', '0'], icon: Eraser },
  { id: 'sticky', label: 'Nota adesiva', keys: ['N'], icon: StickyNote },
  { id: 'frame', label: 'Frame (área)', keys: ['F'], icon: Frame },
  { id: 'connect', label: 'Conectar elementos', keys: ['C'], icon: Cable },
];

export const TOOL_BY_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.flatMap((t) => t.keys.map((k) => [k.toLowerCase(), t.id])));
