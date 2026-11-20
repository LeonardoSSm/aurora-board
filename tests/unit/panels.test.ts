/** Issue #10 — larguras das laterais: saneamento do valor salvo e limites pela janela. */
import { describe, expect, it } from 'vitest';
import { effectivePanelWidth, maxPanelWidth, MIN_CANVAS, PANEL_DEFAULTS, PANEL_MAX, PANEL_MIN, sanitizePanelWidths } from '../../src/core/panels';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { getAdapter, setAdapter } from '../../src/persistence/autosave';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { resetPanelWidth, setPanelWidth } from '../../src/store/actions';

describe('sanitizePanelWidths', () => {
  it('ausente ou lixo → padrão (256/288)', () => {
    expect(sanitizePanelWidths(undefined)).toEqual(PANEL_DEFAULTS);
    expect(sanitizePanelWidths('x')).toEqual(PANEL_DEFAULTS);
    expect(sanitizePanelWidths({ library: 'a', properties: Number.NaN })).toEqual(PANEL_DEFAULTS);
    expect(sanitizePanelWidths({ library: Infinity, properties: null })).toEqual(PANEL_DEFAULTS);
  });
  it('fora dos limites → limitado a 220–650 e arredondado', () => {
    expect(sanitizePanelWidths({ library: 10, properties: 1e9 })).toEqual({ library: PANEL_MIN, properties: PANEL_MAX });
    expect(sanitizePanelWidths({ library: 300.6, properties: 400.2 })).toEqual({ library: 301, properties: 400 });
  });
});

describe('largura efetiva', () => {
  it('janela larga: vale o valor salvo', () => {
    expect(effectivePanelWidth(500, 1600, { compact: false, otherOpen: true, other: 256 })).toBe(500);
  });
  it('janela estreita: encolhe para preservar o canvas mínimo, sem alterar o salvo', () => {
    const w = effectivePanelWidth(650, 1100, { compact: false, otherOpen: true, other: 256 });
    expect(w).toBe(1100 - MIN_CANVAS - 256);
    expect(w + 256 + MIN_CANVAS).toBeLessThanOrEqual(1100);
  });
  it('a outra lateral fechada libera espaço; máximo absoluto continua 650', () => {
    expect(maxPanelWidth(1100, { otherOpen: false, other: 256 })).toBe(PANEL_MAX);
    expect(maxPanelWidth(3000, { otherOpen: true, other: 650 })).toBe(PANEL_MAX);
  });
  it('compacto: sobreposto, limitado a 85% da janela', () => {
    expect(effectivePanelWidth(650, 400, { compact: true, otherOpen: false, other: 0 })).toBe(340);
    expect(effectivePanelWidth(288, 800, { compact: true, otherOpen: false, other: 0 })).toBe(288);
  });
});

describe('ações', () => {
  it('setPanelWidth grava só a lateral pedida (saneada); reset volta ao padrão', async () => {
    setState({ ...initialEditorState });
    setAdapter(new MemoryAdapter());
    await setPanelWidth('properties', 999);
    expect(getState().panelWidths).toEqual({ library: 256, properties: PANEL_MAX });
    await setPanelWidth('library', 100);
    expect(getState().panelWidths.library).toBe(PANEL_MIN);
    await resetPanelWidth('properties');
    expect(getState().panelWidths.properties).toBe(288);
    // Gravado nas configurações locais (fora de qualquer quadro).
    expect(await getAdapter().getSetting('panelWidths')).toEqual({ library: PANEL_MIN, properties: 288 });
  });
});
