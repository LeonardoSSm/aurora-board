/** Conexões: mantém setas/linhas ancoradas acompanhando os elementos conectados. */
import type { AuroraElement, Binding, LinearElement } from './schema';
import { isLinear } from './schema';
import { boundaryPointTowards, elementCenter, fixedPointToWorld, rotatePoint, sideOfFixedPoint, type Side, type Vec } from './geometry';

const FIXED_GAP = 5;

function fixedAnchor(el: AuroraElement, fp: [number, number]): Vec {
  const p = fixedPointToWorld(el, fp);
  const side = sideOfFixedPoint(fp);
  const n = side === 'left' ? { x: -1, y: 0 } : side === 'right' ? { x: 1, y: 0 } : side === 'top' ? { x: 0, y: -1 } : { x: 0, y: 1 };
  const rn = rotatePoint(n, { x: 0, y: 0 }, el.angle);
  return { x: p.x + rn.x * FIXED_GAP, y: p.y + rn.y * FIXED_GAP };
}

/** Referência usada para orientar a outra ponta (centro do alvo ou ponto fixo). */
function referencePoint(binding: Binding | null, target: AuroraElement | undefined, fallback: Vec): Vec {
  if (!binding || !target) return fallback;
  if (binding.fixedPoint) return fixedPointToWorld(target, binding.fixedPoint);
  return elementCenter(target);
}

export function bindingSides(el: LinearElement): { start: Side | null; end: Side | null } {
  return {
    start: el.startBinding?.fixedPoint ? sideOfFixedPoint(el.startBinding.fixedPoint) : null,
    end: el.endBinding?.fixedPoint ? sideOfFixedPoint(el.endBinding.fixedPoint) : null,
  };
}

/** Recalcula as pontas de uma seta a partir de seus vínculos. Remove vínculos órfãos. */
export function resolveLinear(el: LinearElement, byId: Map<string, AuroraElement>): LinearElement {
  const startEl = el.startBinding ? byId.get(el.startBinding.elementId) : undefined;
  const endEl = el.endBinding ? byId.get(el.endBinding.elementId) : undefined;
  const startBinding = startEl ? el.startBinding : null;
  const endBinding = endEl ? el.endBinding : null;
  if (!startBinding && !endBinding) {
    if (startBinding === el.startBinding && endBinding === el.endBinding) return el;
    return { ...el, startBinding, endBinding };
  }
  const last = el.points[el.points.length - 1];
  const absStart = { x: el.x, y: el.y };
  const absEnd = { x: el.x + last[0], y: el.y + last[1] };

  // Pontos intermediários ficam fixos no mundo; as pontas se orientam pelo ponto vizinho.
  const innerAbs = el.points.slice(1, -1).map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  const startRef = referencePoint(startBinding, startEl, absStart);
  const endRef = referencePoint(endBinding, endEl, absEnd);
  const towardsFromStart = innerAbs[0] ?? endRef;
  const towardsFromEnd = innerAbs[innerAbs.length - 1] ?? startRef;

  let s = absStart, e = absEnd;
  if (startBinding && startEl) {
    s = startBinding.fixedPoint ? fixedAnchor(startEl, startBinding.fixedPoint) : boundaryPointTowards(startEl, towardsFromStart).point;
  }
  if (endBinding && endEl) {
    e = endBinding.fixedPoint ? fixedAnchor(endEl, endBinding.fixedPoint) : boundaryPointTowards(endEl, towardsFromEnd).point;
  }
  const inner = innerAbs.map((p) => [p.x - s.x, p.y - s.y] as [number, number]);
  const points: [number, number][] = [[0, 0], ...inner, [e.x - s.x, e.y - s.y]];
  const minX = Math.min(...points.map((p) => p[0])), maxX = Math.max(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1])), maxY = Math.max(...points.map((p) => p[1]));
  return {
    ...el,
    x: s.x,
    y: s.y,
    points,
    width: maxX - minX,
    height: maxY - minY,
    startBinding,
    endBinding,
  };
}

/**
 * Atualiza todas as setas vinculadas aos elementos alterados.
 * Se `changedIds` não for informado, recalcula todas as setas vinculadas.
 */
export function updateBoundArrows(elements: AuroraElement[], changedIds?: Set<string>): AuroraElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  let changed = false;
  const out = elements.map((el) => {
    if (!isLinear(el) || (!el.startBinding && !el.endBinding)) return el;
    if (changedIds) {
      const touches =
        changedIds.has(el.id) ||
        (el.startBinding && changedIds.has(el.startBinding.elementId)) ||
        (el.endBinding && changedIds.has(el.endBinding.elementId));
      if (!touches) return el;
    }
    const next = resolveLinear(el, byId);
    if (next !== el) changed = true;
    return next;
  });
  return changed ? out : elements;
}

/** Remove vínculos que apontam para elementos excluídos. */
export function unbindDeleted(elements: AuroraElement[], deleted: Set<string>): AuroraElement[] {
  return elements.map((el) => {
    if (!isLinear(el)) return el;
    const sb = el.startBinding && deleted.has(el.startBinding.elementId) ? null : el.startBinding;
    const eb = el.endBinding && deleted.has(el.endBinding.elementId) ? null : el.endBinding;
    if (sb === el.startBinding && eb === el.endBinding) return el;
    return { ...el, startBinding: sb, endBinding: eb };
  });
}

/** Todas as conexões (setas vinculadas nas duas pontas) de/para um elemento. */
export function connectionsOf(elements: AuroraElement[], id: string): LinearElement[] {
  return elements.filter(
    (el): el is LinearElement => isLinear(el) && (el.startBinding?.elementId === id || el.endBinding?.elementId === id),
  );
}
