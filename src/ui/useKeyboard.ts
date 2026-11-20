import { useEffect } from 'react';
import { cancelCameraAnimation, isCameraAnimating } from '../store/cameraMotion';
import { getState, setState } from '../store/editor';
import {
  cancelTextEdit,
  copySelection,
  copyStyle,
  createFlowchartNode,
  cutSelection,
  navigateConnected,
  pasteStyle,
  removeLinearPoint,
  deleteSelected,
  duplicateSelected,
  groupSelection,
  nudgeSelection,
  pasteContent,
  redo,
  reorderSelection,
  resetZoom,
  selectAll,
  setTool,
  startTextEdit,
  toggleLockSelection,
  undo,
  ungroupSelection,
  zoomStep,
  zoomToFit,
  zoomToSelection,
} from '../store/actions';
import { flushSave } from '../persistence/autosave';
import { abortDraft, cancelGesture, finishDraft, isDrafting, setSpaceHeld } from '../canvas/controller';
import { TOOL_BY_KEY } from './tools';
import { openRadialFromKeyboard } from './radialOpen';
import { acceptsBoundText, isText } from '../core/schema';

/** Alvo é um campo de digitação? Atalhos não devem interferir. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'range', 'color'].includes(type);
  }
  return false;
}

let lastPointerWorld: { x: number; y: number } | null = null;
export function setLastPointerWorld(p: { x: number; y: number } | null) { lastPointerWorld = p; }

export function useKeyboard() {
  useEffect(() => {
    const modalOpen = () => { const s = getState(); return !!s.dialog || s.shortcutsOpen || s.boardsPanelOpen; };

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') { e.preventDefault(); void flushSave(); return; }
      if (isTypingTarget(e.target) || modalOpen()) return;
      const s = getState();
      if (s.editingTextId) return;

      if (e.code === 'Space' && !e.repeat) { setSpaceHeld(true); e.preventDefault(); return; }
      // Seta multiponto em criação: Enter/Esc finalizam, Ctrl+Z descarta.
      if (isDrafting()) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finishDraft(); return; }
        if (mod && key === 'z') { e.preventDefault(); abortDraft(); return; }
      }
      const arrowDir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp'];
      if (arrowDir && mod && !e.shiftKey && !e.altKey) { if (createFlowchartNode(arrowDir)) e.preventDefault(); return; }
      if (arrowDir && e.altKey && !mod) { if (navigateConnected(arrowDir)) e.preventDefault(); return; }
      if (mod && e.altKey && key === 'c') { e.preventDefault(); copyStyle(); return; }
      if (mod && e.altKey && key === 'v') { e.preventDefault(); pasteStyle(); return; }
      if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); redo(); return; }
      if (mod && key === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (mod && key === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); return; }
      if (mod && e.shiftKey && key === 'l') { e.preventDefault(); toggleLockSelection(); return; }
      if (mod && (e.key === ']' || e.code === 'BracketRight')) { e.preventDefault(); reorderSelection(e.shiftKey ? 'front' : 'forward'); return; }
      if (mod && (e.key === '[' || e.code === 'BracketLeft')) { e.preventDefault(); reorderSelection(e.shiftKey ? 'back' : 'backward'); return; }
      if (mod && (key === '=' || key === '+')) { e.preventDefault(); zoomStep(1); return; }
      if (mod && key === '-') { e.preventDefault(); zoomStep(-1); return; }
      if (mod && key === '0') { e.preventDefault(); resetZoom(); return; }
      if (mod) return; // demais atalhos com Ctrl ficam com o navegador (copiar/colar via eventos)

      if (e.shiftKey && (e.code === 'Digit1' || e.key === '!')) { e.preventDefault(); zoomToFit(); return; }
      if (e.shiftKey && (e.code === 'Digit2' || e.key === '@')) { e.preventDefault(); zoomToSelection(); return; }
      if (e.key === '?') { setState({ shortcutsOpen: true }); return; }
      // Issue #15: W abre a Aurora Wheel (alternativa de teclado ao gesto do botão direito).
      if (key === 'w' && !e.shiftKey && !e.altKey && !s.radial) { e.preventDefault(); openRadialFromKeyboard(lastPointerWorld); return; }

      switch (e.key) {
        case 'Escape':
          cancelGesture();
          if (isCameraAnimating()) { cancelCameraAnimation(); return; } // Esc interrompe a navegação animada
          if (s.contextMenu) setState({ contextMenu: null });
          else if (s.tool !== 'select') setTool('select');
          else if (s.editingGroupId) setState({ editingGroupId: null, selectedIds: [] });
          else setState({ selectedIds: [] });
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          // Com um ponto da seta selecionado, remove só o ponto.
          if (s.selectedPointIndex !== null && s.selectedIds.length === 1 && removeLinearPoint(s.selectedIds[0], s.selectedPointIndex)) return;
          deleteSelected();
          return;
        case 'Enter': {
          if (s.selectedIds.length === 1) {
            const el = s.elements.find((x) => x.id === s.selectedIds[0]);
            if (el && (isText(el) || acceptsBoundText(el) || el.type === 'frame')) { e.preventDefault(); startTextEdit(el.id); }
          }
          return;
        }
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
          if (!s.selectedIds.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          nudgeSelection(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
          return;
        }
      }
      if (key === 'q') { setState({ toolLocked: !s.toolLocked }); return; }
      if (key === 'g' && !e.shiftKey && !e.altKey) { e.preventDefault(); setState({ locationsOpen: !s.locationsOpen }); return; } // preventDefault: o “g” não vai para o filtro que recebe o foco
      const tool = TOOL_BY_KEY[key];
      if (tool && !e.altKey) { e.preventDefault(); setTool(tool); }
    };

    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };

    const onCopy = (e: ClipboardEvent) => { if (isTypingTarget(e.target) || modalOpen() || getState().editingTextId) return; copySelection(e); };
    const onCut = (e: ClipboardEvent) => { if (isTypingTarget(e.target) || modalOpen() || getState().editingTextId) return; cutSelection(e); };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || modalOpen() || getState().editingTextId) return;
      e.preventDefault();
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData('text/plain') ?? null;
      void pasteContent(text, files, lastPointerWorld);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}

export { cancelTextEdit };
