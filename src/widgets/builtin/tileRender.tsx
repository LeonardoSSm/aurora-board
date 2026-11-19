/**
 * Renderização compartilhada de blocos compactos: a mesma lista de primitivas (`TileNode`) é desenhada
 * na tela (React/SVG) e serializada na exportação (string SVG). Usada por AI Tiles e blocos financeiros.
 */
import { TILE_FONT, type TileNode } from '../../core/aiTiles';
import { logoDataURL } from './aiTileLogos';

export function NodeView({ n }: { n: TileNode }) {
  switch (n.kind) {
    case 'rect':
      return <rect x={n.x} y={n.y} width={Math.max(0, n.w)} height={Math.max(0, n.h)} rx={n.rx} fill={n.fill} fillOpacity={n.fillOpacity} stroke={n.stroke ?? 'none'} strokeWidth={n.strokeWidth} />;
    case 'logo': {
      const href = logoDataURL(n.logo, n.tone);
      return href ? <image data-testid="ai-tile-logo" data-logo={n.logo} href={href} x={n.x} y={n.y} width={n.w} height={n.h} preserveAspectRatio="xMidYMid meet" /> : null;
    }
    case 'text':
      return <text x={n.x} y={n.y} fontSize={n.size} fontWeight={n.weight} fill={n.color} textAnchor={n.anchor} fontFamily={TILE_FONT} data-role={n.role}>{n.text}</text>;
    case 'dot':
      return <circle cx={n.x} cy={n.y} r={n.r} fill={n.fill} />;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const n2 = (v: number) => Math.round(v * 100) / 100;

/** Serializa o mesmo layout da tela em SVG (exportação). */
export function tileNodesToSVG(nodes: TileNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'rect':
          return `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(Math.max(0, n.w))}" height="${n2(Math.max(0, n.h))}" rx="${n2(n.rx)}" fill="${esc(n.fill)}"${n.fillOpacity !== undefined ? ` fill-opacity="${n.fillOpacity}"` : ''} stroke="${esc(n.stroke ?? 'none')}"${n.strokeWidth ? ` stroke-width="${n.strokeWidth}"` : ''}/>`;
        case 'logo': {
          const href = logoDataURL(n.logo, n.tone);
          return href ? `<image href="${esc(href)}" x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.w)}" height="${n2(n.h)}" preserveAspectRatio="xMidYMid meet"/>` : '';
        }
        case 'text':
          return `<text x="${n2(n.x)}" y="${n2(n.y)}" font-size="${n2(n.size)}" font-weight="${n.weight}" fill="${esc(n.color)}" text-anchor="${n.anchor}" font-family='${esc(TILE_FONT)}' xml:space="preserve">${esc(n.text)}</text>`;
        case 'dot':
          return `<circle cx="${n2(n.x)}" cy="${n2(n.y)}" r="${n2(n.r)}" fill="${esc(n.fill)}"/>`;
      }
    })
    .join('');
}

export function TileSVG({ nodes, width, height, testid, label, filter, attrs }: { nodes: TileNode[]; width: number; height: number; testid: string; label: string; filter?: string; attrs?: Record<string, string> }) {
  const w = Math.max(1, width), h = Math.max(1, height);
  return (
    <svg data-testid={testid} role="img" aria-label={label} width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 overflow-visible" style={{ filter }} {...attrs}>
      {nodes.map((n, i) => <NodeView key={i} n={n} />)}
    </svg>
  );
}
