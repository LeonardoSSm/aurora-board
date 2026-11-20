/** Issue #15: personalização da Aurora Wheel — até 8 fatias, ordem gravada nas configurações locais. */
import { useEditor } from '../store/editor';
import { BUILTIN_ITEMS, availableWidgets, resetRadialFavorites, setRadialFavorites } from '../store/radialActions';
import { MAX_FAVORITES } from '../core/radial';
import { Label } from './primitives';

export function RadialFavorites() {
  const favs = useEditor((s) => s.radialFavorites);
  const options = [
    ...Object.values(BUILTIN_ITEMS).map((b) => ({ id: b.id, label: b.label })),
    ...availableWidgets().map((w) => ({ id: `widget:${w.id}`, label: w.name })),
  ];
  const slots: string[] = Array.from({ length: MAX_FAVORITES }, (_, i) => favs[i] ?? '');
  const change = (i: number, id: string) => {
    const next = [...slots];
    next[i] = id;
    void setRadialFavorites(next.filter(Boolean));
  };
  return (
    <div className="mt-3" data-testid="radial-favorites">
      <Label>Aurora Wheel (botão direito)</Label>
      <div className="grid grid-cols-2 gap-1">
        {slots.map((v, i) => (
          <select
            key={i}
            aria-label={`Fatia ${i + 1}`}
            value={v}
            onChange={(e) => change(i, e.target.value)}
            className="h-7 min-w-0 px-1 rounded-md bg-[#0f1826] border border-line text-[11px]"
          >
            <option value="">(vazia)</option>
            {options.map((o) => <option key={o.id} value={o.id} disabled={o.id !== v && slots.includes(o.id)}>{i + 1}. {o.label}</option>)}
          </select>
        ))}
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-soft">“Mais” é sempre mantido. Vale para todos os quadros.</span>
        <button type="button" className="text-[10px] text-soft hover:text-fg underline-offset-2 hover:underline" onClick={() => void resetRadialFavorites()}>Restaurar padrão</button>
      </div>
    </div>
  );
}
