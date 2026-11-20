/**
 * AI Companions (issue #13): (1) inspetor do assistente selecionado — visual, personagem, nome e dock (dados do
 * widget, entram no desfazer); (2) preferências pessoais de animação/dock (configuração local, fora dos quadros).
 */
import type { WidgetProps } from '../../widgets/registry';
import type { AIData } from '../../core/widgetData';
import { COMPANION_MOTION_LABEL, DEFAULT_COMPANION, type CompanionMotion, type DisplayMode } from '../../core/companion';
import { CHARACTER_PRESETS } from '../../companions/presets';
import { useEditor } from '../../store/editor';
import { setCompanionPrefs } from '../../store/actions';
import { Label, Segmented } from '../primitives';

export function CompanionInspector({ data, update }: WidgetProps<AIData>) {
  const c = data.companion ?? DEFAULT_COMPANION;
  const set = (patch: Partial<typeof c>) => update({ companion: { ...c, ...patch } } as Partial<AIData>);
  return (
    <div data-testid="companion-inspector">
      <Label>Visual do assistente</Label>
      <Segmented<DisplayMode> label="Visual do assistente" value={c.displayMode} onChange={(displayMode) => set({ displayMode })} options={[{ value: 'classic', label: 'Clássico' }, { value: 'character', label: 'Personagem' }]} />
      <div className="text-[10px] text-soft mt-1">Mesmas mensagens, provedor, contexto e autorizações nos dois visuais.</div>
      <label className="block text-[11px] text-muted mt-2">Personagem
        <select aria-label="Personagem" value={c.preset} onChange={(e) => set({ preset: e.target.value })} className="mt-1 w-full h-8 px-1.5 rounded-lg bg-[#0f1826] border border-line text-[12px] text-fg">
          {CHARACTER_PRESETS.map((p) => <option key={p.id} value={p.id} title={p.description}>{p.name} — {p.description}</option>)}
        </select>
      </label>
      <label className="block text-[11px] text-muted mt-2">Nome exibido
        <input aria-label="Nome exibido" maxLength={40} defaultValue={c.name} key={c.name} placeholder="(nome do personagem)" onBlur={(e) => e.target.value.trim() !== c.name && set({ name: e.target.value.trim() })} className="mt-1 w-full h-8 px-2 rounded-lg bg-[#0f1826] border border-line text-[12px] text-fg" />
      </label>
      <label className="flex items-center gap-2 mt-2 text-[12px] text-fg-2">
        <input type="checkbox" className="accent-accent" checked={c.docked} onChange={(e) => set({ docked: e.target.checked })} /> Fixar no dock deste quadro
      </label>
    </div>
  );
}

export function CompanionPreferences() {
  const prefs = useEditor((s) => s.companionPrefs);
  return (
    <div className="mt-3" data-testid="companion-prefs">
      <Label>Assistentes (personagens)</Label>
      <Segmented<CompanionMotion> label="Animações dos assistentes" value={prefs.motion} onChange={(motion) => void setCompanionPrefs({ motion })} options={(['system', 'off', 'discreet', 'normal', 'expressive'] as const).map((m) => ({ value: m, label: m === 'expressive' ? 'Expr.' : m === 'discreet' ? 'Discr.' : m === 'system' ? 'Sist.' : COMPANION_MOTION_LABEL[m], title: COMPANION_MOTION_LABEL[m] }))} />
      <div className="flex items-center gap-2 mt-1.5 text-[12px] text-fg-2">
        Dock:
        <Segmented<'left' | 'right' | 'hidden'> label="Dock de assistentes" value={prefs.dock} onChange={(dock) => void setCompanionPrefs({ dock })} options={[{ value: 'left', label: 'Esq.' }, { value: 'right', label: 'Dir.' }, { value: 'hidden', label: 'Oculto' }]} />
      </div>
      <div className="text-[10px] text-soft mt-1">Animações são locais: nunca chamam a IA nem geram custo. “Sistema” respeita o movimento reduzido. Sons: desligados.</div>
    </div>
  );
}
