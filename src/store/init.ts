import type { PersistenceAdapter } from '../persistence/adapter';
import { sanitizeZoomPrefs } from '../core/camera';
import { sanitizeAnimationPrefs } from '../core/animation';
import { sanitizePanelWidths } from '../core/panels';
import { clearJournal, readJournals, setAdapter, startAutosave } from '../persistence/autosave';
import { migrateBoard } from '../persistence/migrations';
import { importLegacy, LEGACY_STORAGE_KEY } from '../persistence/legacy';
import { createBoard, createWorkspace } from '../core/elements';
import { getState, setState } from './editor';
import { openBoard, refreshBoards, createBoard as createBoardAction } from './actions';
import { toast } from './ui';
import { buildDemoBoard } from './demo';

let stopAutosave: (() => void) | null = null;

export async function initEditor(adapter: PersistenceAdapter, opts: { demo?: boolean } = {}) {
  setAdapter(adapter);
  try {
    let workspaces = await adapter.listWorkspaces();
    const notes: string[] = [];

    if (!workspaces.length) {
      const ws = createWorkspace('Meu workspace');
      const first = createBoard(ws.id, 'Meu primeiro quadro', 'Quadro livre.');
      // O canvas ainda não foi medido: estima o tamanho pela janela (painéis abertos só em telas largas).
      const est = estimateCanvasSize();
      first.camera = { x: Math.round(est.width / 2), y: Math.round(est.height / 2), zoom: 1 };
      const boards = [first];
      if (opts.demo !== false) boards.push(buildDemoBoard(ws.id));
      // Dados do protótipo v0.2/v0.3 no mesmo navegador: importados sem apagar o original.
      try {
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          const r = importLegacy(JSON.parse(legacyRaw), ws.id);
          for (const a of r.assets) await adapter.putAsset(a);
          boards.push(...r.boards);
          if (r.boards.length) notes.push(`${r.boards.length} quadro(s) do Aurora Board v0.3 importado(s) deste navegador.`);
        }
      } catch {
        notes.push('Dados do protótipo v0.3 encontrados, mas ilegíveis — mantidos intactos no navegador.');
      }
      for (const b of boards) await adapter.saveBoard(b);
      ws.boardOrder = boards.map((b) => b.id);
      await adapter.saveWorkspace(ws);
      await adapter.setSetting('lastBoard:' + ws.id, first.id);
      workspaces = [ws];
    }

    // Recuperação de alterações não confirmadas no IndexedDB.
    // Um diário por quadro: cada um é comparado com o que está gravado.
    for (const journal of readJournals()) {
      const ws = workspaces.find((w) => w.id === journal.board.workspaceId);
      if (!ws) {
        // Quadro de outro workspace/banco: mantém o diário para não descartar dados.
        console.warn('Diário de recuperação sem workspace correspondente mantido:', journal.boardId);
        continue;
      }
      const stored = await adapter.loadBoard(journal.boardId);
      const differs = JSON.stringify(stored?.elements) !== JSON.stringify(journal.board.elements) || stored?.name !== journal.board.name || stored?.description !== journal.board.description;
      if ((!stored || journal.board.updatedAt >= stored.updatedAt) && differs) {
        const { board } = migrateBoard(journal.board, ws.id);
        await adapter.saveBoard(board);
        if (!ws.boardOrder.includes(board.id)) {
          ws.boardOrder.push(board.id);
          await adapter.saveWorkspace(ws);
        }
        notes.push(`Alterações não salvas de “${board.name}” foram recuperadas.`);
      }
      clearJournal(journal.boardId);
    }

    setState({ zoomPrefs: sanitizeZoomPrefs(await adapter.getSetting('zoomPreferences')), animationPrefs: sanitizeAnimationPrefs(await adapter.getSetting('animationPreferences')), panelWidths: sanitizePanelWidths(await adapter.getSetting('panelWidths')) });
    const last = await adapter.getSetting<string>('lastWorkspace');
    const workspaceId = workspaces.some((w) => w.id === last) ? last! : workspaces[0].id;
    setState({ workspaces, workspaceId });
    await refreshBoards();
    const boards = getState().boards.filter((b) => !b.archived);
    const lastBoard = await adapter.getSetting<string>(`lastBoard:${workspaceId}`);
    const target = boards.find((b) => b.id === lastBoard) ?? boards[0];
    if (target) await openBoard(target.id);
    else {
      setState({ status: 'ready' });
      await createBoardAction('Meu primeiro quadro');
    }
    setState({ status: 'ready', saveState: 'saved' });
    stopAutosave?.();
    stopAutosave = startAutosave();
    for (const n of notes) toast(n, 'success', 6000);
  } catch (e) {
    console.error(e);
    setState({ status: 'error', loadError: (e as Error).message || String(e) });
  }
}

/** Tamanho provável do canvas antes da primeira medição (topo 56px; painéis 256+288px em telas ≥ 900px). */
export function estimateCanvasSize(): { width: number; height: number } {
  if (typeof window === 'undefined' || !window.innerWidth) return getState().viewport;
  const w = window.innerWidth, h = window.innerHeight;
  return { width: w >= 900 ? Math.max(320, w - 256 - 288) : w, height: Math.max(200, h - 56) };
}
