/** Agrupamento (grupos aninhados), ordem de camadas e frames — operações puras. */
import type { AuroraElement } from './schema';
import { uid } from './elements';
import { boxContains, getElementBounds } from './geometry';

/** Grupo "selecionável" de um elemento dado o grupo em edição (entrar em grupo com duplo clique). */
export function selectableGroupId(el: AuroraElement, editingGroupId: string | null): string | null {
  if (!el.groupIds.length) return null;
  if (!editingGroupId) return el.groupIds[el.groupIds.length - 1];
  const idx = el.groupIds.indexOf(editingGroupId);
  if (idx === -1) return el.groupIds[el.groupIds.length - 1];
  return idx > 0 ? el.groupIds[idx - 1] : null;
}

export function elementsInGroup(elements: AuroraElement[], groupId: string): AuroraElement[] {
  return elements.filter((e) => e.groupIds.includes(groupId));
}

/** Expande uma seleção para incluir todos os membros dos grupos selecionáveis. */
export function expandToGroups(elements: AuroraElement[], ids: Iterable<string>, editingGroupId: string | null): Set<string> {
  const out = new Set<string>();
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    out.add(id);
    const g = selectableGroupId(el, editingGroupId);
    if (g) for (const m of elements) if (m.groupIds.includes(g)) out.add(m.id);
  }
  return out;
}

/** Cria um novo grupo com os elementos selecionados. Membros ficam contíguos na ordem de camadas. */
export function groupElements(elements: AuroraElement[], ids: Set<string>, editingGroupId: string | null): { elements: AuroraElement[]; groupId: string | null } {
  if (ids.size < 2) return { elements, groupId: null };
  const groupId = uid('g_');
  let topIndex = -1;
  const updated = elements.map((el, i) => {
    if (!ids.has(el.id)) return el;
    topIndex = Math.max(topIndex, i);
    const groupIds = [...el.groupIds];
    const editIdx = editingGroupId ? groupIds.indexOf(editingGroupId) : -1;
    if (editIdx >= 0) groupIds.splice(editIdx, 0, groupId);
    else groupIds.push(groupId);
    return { ...el, groupIds, version: el.version + 1, updatedAt: Date.now() };
  });
  // Torna os membros contíguos na posição do membro mais ao topo.
  const members = updated.filter((e) => ids.has(e.id));
  const before = updated.slice(0, topIndex + 1).filter((e) => !ids.has(e.id));
  const after = updated.slice(topIndex + 1);
  return { elements: [...before, ...members, ...after], groupId };
}

/** Desfaz o nível de grupo selecionável dos elementos selecionados. */
export function ungroupElements(elements: AuroraElement[], ids: Set<string>, editingGroupId: string | null): AuroraElement[] {
  const groupsToRemove = new Set<string>();
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    const g = selectableGroupId(el, editingGroupId);
    if (g) groupsToRemove.add(g);
  }
  if (!groupsToRemove.size) return elements;
  return elements.map((el) => {
    if (!el.groupIds.some((g) => groupsToRemove.has(g))) return el;
    return { ...el, groupIds: el.groupIds.filter((g) => !groupsToRemove.has(g)), version: el.version + 1, updatedAt: Date.now() };
  });
}

export type ReorderOp = 'front' | 'back' | 'forward' | 'backward';

export function reorder(elements: AuroraElement[], ids: Set<string>, op: ReorderOp): AuroraElement[] {
  if (!ids.size) return elements;
  if (op === 'front') return [...elements.filter((e) => !ids.has(e.id)), ...elements.filter((e) => ids.has(e.id))];
  if (op === 'back') return [...elements.filter((e) => ids.has(e.id)), ...elements.filter((e) => !ids.has(e.id))];
  const arr = [...elements];
  if (op === 'forward') {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (ids.has(arr[i].id) && !ids.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      if (ids.has(arr[i].id) && !ids.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
    }
  }
  return arr;
}

/** Recalcula a qual frame cada elemento (não frame) pertence, pelo contido nos limites. */
export function assignFrames(elements: AuroraElement[], onlyIds?: Set<string>): AuroraElement[] {
  const frames = elements.filter((e) => e.type === 'frame');
  let changed = false;
  const out = elements.map((el) => {
    if (el.type === 'frame' || (onlyIds && !onlyIds.has(el.id))) return el;
    const b = getElementBounds(el);
    const frame = [...frames].reverse().find((f) => boxContains(getElementBounds(f), b));
    const frameId = frame?.id ?? null;
    if (frameId === el.frameId) return el;
    changed = true;
    return { ...el, frameId };
  });
  return changed ? out : elements;
}

/** Elementos que se movem junto (membros de frames selecionados). */
export function withFrameChildren(elements: AuroraElement[], ids: Set<string>): Set<string> {
  const out = new Set(ids);
  const frameIds = elements.filter((e) => e.type === 'frame' && ids.has(e.id)).map((e) => e.id);
  if (!frameIds.length) return out;
  for (const el of elements) if (el.frameId && frameIds.includes(el.frameId)) out.add(el.id);
  return out;
}
