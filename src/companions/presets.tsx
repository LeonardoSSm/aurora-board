/**
 * AI Companions (issue #13) — manifesto de personagens e o desenho vetorial (SVG) de cada um.
 *
 * Decisão de formato: SVG inline + animações CSS (transform/opacity) por partes nomeadas (`c-head`, `c-eyes`,
 * `c-hair`, `c-arms`, `c-screen`, `c-mug`, `c-foot`). Motivos: nenhum asset de rede, nenhuma dependência nova,
 * nítido em qualquer zoom, leve no GPU e trocável por preset sem tocar no chat. Sprites/Lottie poderiam entrar
 * depois implementando o mesmo contrato (`poses` + `micro`).
 *
 * Personagens ORIGINAIS e genéricos: nenhum é marca ou personagem protegido, e o personagem não depende do
 * provedor (qualquer assistente pode usar qualquer preset).
 */
import type { MicroAction, VisualState } from '../core/companion';

export interface CharacterPreset {
  id: string;
  name: string;
  description: string;
  colors: { outfit: string; outfit2: string; hair: string; skin: string; accent: string; laptop: string };
  hair: 'long' | 'curly' | 'robot';
  /** Poses e microanimações suportadas (contrato para conjuntos futuros). */
  poses: VisualState[];
  micro: MicroAction[];
}

const ALL_POSES: VisualState[] = ['idle', 'attention', 'thinking', 'replying', 'error', 'unread'];
const ALL_MICRO: MicroAction[] = ['blink', 'look', 'hair', 'foot', 'posture', 'laptop', 'type', 'mug'];

export const CHARACTER_PRESETS: CharacterPreset[] = [
  { id: 'aurora', name: 'Aurora', description: 'Loira, moletom violeta, notebook e caneca.', colors: { outfit: '#7b61d9', outfit2: '#5a45b0', hair: '#f2d27a', skin: '#f6d2b8', accent: '#b998ff', laptop: '#c9d3e3' }, hair: 'long', poses: ALL_POSES, micro: ALL_MICRO },
  { id: 'sol', name: 'Sol', description: 'Cabelo cacheado escuro, tons quentes.', colors: { outfit: '#d9774a', outfit2: '#b45d36', hair: '#3b2a24', skin: '#c99272', accent: '#ffb27a', laptop: '#d7dbe2' }, hair: 'curly', poses: ALL_POSES, micro: ALL_MICRO },
  { id: 'nimbus', name: 'Nimbus', description: 'Robô simpático, tons verde-água.', colors: { outfit: '#2f8f87', outfit2: '#246f69', hair: '#9fe6dc', skin: '#cfe9ef', accent: '#5addaa', laptop: '#bfcad8' }, hair: 'robot', poses: ALL_POSES, micro: ALL_MICRO.filter((m) => m !== 'hair') },
];

export function presetById(id: string | undefined): CharacterPreset | null {
  return CHARACTER_PRESETS.find((p) => p.id === id) ?? null;
}

