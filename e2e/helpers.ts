import { expect, type Page } from '@playwright/test';

export interface El { id: string; type: string; x: number; y: number; width: number; height: number; text: string; groupIds: string[]; widgetType?: string; title?: string; data?: any; assetId?: string; animation?: { playback: string; loop: string }; points?: [number, number][]; startBinding?: any; endBinding?: any; style: any }

export async function state(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__aurora.getState();
    return { elements: s.elements, selectedIds: s.selectedIds, camera: s.camera, boards: s.boards, boardId: s.boardId, tool: s.tool, editingTextId: s.editingTextId, saveState: s.saveState };
  }) as Promise<{ elements: El[]; selectedIds: string[]; camera: { x: number; y: number; zoom: number }; boards: { id: string; name: string }[]; boardId: string; tool: string; editingTextId: string | null; saveState: string }>;
}

export async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForFunction(() => (window as any).__aurora?.getState().status === 'ready');
}

/** Converte coordenadas do mundo para coordenadas da página. */
export async function toPage(page: Page, x: number, y: number) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const { camera } = await state(page);
  return { x: box.x + x * camera.zoom + camera.x, y: box.y + y * camera.zoom + camera.y };
}

export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { steps?: number } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 8 });
  await page.mouse.up();
}

export async function drawShape(page: Page, key: string, x1: number, y1: number, x2: number, y2: number) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press(key);
  await drag(page, await toPage(page, x1, y1), await toPage(page, x2, y2));
}

export async function waitSaved(page: Page) {
  await page.waitForFunction(() => (window as any).__aurora.getState().saveState === 'saved', undefined, { timeout: 5000 });
}

/** Compara campos numéricos com tolerância (WebKit arredonda coordenadas do mouse). */
export function expectNear(obj: object, expected: Record<string, number>, tol = 1) {
  const o = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) expect(Math.abs(Number(o[k]) - v), `${k}: ${o[k]} ≈ ${v}`).toBeLessThanOrEqual(tol);
}

/** Ponto de fundo dentro do canvas visível (região inferior direita, longe da barra e do zoom). */
export async function emptyCanvasPoint(page: Page) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  return { x: box.x + box.width * 0.82, y: box.y + box.height * 0.82 };
}
