import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { registerSandboxedPlugin } from '../../src/widgets/thirdParty';
import { getWidget, listWidgets } from '../../src/widgets/registry';
import { WIDGET } from '../../src/core/widgetIds';

beforeAll(() => registerBuiltinWidgets());

const manifest = {
  id: 'com.exemplo.contador',
  name: 'Contador',
  description: 'Exemplo',
  version: '1.0.0',
  permissions: ['sandbox:scripts'],
  html: '<button>+</button>',
  defaultSize: { width: 200, height: 120 },
  outputs: [{ id: 'n', label: 'Valor', type: 'number' }],
};

describe('registro de plugins', () => {
  it('todos os widgets nativos declaram contrato completo', () => {
    const ids = listWidgets().map((w) => w.id);
    for (const id of Object.values(WIDGET)) expect(ids).toContain(id);
    for (const w of listWidgets()) {
      expect(w.version).toMatch(/^\d+\.\d+\.\d+$/);
      const data = w.createData();
      expect(w.sanitize(data)).toEqual(w.sanitize(w.sanitize(data))); // sanitize idempotente
      expect(typeof w.summarize(data, {} as never)).toBe('string');
    }
  });

  it('plugin de terceiros por manifesto: validado, isolado e sem HTML nos dados do quadro', () => {
    const p = registerSandboxedPlugin(manifest);
    expect(getWidget('com.exemplo.contador')).toBe(p);
    // o HTML salvo no quadro é ignorado: só o estado é mantido
    expect(p.sanitize({ html: '<script>roubar()</script>', state: { n: 3 } })).toEqual({ html: '', state: { n: 3 } });
    expect(p.compute!({ html: '', state: { n: 3 } }, {}, {} as never)).toEqual({ n: 3 });
  });

  it('rejeita manifestos inválidos, ids duplicados e prefixo reservado', () => {
    expect(() => registerSandboxedPlugin({ ...manifest, id: 'Sem Formato' })).toThrow();
    expect(() => registerSandboxedPlugin({ ...manifest, permissions: ['root:tudo'] })).toThrow();
    expect(() => registerSandboxedPlugin(manifest)).toThrow(/Já existe/);
    expect(() => registerSandboxedPlugin({ ...manifest, id: 'aurora.falso' })).toThrow(/reservado/);
  });
});
