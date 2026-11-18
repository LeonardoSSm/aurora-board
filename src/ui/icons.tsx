/** Ícones compactos do painel de propriedades (estilo Excalidraw). */
const S = { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const IconStrokeWidth = ({ w }: { w: number }) => (
  <svg {...S}><path d="M3 10h14" strokeWidth={w} /></svg>
);

export const IconStrokeStyle = ({ style }: { style: 'solid' | 'dashed' | 'dotted' }) => (
  <svg {...S}><path d="M3 10h14" strokeWidth={2} strokeDasharray={style === 'dashed' ? '4 3' : style === 'dotted' ? '0.5 3.5' : undefined} /></svg>
);

export const IconRoughness = ({ level }: { level: number }) => (
  <svg {...S}>
    <path
      strokeWidth={1.7}
      d={level === 0 ? 'M3 13c4-7 10-7 14 0' : level === 1 ? 'M3 13c2-4 3-6 5-6s3 3 4 3 3-3 5 0' : 'M3 13l2-5 2 4 2-6 2 6 2-5 2 4 2-3'}
    />
  </svg>
);

export const IconEdges = ({ round }: { round: boolean }) => (
  <svg {...S}><path strokeWidth={1.8} d={round ? 'M4 16V9a5 5 0 0 1 5-5h7' : 'M4 16V4h12'} /></svg>
);

export const IconFill = ({ kind }: { kind: 'solid' | 'hachure' | 'cross-hatch' }) => (
  <svg {...S}>
    <defs>
      <clipPath id={`clip-${kind}`}><rect x="4" y="4" width="12" height="12" rx="2" /></clipPath>
    </defs>
    <rect x="4" y="4" width="12" height="12" rx="2" strokeWidth={1.5} fill={kind === 'solid' ? 'currentColor' : 'none'} />
    {kind !== 'solid' && (
      <g clipPath={`url(#clip-${kind})`} strokeWidth={1}>
        <path d="M0 12l12-12M2 18l16-16M8 20l12-12M-2 6l8-8" />
        {kind === 'cross-hatch' && <path d="M0 8l12 12M2 2l16 16M8 0l12 12" />}
      </g>
    )}
  </svg>
);

export const IconArrowPath = ({ kind }: { kind: 'straight' | 'curved' | 'elbow' }) => (
  <svg {...S} strokeWidth={1.7}>
    <path d={kind === 'straight' ? 'M4 16L16 4' : kind === 'curved' ? 'M4 16C4 8 8 4 16 4' : 'M4 16V10h12V4'} />
    <path d="M11 4h5v5" />
  </svg>
);
