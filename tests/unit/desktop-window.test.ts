/** D1-D — estado da janela e ações do menu nativo (puros). */
import { describe, expect, it } from 'vitest';
import { resolveWindowState, sanitizeWindowState } from '../../desktop/windowState';
import { isMenuAction, MENU_ACTIONS } from '../../desktop/menuActions';

const FULLHD = { x: 0, y: 0, width: 1920, height: 1040 };
const LAPTOP = { x: 0, y: 0, width: 1366, height: 728 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('estado da janela', () => {
  it('arquivo editável: só números finitos, tamanho mínimo e máximo', () => {
    expect(sanitizeWindowState({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true })).toEqual({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true });
    for (const bad of [null, 'x', { bounds: { x: 0, y: 0, width: 100, height: 800 } }, { bounds: { x: NaN, y: 0, width: 1200, height: 800 } }, { bounds: { x: 0, y: 0, width: 99999, height: 800 } }, { bounds: 'x' }]) expect(sanitizeWindowState(bad)).toBeNull();
  });

  it('primeira abertura: centralizada; maximizada em telas pequenas', () => {
    expect(resolveWindowState(null, [FULLHD], FULLHD)).toEqual({ bounds: { x: 240, y: 70, width: 1440, height: 900 }, maximized: false });
    expect(resolveWindowState(null, [LAPTOP], LAPTOP)).toMatchObject({ bounds: { width: 1366, height: 728 }, maximized: true });
  });

  it('vários monitores: reabre no segundo monitor; monitor desconectado → volta ao principal', () => {
    const saved = { bounds: { x: 2100, y: 100, width: 1600, height: 1000 }, maximized: false };
    expect(resolveWindowState(saved, [FULLHD, RIGHT], FULLHD)).toEqual(saved);
    const back = resolveWindowState(saved, [FULLHD], FULLHD);
    expect(back.bounds.x).toBeGreaterThanOrEqual(0);
    expect(back.bounds.x + back.bounds.width).toBeLessThanOrEqual(1920);
    expect(back.maximized).toBe(false);
  });

  it('janela maior que o monitor atual é reduzida ao monitor; maximizada continua maximizada', () => {
    const r = resolveWindowState({ bounds: { x: 0, y: 0, width: 2500, height: 1400 }, maximized: true }, [LAPTOP], LAPTOP);
    expect(r.bounds.width).toBeLessThanOrEqual(1366);
    expect(r.maximized).toBe(true);
  });
});

describe('menu nativo', () => {
  it('só ações conhecidas chegam ao renderer', () => {
    for (const a of MENU_ACTIONS) expect(isMenuAction(a)).toBe(true);
    for (const a of ['quit', 'eval', 'open-file', '', 1, null]) expect(isMenuAction(a)).toBe(false);
  });
});
