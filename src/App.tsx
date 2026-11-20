import { useEffect } from 'react';
import { getState, setState, useEditor } from './store/editor';
import { Canvas, getCanvasRect } from './canvas/Canvas';
import { TopBar } from './ui/TopBar';
import { Toolbar } from './ui/Toolbar';
import { LibraryPanel } from './ui/LibraryPanel';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { BoardsPanel } from './ui/BoardsPanel';
import { CheckpointDialog, LocationsPanel } from './ui/LocationsPanel';
import { ContextMenu, DialogHost, ShortcutsDialog, Toasts, ZoomControls } from './ui/Overlays';
import { RadialMenu } from './ui/RadialMenu';
import { CommandCenter } from './ui/CommandCenter';
import { QuickCapture } from './ui/QuickCapture';
import { BetaNotice } from './ui/BetaNotice';
import { FinanceHub } from './ui/finance/FinanceHub';
import { PairingDialog } from './ui/PairingDialog';
import { setLastPointerWorld, useKeyboard } from './ui/useKeyboard';
import { screenToWorld } from './store/actions';
import { LOCAL_API_ENABLED } from './config/runtime';

export function App() {
  const status = useEditor((s) => s.status);
  const loadError = useEditor((s) => s.loadError);
  const compact = useEditor((s) => s.compact);
  const overlayOpen = useEditor((s) => s.compact && (s.libraryOpen || s.propertiesOpen));
  useKeyboard();

  // Layout responsivo: em telas estreitas os painéis começam fechados e abrem sobre o canvas.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const apply = () => {
      const c = mq.matches;
      if (c !== getState().compact) setState(c ? { compact: true, libraryOpen: false, propertiesOpen: false } : { compact: false, libraryOpen: true, propertiesOpen: true });
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = getCanvasRect();
      if (!r.right) return;
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setLastPointerWorld(inside ? screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }) : null);
    };
    // Botões clicados com o mouse não guardam o foco: assim Espaço (pan) e Enter (editar texto)
    // não reacionam o último botão, e um editor de texto aberto continua focado.
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const btn = t.closest?.('button');
      if (btn && !btn.closest('[draggable="true"]') && !btn.closest('[role="dialog"]')) e.preventDefault();
    };
    window.addEventListener('pointermove', onMove);
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, []);

  if (status === 'error') {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="max-w-lg rounded-2xl border border-danger/50 bg-panel p-6">
          <h1 className="text-lg font-bold text-danger">Não foi possível abrir o armazenamento local</h1>
          <p className="text-[13px] text-muted mt-2">O IndexedDB do navegador está indisponível (janela privada restrita ou permissões). Nenhum dado foi apagado.</p>
          <pre className="mt-3 text-[11px] text-soft whitespace-pre-wrap">{loadError}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 min-h-0 flex relative">
        <LibraryPanel />
        <main className="relative flex-1 min-w-0">
          {status === 'loading' ? (
            <div className="absolute inset-0 grid place-items-center text-muted">Carregando seus quadros…</div>
          ) : (
            <>
              <Canvas />
              <Toolbar />
              <ZoomControls />
            </>
          )}
        </main>
        <PropertiesPanel />
        {compact && overlayOpen && (
          <div data-testid="panel-backdrop" className="absolute inset-0 z-30 bg-black/40" onPointerDown={() => setState({ libraryOpen: false, propertiesOpen: false })} />
        )}
      </div>
      <ContextMenu />
      <RadialMenu />
      <CommandCenter />
      <QuickCapture />
      <BoardsPanel />
      <LocationsPanel />
      <CheckpointDialog />
      <FinanceHub />
      {LOCAL_API_ENABLED && <PairingDialog />}
      <DialogHost />
      <ShortcutsDialog />
      <Toasts />
      <BetaNotice />
    </div>
  );
}
