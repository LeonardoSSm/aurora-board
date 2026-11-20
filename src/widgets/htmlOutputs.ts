/**
 * HTML Data Bridge — saídas EFÊMERAS dos blocos HTML (issue #11).
 *
 * Fronteira assíncrona (iframe) × fluxo de dados síncrono:
 * - cada montagem do iframe recebe um `token` (geração). Mensagens de gerações anteriores são descartadas;
 * - `publishOutput` valida e guarda o valor; se mudou de fato (comparação pelo JSON), agenda UM recálculo
 *   (`bumpExternalData`), agrupado no máximo a cada 50 ms. Valor repetido não dispara nada (sem tempestade);
 * - o `compute` do bloco HTML lê daqui. Nada disso vai para o quadro, histórico, backup ou exportação.
 *
 * Vida útil: as saídas sobrevivem ao desmontar por estar fora da vista (o canvas desmonta o que não aparece),
 * marcadas como `stale`, para fórmulas e gráficos ligados não piscarem ao navegar. São apagadas quando o bloco
 * é excluído, quando o HTML ou as portas mudam, ao trocar de quadro e ao recarregar a página.
 */
import { fromBridgeValue, type BridgePort } from '../core/htmlBridge';
import { getState, useEditor } from '../store/editor';
import { bumpExternalData } from './dataflow';

export interface OutputEntry {
  token: string;
  /** Assinatura das portas/HTML vigentes quando a geração começou. */
  signature: string;
  values: Record<string, unknown>;
  json: Record<string, string>;
  /** Último erro de validação por porta (sem o valor). */
  errors: Record<string, string>;
  stale: boolean;
  published: number;
  rejected: number;
  updatedAt: number;
}

const store = new Map<string, OutputEntry>();
let boardId: string | null = null;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  for (const l of listeners) l();
}

function scheduleBump() {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    bumpExternalData();
  }, 50);
}

/** Troca de quadro: tudo o que era transitório some. */
function syncBoard() {
  const b = getState().boardId;
  if (b !== boardId) {
    boardId = b;
    if (store.size) { store.clear(); notify(); }
  }
}

export function randomToken(): string {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Nova geração (montagem do iframe). Mantém valores anteriores se a assinatura (HTML+portas) não mudou. */
export function beginGeneration(elementId: string, token: string, signature: string) {
  syncBoard();
  const cur = store.get(elementId);
  const keep = cur && cur.signature === signature;
  store.set(elementId, { token, signature, values: keep ? cur.values : {}, json: keep ? cur.json : {}, errors: {}, stale: keep ? cur.stale : false, published: 0, rejected: 0, updatedAt: Date.now() });
  if (cur && !keep && Object.keys(cur.values).length) scheduleBump();
  notify();
}

/** Iframe desmontado: os valores ficam como “desatualizados”; mensagens desta geração deixam de valer. */
export function endGeneration(elementId: string, token: string) {
  const cur = store.get(elementId);
  if (!cur || cur.token !== token) return;
  store.set(elementId, { ...cur, token: '', stale: true });
  notify();
}

export function isCurrentToken(elementId: string, token: unknown): boolean {
  const cur = store.get(elementId);
  return !!cur && typeof token === 'string' && token.length > 0 && cur.token === token;
}

/** Valida e publica. Retorna o motivo da recusa (sem ecoar o valor), ou null. */
export function publishOutput(elementId: string, token: string, ports: BridgePort[], portId: unknown, raw: unknown): string | null {
  const cur = store.get(elementId);
  if (!cur || cur.token !== token) return 'Mensagem de uma execução anterior do bloco: ignorada.';
  const port = typeof portId === 'string' ? ports.find((p) => p.id === portId) : undefined;
  if (!port) {
    cur.rejected++;
    notify();
    return `Saída “${String(portId).slice(0, 40)}” não declarada neste bloco.`;
  }
  const r = fromBridgeValue(port.type, raw);
  if (!r.ok) {
    cur.errors = { ...cur.errors, [port.id]: r.error };
    cur.rejected++;
    notify();
    return `Saída “${port.id}”: ${r.error}`;
  }
  cur.published++;
  const changed = cur.json[port.id] !== r.json || cur.stale;
  if (cur.errors[port.id]) { const { [port.id]: _drop, ...rest } = cur.errors; void _drop; cur.errors = rest; }
  if (changed) {
    cur.values = { ...cur.values, [port.id]: r.value };
    cur.json = { ...cur.json, [port.id]: r.json };
    cur.stale = false;
    cur.updatedAt = Date.now();
    scheduleBump();
  }
  notify();
  return null;
}

/** Saídas atuais de um bloco (só das portas ainda declaradas). */
export function outputsOf(elementId: string, ports: BridgePort[]): Record<string, unknown> {
  syncBoard();
  const cur = store.get(elementId);
  if (!cur) return {};
  const out: Record<string, unknown> = {};
  for (const p of ports) if (Object.prototype.hasOwnProperty.call(cur.values, p.id)) out[p.id] = cur.values[p.id];
  return out;
}

export function outputEntry(elementId: string): OutputEntry | undefined {
  return store.get(elementId);
}

/** Bloco excluído ou configuração trocada: descarta tudo. */
export function clearOutputs(elementId: string) {
  if (store.delete(elementId)) { scheduleBump(); notify(); }
}

export function subscribeOutputs(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export const outputsVersion = () => version;

/** Exclusão de blocos: limpa saídas de elementos que não existem mais. */
let lastElements: unknown = null;
useEditor.subscribe((s) => {
  if (s.elements === lastElements) return;
  lastElements = s.elements;
  if (!store.size) return;
  syncBoard();
  const ids = new Set(s.elements.map((e) => e.id));
  for (const id of [...store.keys()]) if (!ids.has(id)) clearOutputs(id);
});

/** Somente testes. */
export function resetOutputsForTests() {
  store.clear();
  boardId = null;
  if (bumpTimer) { clearTimeout(bumpTimer); bumpTimer = null; }
}
