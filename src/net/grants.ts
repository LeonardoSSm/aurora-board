/**
 * H2 — autorizações de rede PERSISTENTES (“Permitir sempre neste dispositivo”).
 *
 * Ficam na configuração local `htmlNetGrants` (IndexedDB `aurora-board`, área `kv`): fora do JSON do quadro, dos
 * backups e das exportações. São separadas das autorizações de IA (`htmlAiGrants`, `datasetAiGrants`, `aiGrants`
 * do razão) — nenhuma reaproveita a outra.
 */
import { getState, setState } from '../store/editor';
import { getAdapter } from '../persistence/autosave';
import { sanitizeNetGrants, type NetGrant } from './policy';

async function save(next: NetGrant[]) {
  setState({ htmlNetGrants: next });
  await getAdapter().setSetting('htmlNetGrants', next);
}

/** Grava (substitui a anterior do mesmo bloco/quadro/origem/tipo). */
export async function addNetGrants(grants: NetGrant[]) {
  const id = (g: NetGrant) => `${g.kind}|${g.elementId}|${g.boardId}|${g.origin}`;
  const ids = new Set(grants.map(id));
  await save(sanitizeNetGrants([...getState().htmlNetGrants.filter((g) => !ids.has(id(g))), ...grants]));
}

/** Remove concessões de um bloco (todas, ou só de uma origem). Retorna quantas saíram. */
export async function removeNetGrants(elementId: string, boardId: string, origin?: string): Promise<number> {
  const cur = getState().htmlNetGrants;
  const next = cur.filter((g) => !(g.elementId === elementId && g.boardId === boardId && (!origin || g.origin === origin)));
  if (next.length === cur.length) return 0;
  await save(next);
  return cur.length - next.length;
}

export function netGrantsOf(elementId: string, boardId: string): NetGrant[] {
  return getState().htmlNetGrants.filter((g) => g.elementId === elementId && g.boardId === boardId);
}
