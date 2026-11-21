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
import { computeDataflow } from './core/dataflow';
import { dataflowSpec } from './widgets/registry';
import { isCameraAnimating } from './store/cameraMotion';
import * as checkpointActions from './store/checkpointActions';
import { getDataflow } from './widgets/dataflow';
import { EXPOSE_TEST_HOOKS } from './config/runtime';
import { setFinanceRepositoryFactory } from './finance/store';
import * as financeStoreBase from './finance/store';
import { parseCsvStatement } from './finance/csv';
import { runBankQuery, sanitizeBankQuery } from './finance/query';
import { summarizeFlows } from './finance/reports';

// Só nos ganchos de teste/benchmark (nunca no build público): store + funções puras para medir desempenho.
const financeStore = { ...financeStoreBase, lib: { parseCsvStatement, runBankQuery, sanitizeBankQuery, summarizeFlows } };
import { IndexedDBFinanceRepository } from './finance/repository';
import { netActivity, netAvailability, revokeNetAccess, setNetTransport } from './net/broker';

// Ciclo F1: razão financeiro num banco IndexedDB próprio (aurora-finance), carregado sob demanda.
setFinanceRepositoryFactory(() => new IndexedDBFinanceRepository());

const coreApi = { updateBoundArrows, getDataflow, computeDataflow, dataflowSpec, isCameraAnimating };
// H2: transporte simulado nos E2E (o build público ignora qualquer transporte — ver setNetTransport).
const netApi = { setTransport: setNetTransport, availability: netAvailability, activity: netActivity, revoke: revokeNetAccess };

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
// S1-SEC-009: ausente no build público padrão — só em desenvolvimento ou num build gerado explicitamente com
// VITE_AURORA_TEST_HOOKS=1 (constante de build; não existe flag de runtime que o ative).
declare global {
  interface Window {
    __aurora?: { getState: typeof getState; store: typeof useEditor; actions: typeof actions; elements: typeof elementsApi; core: typeof coreApi; checkpoints: typeof checkpointActions; finance?: typeof financeStore; net?: typeof netApi };
  }
}
if (EXPOSE_TEST_HOOKS) window.__aurora = { getState, store: useEditor, actions, elements: elementsApi, core: coreApi, checkpoints: checkpointActions, finance: financeStore, net: netApi };
