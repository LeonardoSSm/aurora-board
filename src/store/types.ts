import type { ReactNode } from 'react';
import type { ArrowPath, AuroraElement, BoardMeta, Camera, ElementStyle, LinkKind, Point, Workspace } from '../core/schema';
import type { HistoryStack } from '../core/history';
import type { Box } from '../core/geometry';

export type Tool =
  | 'select'
  | 'hand'
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'line'
  | 'arrow'
  | 'freedraw'
  | 'text'
  | 'sticky'
  | 'eraser'
  | 'frame'
  | 'image'
  | 'connect';

export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'error' | 'warning';
}

export interface DialogButton {
  label: string;
  value: string;
  variant?: 'primary' | 'danger' | 'ghost';
}

export interface DialogState {
  id: string;
  title: string;
  message?: string;
  body?: ReactNode;
  input?: { placeholder?: string; initial?: string; multiline?: boolean };
  buttons: DialogButton[];
  resolve: (result: { button: string | null; value: string }) => void;
  wide?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  world: { x: number; y: number };
  targetId: string | null;
}

export interface BindingHint {
  elementId: string;
  fixedPoint: Point | null;
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface EditorState {
  status: 'loading' | 'ready' | 'error';
  loadError: string;
  workspaces: Workspace[];
  workspaceId: string;
  boards: BoardMeta[];
  boardId: string;
  elements: AuroraElement[];
  camera: Camera;
  viewport: { width: number; height: number };
  selectedIds: string[];
  editingGroupId: string | null;
  editingTextId: string | null;
  hoverId: string | null;
  tool: Tool;
  toolLocked: boolean;
  currentStyle: ElementStyle;
  connectionKind: LinkKind;
  /** Tipo de traçado das próximas setas/linhas (como no Excalidraw, padrão curva). */
  currentArrowPath: ArrowPath;
  /** Seta sendo criada por cliques sucessivos (multiponto). */
  linearDraftId: string | null;
  /** Ponto selecionado na seta selecionada (Delete remove o ponto). */
  selectedPointIndex: number | null;
  history: Record<string, HistoryStack>;
  saveState: SaveState;
  lastSavedAt: number;
  marquee: Box | null;
  eraserPending: string[];
  bindingHint: BindingHint | null;
  /** Linhas-guia de encaixe (coordenadas do mundo) durante o arrasto. */
  snapGuides: { x1: number; y1: number; x2: number; y2: number }[];
  /** Elementos sendo transformados (para esconder alças durante o gesto). */
  interacting: boolean;
  /** Tela estreita (celular/tablet em pé): painéis viram sobreposições. */
  compact: boolean;
  libraryOpen: boolean;
  propertiesOpen: boolean;
  boardsPanelOpen: boolean;
  shortcutsOpen: boolean;
  dialog: DialogState | null;
  contextMenu: ContextMenuState | null;
  /** Pedido para o painel de propriedades mostrar/focar as configurações de um widget. */
  inspectorFocus: { id: string; section?: string; nonce: number } | null;
  /** Widget em edição rápida no próprio bloco (duplo clique), ex.: valor ou fórmula. */
  editingWidgetId: string | null;
  /** Preferência GERAL do usuário (não do quadro): sensibilidade do zoom. */
  zoomPrefs: import('../core/camera').ZoomPreferences;
  toasts: Toast[];
  /** Último snapshot de dados de fluxo calculado (cache para widgets). */
  dataflowVersion: number;
}
