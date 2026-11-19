import type { Asset, Board } from '../core/schema';
import { uid } from '../core/elements';
import { getState, setState } from '../store/editor';
import { getAsset, openBoard, refreshBoards, selectedElements } from '../store/actions';
import { openDialog, toast } from '../store/ui';
import { flushSave, getAdapter, snapshotCurrentBoard } from '../persistence/autosave';
import { applyImport, assetIdsOf, buildExport, checkImportFileSize, downloadBlob, downloadText, ImportError, parseImport, safeFileName } from '../persistence/exportImport';
import { LEGACY_STORAGE_KEY } from '../persistence/legacy';
import { exportPNG, exportSVG } from '../render/exportImage';

async function collectAssets(boards: Board[]): Promise<Asset[]> {
  const ids = new Set<string>();
  for (const b of boards) for (const id of assetIdsOf(b.elements)) ids.add(id);
  const out: Asset[] = [];
  for (const id of ids) {
    const a = await getAsset(id);
    if (a) out.push(a);
  }
  return out;
}

export async function exportCurrentBoardJSON() {
  await flushSave();
  const board = snapshotCurrentBoard();
  if (!board) return;
  const ws = getState().workspaces.find((w) => w.id === getState().workspaceId);
  downloadText(`${safeFileName(board.name)}.aurora.json`, buildExport([board], await collectAssets([board]), ws));
  toast('Quadro exportado (JSON).', 'success');
}

export async function exportWorkspaceJSON() {
  await flushSave();
  const s = getState();
  const boards: Board[] = [];
  for (const m of s.boards) {
    const b = await getAdapter().loadBoard(m.id);
    if (b) boards.push(b);
  }
  const ws = s.workspaces.find((w) => w.id === s.workspaceId);
  downloadText(`${safeFileName(ws?.name ?? 'workspace')}-backup-${new Date().toISOString().slice(0, 10)}.aurora.json`, buildExport(boards, await collectAssets(boards), ws));
  toast(`Backup com ${boards.length} quadro(s) exportado.`, 'success');
}

export async function exportImage(kind: 'png' | 'svg', onlySelection: boolean, background = true) {
  const s = getState();
  const els = onlySelection && s.selectedIds.length ? selectedElements() : s.elements;
  if (!els.length) { toast('Nada para exportar.', 'warning'); return; }
  const name = safeFileName(s.boards.find((b) => b.id === s.boardId)?.name ?? 'quadro');
  try {
    if (kind === 'svg') {
      const { svg } = await exportSVG(els, { background });
      downloadText(`${name}.svg`, svg, 'image/svg+xml');
    } else {
      downloadBlob(`${name}.png`, await exportPNG(els, { background, scale: 2 }));
    }
    toast(`Imagem ${kind.toUpperCase()} exportada.`, 'success');
  } catch (e) {
    toast(`Falha ao exportar: ${(e as Error).message}`, 'error');
  }
}

export function pickImportFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    // Tamanho checado ANTES de ler: um arquivo gigante nunca é carregado na memória (S1-SEC-004).
    try {
      checkImportFileSize(f.size);
    } catch (e) {
      void openDialog({ title: 'Importação recusada', message: `“${f.name}”: ${(e as Error).message} Nenhum dado foi alterado.`, buttons: [{ label: 'Ok', value: 'ok', variant: 'primary' }] });
      return;
    }
    void importFromText(f.name, f.text());
  };
  input.click();
}

export async function importLegacyFromBrowser() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) { toast('Nenhum dado do protótipo v0.2/v0.3 encontrado neste navegador.', 'info'); return; }
  await importFromText('localStorage (v0.3)', Promise.resolve(raw));
}

export async function importFromText(name: string, textP: Promise<string>) {
  const s = getState();
  let result;
  try {
    result = parseImport(await textP, s.workspaceId);
  } catch (e) {
    const msg = e instanceof ImportError ? e.message : `Erro inesperado: ${(e as Error).message}`;
    await openDialog({ title: 'Importação recusada', message: `“${name}”: ${msg} Nenhum dado foi alterado.`, buttons: [{ label: 'Ok', value: 'ok', variant: 'primary' }] });
    return;
  }
  const r = result;
  const { button } = await openDialog({
    title: 'Importar quadros',
    wide: true,
    body: (
      <div className="text-[12px] text-fg-2 flex flex-col gap-2">
        <div>
          Origem: <b>{r.source === 'aurora' ? 'Backup do Aurora Board' : 'Protótipo Aurora Board v0.2/v0.3'}</b> — {r.stats.boards} quadro(s), {r.stats.elements} elemento(s).
        </div>
        <ul className="list-disc pl-5 max-h-32 overflow-auto">
          {r.boards.map((b) => <li key={b.id}>{b.name} <span className="text-soft">({b.elements.length} elementos)</span></li>)}
        </ul>
        <div className="rounded-md border border-accent/30 bg-accent/10 p-2">Os quadros serão <b>adicionados como novos</b> ao workspace atual. Nenhum quadro existente será substituído.</div>
        {r.warnings.length > 0 && (
          <details open={r.warnings.length < 6}>
            <summary className="cursor-pointer text-warn">{r.warnings.length} aviso(s) de compatibilidade</summary>
            <ul className="list-disc pl-5 max-h-40 overflow-auto text-[11px] text-muted mt-1">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
      </div>
    ),
    buttons: [
      { label: 'Cancelar', value: 'cancel', variant: 'ghost' },
      { label: 'Importar como novos quadros', value: 'ok', variant: 'primary' },
    ],
  });
  if (button !== 'ok') return;
  const ws = getState().workspaces.find((w) => w.id === getState().workspaceId)!;
  let ids: string[], updated;
  try {
    ({ boardIds: ids, workspace: updated } = await applyImport(getAdapter(), r, ws, () => uid('b_')));
  } catch (e) {
    // A gravação é uma transação única: se falhou, nada foi gravado (S1-SEC-006).
    const msg = e instanceof ImportError ? e.message : `Falha ao gravar: ${(e as Error).message}`;
    await openDialog({ title: 'Importação interrompida', message: `“${name}”: ${msg} Nenhum quadro ou arquivo foi gravado; seus quadros existentes não foram alterados.`, buttons: [{ label: 'Ok', value: 'ok', variant: 'primary' }] });
    return;
  }
  setState({ workspaces: getState().workspaces.map((w) => (w.id === ws.id ? updated : w)) });
  await refreshBoards();
  await openBoard(ids[0]);
  toast(`${ids.length} quadro(s) importado(s).`, 'success');
}
