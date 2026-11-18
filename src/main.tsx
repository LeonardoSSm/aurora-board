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

// Acesso para depuração e testes de interação (somente leitura recomendada).
declare global {
  interface Window { __aurora?: { getState: typeof getState; store: typeof useEditor } }
}
window.__aurora = { getState, store: useEditor };
