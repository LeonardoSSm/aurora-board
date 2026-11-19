import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/kalam/400.css';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/lora/400.css';
import './index.css';
import { App } from './App';
import { registerBuiltinWidgets } from './widgets/builtin';
import { IndexedDBAdapter } from './persistence/indexeddb';
import { initEditor } from './store/init';
import { getState, useEditor } from './store/editor';
import * as actions from './store/actions';
import * as elementsApi from './core/elements';
import { updateBoundArrows } from './core/bindings';
import { getDataflow } from './widgets/dataflow';

const coreApi = { updateBoundArrows, getDataflow };

registerBuiltinWidgets();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Garante que as fontes estejam carregadas antes de medir textos.
const fontsReady = Promise.all(
  ['16px "Kalam"', '16px "Inter Variable"', '16px "JetBrains Mono"', '16px "Lora"'].map((f) => document.fonts.load(f).catch(() => [])),
);
const timeout = new Promise((r) => setTimeout(r, 2500));
void Promise.race([fontsReady, timeout]).then(() => initEditor(new IndexedDBAdapter()));

// Acesso para depuração, testes de interação e benchmarks (mesma instância de módulo que o app usa).
declare global {
  interface Window {
    __aurora?: { getState: typeof getState; store: typeof useEditor; actions: typeof actions; elements: typeof elementsApi; core: typeof coreApi };
  }
}
window.__aurora = { getState, store: useEditor, actions, elements: elementsApi, core: coreApi };
