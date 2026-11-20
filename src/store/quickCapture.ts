/**
 * Captura rápida / Inbox (issue #14, N1-C).
 *
 * Abordagem técnica (decidida antes do código):
 * - **Quadro atual:** o item entra pelo caminho normal (`addElements`, uma entrada de desfazer), SEM mudar seleção,
 *   câmera ou ferramenta. O autosave grava como qualquer outra alteração.
 * - **Inbox em outro quadro (fechado):** escrita direta no adaptador, DENTRO da fila única do autosave
 *   (`runExclusive`), lendo a versão gravada mais recente e acrescentando só o elemento novo. Nunca toca
 *   `getState().elements`. Recusa (sem perder o texto) se aquele quadro tem gravação pendente/falha ou diário
 *   de recuperação — nesses casos a cópia gravada não é a mais nova e escrever nela poderia sobrescrever trabalho.
 *   Se o quadro de destino for aberto ENQUANTO a escrita acontece, o item também é injetado no estado em memória
 *   (para a próxima gravação do autosave não descartá-lo).
 * - Sem nova base de tarefas: reutiliza os widgets Notas e Tarefas (mesmos esquemas e `sanitize`).
 * - Nenhuma migração: quadros e backups não ganham campos. O quadro Inbox escolhido é configuração local
 *   (`inboxBoard:<workspace>`).
 */
import { createWidget, uid } from '../core/elements';
import type { AuroraElement, Board } from '../core/schema';
import { WIDGET } from '../core/widgetIds';
import { getWidget } from '../widgets/registry';
import { getAdapter, hasUnsavedWork, runExclusive } from '../persistence/autosave';
import { migrateBoard } from '../persistence/migrations';
import { addElements, viewportCenterWorld } from './actions';
import { getState, setState } from './editor';

export type CaptureKind = 'note' | 'task';
export interface CaptureInput { kind: CaptureKind; title: string; details: string }

export const CAPTURE_LIMITS = { title: 200, details: 5000 };

/** Bloco Notas ou Tarefas com os dados já saneados pelo próprio widget. */
export function buildCaptureElement(input: CaptureInput, at: { x: number; y: number }): AuroraElement {
  const title = input.title.trim().slice(0, CAPTURE_LIMITS.title);
  const details = input.details.trim().slice(0, CAPTURE_LIMITS.details);
  if (!title) throw new Error('Escreva um título.');
  const type = input.kind === 'note' ? WIDGET.notes : WIDGET.tasks;
  const plugin = getWidget(type);
  if (!plugin) throw new Error('Bloco indisponível.');
  const raw = input.kind === 'note'
    ? { markdown: details ? `${details}` : '', mode: 'preview' }
    : { items: [{ id: uid(), text: details ? `${title} — ${details}` : title, status: 'todo', priority: 'medium', dueDate: '' }], hideDone: false };
  const data = plugin.sanitize({ ...(plugin.createData() as object), ...raw });
  const { width, height } = input.kind === 'note' ? { width: 300, height: 200 } : plugin.defaultSize;
  const el = createWidget(plugin.id, plugin.version, title, at.x - width / 2, at.y - height / 2, width, height, data);
  el.style.strokeColor = plugin.accent;
  return el;
}

/** Posição livre perto do centro da visão: cada captura seguinte desce um pouco (não empilha exatamente). */
let cascade = 0;
function captureSpot() {
  const c = viewportCenterWorld();
  const k = cascade++ % 6;
  return { x: c.x + 40 * k, y: c.y + 36 * k };
}

export interface CaptureResult { boardId: string; elementId: string; boardName: string }

/** Inbox configurado para a workspace atual (se ainda existir e não estiver arquivado). */
export async function getInboxBoardId(workspaceId = getState().workspaceId): Promise<string | null> {
  const id = await getAdapter().getSetting<string>(`inboxBoard:${workspaceId}`);
  const meta = getState().boards.find((b) => b.id === id && b.workspaceId === workspaceId);
  return meta && !meta.archived ? meta.id : null;
}
export async function setInboxBoardId(boardId: string | null, workspaceId = getState().workspaceId) {
  await getAdapter().setSetting(`inboxBoard:${workspaceId}`, boardId ?? '');
}

let lastCapture: CaptureResult | null = null;
export function lastCaptured() { return lastCapture; }

/**
 * Captura. `target` = 'current' ou o id de um quadro da workspace. Lança erro (com mensagem para o usuário) sem
 * alterar nada se não for possível gravar com segurança; o formulário mantém o texto.
 */
export async function capture(input: CaptureInput, target: 'current' | string): Promise<CaptureResult> {
  const s = getState();
  const targetId = target === 'current' ? s.boardId : target;
  const meta = s.boards.find((b) => b.id === targetId);
  if (!meta) throw new Error('O quadro de destino não existe mais. Escolha outro destino; o texto foi mantido.');
  if (targetId === s.boardId) {
    const el = buildCaptureElement(input, captureSpot());
    // Sem seleção: a seleção atual, a câmera e a ferramenta continuam como estavam.
    addElements([el], false);
    lastCapture = { boardId: targetId, elementId: el.id, boardName: meta.name };
    return lastCapture;
  }
  return appendToClosedBoard(targetId, input);
}

async function appendToClosedBoard(boardId: string, input: CaptureInput): Promise<CaptureResult> {
  return runExclusive(async () => {
    if (hasUnsavedWork(boardId)) throw new Error('Esse quadro tem alterações ainda não gravadas. Abra-o uma vez (ou capture no quadro atual); o texto foi mantido.');
    const adapter = getAdapter();
    const raw = await adapter.loadBoard(boardId);
    if (!raw) throw new Error('O quadro de destino não existe mais; o texto foi mantido.');
    const { board } = migrateBoard(raw, raw.workspaceId);
    // Ponto livre: abaixo de tudo o que já existe no Inbox (ou na origem do quadro vazio).
    const bottom = board.elements.reduce((m, e) => Math.max(m, e.y + ('height' in e ? (e as { height: number }).height : 0)), -Infinity);
    const left = board.elements.length ? Math.min(...board.elements.map((e) => e.x)) : 0;
    const el = buildCaptureElement(input, { x: left + 150, y: (Number.isFinite(bottom) ? bottom + 40 : 0) + 100 });
    const next: Board = { ...board, elements: [...board.elements, el], updatedAt: Date.now() };
    await adapter.saveBoard(next);
    // O quadro foi aberto enquanto gravávamos? Injeta também no estado para o autosave não perder o item.
    const st = getState();
    if (st.boardId === boardId && !st.elements.some((e) => e.id === el.id)) addElements([el], false);
    setState({ boards: st.boards.map((b) => (b.id === boardId ? { ...b, updatedAt: next.updatedAt } : b)) });
    lastCapture = { boardId, elementId: el.id, boardName: board.name };
    return lastCapture;
  });
}
