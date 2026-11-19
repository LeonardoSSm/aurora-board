import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { EditorState } from './types';
import { DEFAULT_STYLE } from '../core/elements';
import { DEFAULT_ZOOM_PREFS } from '../core/camera';

export const initialEditorState: EditorState = {
  status: 'loading',
  loadError: '',
  workspaces: [],
  workspaceId: '',
  boards: [],
  boardId: '',
  elements: [],
  camera: { x: 0, y: 0, zoom: 1 },
  viewport: { width: 1200, height: 800 },
  selectedIds: [],
  editingGroupId: null,
  editingTextId: null,
  hoverId: null,
  tool: 'select',
  toolLocked: false,
  currentStyle: { ...DEFAULT_STYLE },
  connectionKind: 'visual',
  currentArrowPath: 'curved',
  linearDraftId: null,
  selectedPointIndex: null,
  history: {},
  saveState: 'saved',
  lastSavedAt: 0,
  marquee: null,
  eraserPending: [],
  bindingHint: null,
  snapGuides: [],
  interacting: false,
  compact: false,
  libraryOpen: true,
  propertiesOpen: true,
  boardsPanelOpen: false,
  shortcutsOpen: false,
  dialog: null,
  contextMenu: null,
  inspectorFocus: null,
  editingWidgetId: null,
  checkpoints: [],
  locationsOpen: false,
  checkpointEditor: null,
  checkpointFlash: null,
  zoomPrefs: { ...DEFAULT_ZOOM_PREFS },
  toasts: [],
  dataflowVersion: 0,
};

export const useEditor = create<EditorState>()(subscribeWithSelector(() => ({ ...initialEditorState })));

export const getState = () => useEditor.getState();
export const setState = useEditor.setState;

export function selectedSet(state: EditorState = getState()): Set<string> {
  return new Set(state.selectedIds);
}

export function currentBoardMeta(state: EditorState = getState()) {
  return state.boards.find((b) => b.id === state.boardId);
}