/** Personagem desenhado (viewBox 160×170). As animações vêm do CSS, pelos atributos `data-state`/`data-micro`. */
export function CharacterSvg({ preset, label }: { preset: CharacterPreset; label: string }) {
  const c = preset.colors;
  const robot = preset.hair === 'robot';
  return (
    <svg viewBox="0 0 160 170" className="companion-svg w-full h-full" role="img" aria-label={label}>
      <ellipse cx="80" cy="162" rx="52" ry="6" fill="#000" opacity="0.28" />
      {/* Caneca */}
      <g className="c-mug">
        <rect x="124" y="122" width="16" height="18" rx="3" fill={c.accent} />
        <path d="M140 126 q7 0 7 6 q0 6 -7 6" fill="none" stroke={c.accent} strokeWidth="2.5" />
        <path className="c-steam" d="M128 117 q-3 -5 0 -9 M134 117 q-3 -5 0 -9" fill="none" stroke="#d6dde8" strokeWidth="1.4" opacity="0.6" />
      </g>
      {/* Pé */}
      <g className="c-foot"><ellipse cx="104" cy="156" rx="10" ry="5" fill={c.outfit2} /></g>
      <g className="c-body">
        {/* Tronco */}
        <path d="M48 150 q0 -44 32 -46 q32 2 32 46 z" fill={c.outfit} />
        <path d="M66 112 l14 10 l14 -10" fill="none" stroke={c.outfit2} strokeWidth="3" strokeLinecap="round" />
        {/* Cabeça */}
        <g className="c-head">
          {!robot && preset.hair === 'long' && <path className="c-hair-back" d="M44 70 q-4 46 14 52 l44 0 q18 -6 14 -52 z" fill={c.hair} />}
          {!robot && preset.hair === 'curly' && <g className="c-hair-back" fill={c.hair}>{[44, 56, 104, 116].map((x, i) => <circle key={i} cx={x} cy={78 + (i % 2) * 10} r="12" />)}</g>}
          {robot ? (
            <>
              <line x1="80" y1="22" x2="80" y2="34" stroke={c.hair} strokeWidth="3" />
              <circle className="c-antenna" cx="80" cy="20" r="5" fill={c.accent} />
              <rect x="46" y="34" width="68" height="60" rx="20" fill={c.skin} />
              <rect x="54" y="48" width="52" height="30" rx="12" fill="#1c2735" />
            </>
          ) : (
            <circle cx="80" cy="68" r="34" fill={c.skin} />
          )}
          {/* Olhos */}
          <g className="c-eyes">
            <g className="c-pupils">
              <ellipse cx="68" cy={robot ? 63 : 70} rx="4" ry={robot ? 5 : 5.5} fill={robot ? c.accent : '#2a2f3a'} />
              <ellipse cx="92" cy={robot ? 63 : 70} rx="4" ry={robot ? 5 : 5.5} fill={robot ? c.accent : '#2a2f3a'} />
            </g>
          </g>
          {!robot && <><circle cx="60" cy="80" r="4" fill="#ff8f8f" opacity="0.35" /><circle cx="100" cy="80" r="4" fill="#ff8f8f" opacity="0.35" /></>}
          <path className="c-mouth" d={robot ? 'M72 72 q8 5 16 0' : 'M73 84 q7 5 14 0'} fill="none" stroke={robot ? c.accent : '#7a3d3d'} strokeWidth="2.2" strokeLinecap="round" />
          {!robot && preset.hair === 'long' && <path className="c-hair" d="M46 66 q2 -36 34 -36 q34 0 34 36 q-10 -16 -26 -18 q-6 10 -26 12 q-10 -6 -16 6 z" fill={c.hair} />}
          {!robot && preset.hair === 'curly' && <g className="c-hair" fill={c.hair}>{[50, 62, 74, 86, 98, 110].map((x, i) => <circle key={i} cx={x} cy={42 + Math.abs(2.5 - i) * 3} r="11" />)}</g>}
        </g>
        {/* Notebook */}
        <g className="c-laptop">
          <path d="M40 140 l80 0 l8 10 l-96 0 z" fill={c.laptop} />
          <g className="c-screen">
            <rect x="46" y="110" width="68" height="30" rx="3" fill="#24324a" stroke={c.laptop} strokeWidth="2" />
            <g className="c-code" fill={c.accent} opacity="0.85">
              <rect x="52" y="117" width="26" height="2.5" rx="1" />
              <rect x="52" y="123" width="40" height="2.5" rx="1" />
              <rect x="52" y="129" width="18" height="2.5" rx="1" />
            </g>
          </g>
        </g>
        {/* Mãos sobre o teclado */}
        <g className="c-arms" fill={c.skin}>
          <ellipse className="c-hand-l" cx="62" cy="143" rx="8" ry="5" />
          <ellipse className="c-hand-r" cx="98" cy="143" rx="8" ry="5" />
        </g>
      </g>
      {/* Indicadores de estado */}
      <g className="c-badge-error"><circle cx="126" cy="34" r="11" fill="#e05a6c" /><text x="126" y="39" textAnchor="middle" fontSize="15" fontWeight="700" fill="#fff">!</text></g>
      <g className="c-badge-unread"><circle cx="126" cy="34" r="7" fill="#ffd36a" /></g>
      <g className="c-dots" fill="#d6dde8"><circle cx="60" cy="100" r="2.6" /><circle cx="70" cy="100" r="2.6" /><circle cx="80" cy="100" r="2.6" /></g>
    </svg>
  );
}

/** Avatar estático de fallback (preset desconhecido ou removido): iniciais num círculo. */
export function FallbackAvatar({ name, color = '#b998ff' }: { name: string; color?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'IA';
  return (
    <svg viewBox="0 0 160 170" className="w-full h-full" role="img" aria-label={name}>
      <circle cx="80" cy="80" r="56" fill={color} opacity="0.85" />
      <text x="80" y="96" textAnchor="middle" fontSize="44" fontWeight="700" fill="#101722">{initials}</text>
    </svg>
  );
}
