import type { PersistenceAdapter } from '../persistence/adapter';
import { clearJournal, readJournal, setAdapter, startAutosave } from '../persistence/autosave';
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
      first.camera = { x: getState().viewport.width / 2, y: getState().viewport.height / 2, zoom: 1 };
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
    const journal = readJournal();
    if (journal) {
      const stored = await adapter.loadBoard(journal.boardId);
      const ws = workspaces.find((w) => w.id === journal.board.workspaceId);
      if (ws && (!stored || journal.board.updatedAt >= stored.updatedAt) && JSON.stringify(stored?.elements) !== JSON.stringify(journal.board.elements)) {
        const { board } = migrateBoard(journal.board, ws.id);
        await adapter.saveBoard(board);
        if (!ws.boardOrder.includes(board.id)) {
          ws.boardOrder.push(board.id);
          await adapter.saveWorkspace(ws);
        }
        notes.push(`Alterações não salvas de “${board.name}” foram recuperadas.`);
      }
      clearJournal();
    }

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
