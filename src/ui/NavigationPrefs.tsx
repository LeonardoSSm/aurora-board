/** Issue #12: preferência pessoal de animação e velocidade da câmera ao navegar (Locais, Enquadrar, Ir para…). */
import { useSyncExternalStore } from 'react';
import { useEditor } from '../store/editor';
import { setNavigationPrefs } from '../store/actions';
import { NAVIGATION_SPEED_LABEL, type NavigationMotion, type NavigationSpeed } from '../core/camera';
import { systemPrefersReducedMotion } from '../store/cameraMotion';
import { Label, Segmented } from './primitives';

const QUERY = '(prefers-reduced-motion: reduce)';
function subscribe(cb: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener?.('change', cb);
  return () => mq.removeEventListener?.('change', cb);
}

/** Acompanha a preferência de movimento reduzido do sistema (muda sem recarregar). */
export function useSystemReducedMotion() {
  return useSyncExternalStore(subscribe, systemPrefersReducedMotion, () => false);
}

export function NavigationPreference() {
  const prefs = useEditor((s) => s.navigationPrefs);
  const reduced = useSystemReducedMotion();
  const animating = prefs.motion === 'always' || (prefs.motion === 'system' && !reduced);
  const status = prefs.motion === 'never'
    ? 'A câmera vai direto ao destino.'
    : prefs.motion === 'always'
      ? 'A câmera viaja até o destino, mesmo com movimento reduzido no sistema.'
      : reduced
        ? 'O sistema pede movimento reduzido: a câmera vai direto. Escolha “Sempre” para animar mesmo assim.'
        : 'A câmera viaja até o destino (o sistema não pede movimento reduzido).';
  return (
    <div className="mt-3" data-testid="navigation-prefs">
      <Label>Animação de navegação</Label>
      <Segmented<NavigationMotion>
        label="Animação de navegação"
        value={prefs.motion}
        onChange={(motion) => void setNavigationPrefs({ motion })}
        options={[
          { value: 'system', label: 'Sistema', title: 'Anima, exceto com movimento reduzido ativado no sistema' },
          { value: 'always', label: 'Sempre', title: 'Anima mesmo com movimento reduzido no sistema' },
          { value: 'never', label: 'Nunca', title: 'Sem animação: vai direto' },
        ]}
      />
      <div className="mt-1.5">
        <Segmented<NavigationSpeed>
          label="Velocidade da navegação"
          value={prefs.speed}
          onChange={(speed) => void setNavigationPrefs({ speed })}
          options={(['fast', 'smooth', 'cinematic'] as const).map((v) => ({ value: v, label: v === 'cinematic' ? 'Cinema' : NAVIGATION_SPEED_LABEL[v], title: NAVIGATION_SPEED_LABEL[v] }))}
        />
      </div>
      <div className="text-[10px] text-soft mt-1" data-testid="navigation-status" data-animating={animating ? 'true' : 'false'}>
        {status} Vale para Locais, Enquadrar e “Ir para”; Esc ou um arrasto interrompem.
      </div>
    </div>
  );
}
