/** Issue #13 — AI Companions: dados, preferências, máquina de estados visual e microanimações. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPANION_PREFS, IDLE_REQUEST, MICRO_INTERVAL, REPLYING_MS, effectiveMotion, nextMicro, sanitizeCompanion, sanitizeCompanionPrefs, visualState, type MicroAction,
} from '../../src/core/companion';
import { sanitizeAI } from '../../src/core/widgetData';

describe('dados do companion no widget de IA', () => {
  it('backup antigo (sem campo) continua clássico e sem campo novo', () => {
    const d = sanitizeAI({ provider: 'openai', messages: [{ id: 'm', role: 'user', content: 'oi', at: 1 }] });
    expect(d.companion).toBeUndefined();
    expect(d.messages).toHaveLength(1);
  });
  it('saneamento: valores inválidos viram padrão; nome limitado; preset seguro', () => {
    expect(sanitizeCompanion({ displayMode: 'character', preset: 'Aurora<script>', name: 'x'.repeat(80), docked: 'yes' })).toEqual({ v: 1, displayMode: 'character', preset: 'aurora', name: 'x'.repeat(40), docked: false });
    expect(sanitizeCompanion({ displayMode: 'holograma', preset: 'cosmo', docked: true })).toEqual({ v: 1, displayMode: 'classic', preset: 'cosmo', name: '', docked: true });
    expect(sanitizeCompanion('lixo')).toBeUndefined();
  });
  it('mudar o visual não toca nas mensagens nem na autorização', () => {
    const base = sanitizeAI({ messages: [{ id: 'm', role: 'assistant', content: 'resposta', at: 2 }], authorized: { el1: true } });
    const next = sanitizeAI({ ...base, companion: { displayMode: 'character', preset: 'aurora', name: 'Aurora', docked: true } });
    expect(next.messages).toEqual(base.messages);
    expect(next.authorized).toEqual(base.authorized);
    expect(next.companion?.displayMode).toBe('character');
  });
});

describe('preferências', () => {
  it('saneamento e “Sistema” respeitando movimento reduzido', () => {
    expect(sanitizeCompanionPrefs({ motion: 'turbo', dock: 'top', sound: true })).toEqual(DEFAULT_COMPANION_PREFS);
    expect(effectiveMotion(DEFAULT_COMPANION_PREFS, false)).toBe('normal');
    expect(effectiveMotion(DEFAULT_COMPANION_PREFS, true)).toBe('off');
    expect(effectiveMotion({ ...DEFAULT_COMPANION_PREFS, motion: 'expressive' }, true)).toBe('expressive');
    expect(sanitizeCompanionPrefs({ sound: true }).sound).toBe(false); // áudio desligado nesta entrega
  });
});

describe('máquina de estados visual (estados reais)', () => {
  const ui = { hover: false, open: false };
  it('pendente → thinking; resolveu → replying por um instante → idle', () => {
    expect(visualState({ ...IDLE_REQUEST, status: 'sending' }, ui, 0)).toBe('thinking');
    const replied = { ...IDLE_REQUEST, repliedAt: 1000 };
    expect(visualState(replied, ui, 1000 + 100)).toBe('replying');
    expect(visualState(replied, ui, 1000 + REPLYING_MS + 1)).toBe('idle');
  });
  it('erro/cancelado param a digitação e comunicam erro', () => {
    expect(visualState({ ...IDLE_REQUEST, status: 'error', error: 'x' }, ui, 0)).toBe('error');
    expect(visualState({ ...IDLE_REQUEST, status: 'cancelled' }, ui, 0)).toBe('error');
  });
  it('não lida persiste até abrir; hover/aberto = atenção', () => {
    const unread = { ...IDLE_REQUEST, unread: true, repliedAt: 1 };
    expect(visualState(unread, ui, 99_999)).toBe('unread');
    expect(visualState(unread, { hover: false, open: true }, 99_999)).toBe('attention');
    expect(visualState(IDLE_REQUEST, { hover: true, open: false }, 0)).toBe('attention');
  });
  it('pensando tem prioridade sobre tudo', () => {
    expect(visualState({ status: 'sending', error: '', repliedAt: 1, unread: true }, { hover: true, open: true }, 2)).toBe('thinking');
  });
});

describe('microanimações', () => {
  const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
  it('intervalos raros por intensidade, nunca repete a ação seguida', () => {
    let last: MicroAction | null = null;
    const r = seq([0, 0.99, 0.5, 0.2, 0.7, 0.1]);
    for (let k = 0; k < 50; k++) {
      const m = nextMicro('normal', last, r);
      expect(m.action).not.toBe(last);
      expect(m.delay).toBeGreaterThanOrEqual(MICRO_INTERVAL.normal[0]);
      expect(m.delay).toBeLessThanOrEqual(MICRO_INTERVAL.normal[1]);
      last = m.action;
    }
    expect(MICRO_INTERVAL.discreet[0]).toBeGreaterThan(MICRO_INTERVAL.expressive[0]);
  });
  it('“Discretas” só pisca, olha e ajeita a postura', () => {
    for (const v of [0, 0.3, 0.6, 0.99]) expect(['blink', 'look', 'posture']).toContain(nextMicro('discreet', null, () => v).action);
  });
});
