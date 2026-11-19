import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AuroraElement, LinearElement } from '../core/schema';
import { isLinear } from '../core/schema';
import { FONT_FAMILIES, LINE_HEIGHT } from '../core/elements';
import { boundTextBox } from '../core/text';
import { elementParts, linearLocalPoints } from '../render/shapes';
import { cachedAsset, getAsset } from '../store/actions';
import { WidgetFrame } from '../widgets/WidgetFrame';
import { checkImageBytes, dataURLHead, type ImageVerdict } from '../core/media';

/** URL do asset; `undefined` enquanto carrega, `null` se o arquivo não existe mais. */
export function useAssetURL(id: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => cachedAsset(id)?.dataURL);
  useEffect(() => {
    let alive = true;
    if (cachedAsset(id)) setUrl(cachedAsset(id)!.dataURL);
    else getAsset(id).then((a) => alive && setUrl(a?.dataURL ?? null)).catch(() => alive && setUrl(null));
    return () => { alive = false; };
  }, [id]);
  return url;
}

function textStyle(el: AuroraElement): CSSProperties {
  const s = el.style;
  return {
    fontFamily: FONT_FAMILIES[s.fontFamily].css,
    fontSize: s.fontSize,
    lineHeight: LINE_HEIGHT,
    color: s.textColor || s.strokeColor,
    textAlign: s.textAlign,
  };
}

function BoundText({ el }: { el: AuroraElement }) {
  if (!el.text) return null;
  const box = boundTextBox(el);
  const justify = el.style.verticalAlign === 'top' ? 'flex-start' : el.style.verticalAlign === 'bottom' ? 'flex-end' : 'center';
  return (
    <div
      className="absolute flex flex-col pointer-events-none"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height, justifyContent: justify }}
    >
      <div style={{ ...textStyle(el), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{el.text}</div>
    </div>
  );
}

/** Veredito por asset (a checagem lê só o cabeçalho, mas não precisa ser repetida a cada montagem). */
const imageVerdicts = new Map<string, ImageVerdict>();

function ImageContent({ el }: { el: Extract<AuroraElement, { type: 'image' }> }) {
  const url = useAssetURL(el.assetId);
  // S1 (Etapa 8): o formato e as dimensões vêm dos bytes. Conteúdo que não é imagem, ou imagem com dimensões
  // de "bomba de descompressão", não é entregue ao decodificador — o asset é preservado, só não é exibido.
  const verdict = useMemo(() => {
    if (!url) return null;
    const hit = imageVerdicts.get(el.assetId);
    if (hit) return hit;
    const v = checkImageBytes(dataURLHead(url));
    if (imageVerdicts.size > 2000) imageVerdicts.clear();
    imageVerdicts.set(el.assetId, v);
    return v;
  }, [url, el.assetId]);
  if (url && verdict && !verdict.ok)
    return (
      <div data-testid="image-blocked" className="w-full h-full grid place-items-center rounded bg-panel-2 text-warn text-xs border border-dashed border-warn/50 text-center p-2">
        {verdict.reason}
      </div>
    );
  if (!url)
    return (
      <div data-testid={url === null ? 'image-missing' : 'image-loading'} className="w-full h-full grid place-items-center rounded bg-panel-2 text-muted text-xs border border-dashed border-line text-center p-2">
        {url === null ? 'Imagem indisponível (arquivo não encontrado neste navegador)' : 'Carregando imagem…'}
      </div>
    );
  return <img src={url} alt="" draggable={false} className="w-full h-full select-none pointer-events-none" style={{ objectFit: 'fill', borderRadius: el.style.roundness === 'round' ? 8 : 0 }} />;
}

function polylineMidpoint(pts: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= total / 2) {
      const t = (total / 2 - acc) / (seg || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    acc += seg;
  }
  return pts[0] ?? { x: 0, y: 0 };
}

/** Caixa local (relativa a el.x/el.y) que contém a linha desenhada, com margem para traço, ponta e traço à mão. */
function linearLocalBox(el: LinearElement) {
  const pts = linearLocalPoints(el);
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  // Pontos de controle do traço à mão (roughjs) podem passar um pouco dos pontos; pontas têm ~4×espessura+6.
  const pad = Math.max(12, el.style.strokeWidth * 5 + 10) + el.style.roughness * 6;
  return { x: Math.floor(minX - pad), y: Math.floor(minY - pad), w: Math.ceil(maxX - minX + pad * 2), h: Math.ceil(maxY - minY + pad * 2) };
}

export function linearLabelPosition(el: LinearElement) {
  return polylineMidpoint(linearLocalPoints(el));
}

function Parts({ el }: { el: AuroraElement }) {
  const parts = elementParts(el);
  return (
    <>
      {parts.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ?? 'none'}
          stroke={p.stroke ?? 'none'}
          strokeWidth={p.strokeWidth}
          strokeDasharray={p.dash}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </>
  );
}

interface Props {
  el: AuroraElement;
  editing: boolean;
  selected: boolean;
  erasing: boolean;
}

export const ElementView = memo(function ElementView({ el, editing, selected, erasing }: Props) {
  const opacity = (el.style.opacity / 100) * (erasing ? 0.25 : 1);

  if (isLinear(el)) {
    const label = el.text && !editing ? linearLabelPosition(el) : null;
    // SVG do tamanho exato da linha (+ margem para traço e pontas): o navegador recorta e pinta só essa área.
    // (Um SVG 1×1 com overflow visível desenhando fora da caixa multiplicava o custo de pintura do pan/zoom.)
    const box = linearLocalBox(el);
    return (
      <div className="absolute pointer-events-none" style={{ left: el.x, top: el.y, width: 0, height: 0, opacity }} data-element-id={el.id} data-type={el.type}>
        <svg className="absolute" style={{ left: box.x, top: box.y }} width={box.w} height={box.h} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}>
          <Parts el={el} />
        </svg>
        {label && (
          <div
            className="absolute px-1.5 rounded bg-canvas whitespace-pre"
            style={{ ...textStyle(el), fontSize: Math.max(12, el.style.fontSize * 0.8), left: label.x, top: label.y, transform: 'translate(-50%, -50%)', textAlign: 'center' }}
          >
            {el.text}
          </div>
        )}
      </div>
    );
  }

  const wrap: CSSProperties = {
    left: el.x,
    top: el.y,
    width: el.width,
    height: el.height,
    transform: el.angle ? `rotate(${el.angle}rad)` : undefined,
    opacity,
  };

  if (el.type === 'widget') {
    return (
      <div className="absolute" style={wrap} data-element-id={el.id} data-type="widget">
        <WidgetFrame element={el} selected={selected} />
      </div>
    );
  }

  return (
    <div className="absolute pointer-events-none" style={wrap} data-element-id={el.id} data-type={el.type}>
      {el.type === 'image' && <ImageContent el={el} />}
      {el.type === 'text' && !editing && (
        <div style={{ ...textStyle(el), whiteSpace: el.autoSize ? 'pre' : 'pre-wrap', overflowWrap: 'anywhere', padding: '0 2px' }}>{el.text}</div>
      )}
      {el.type !== 'image' && el.type !== 'text' && (
        <svg className="absolute inset-0 overflow-visible" width={Math.max(1, el.width)} height={Math.max(1, el.height)} style={el.type === 'sticky' ? { filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.35))' } : undefined}>
          <Parts el={el} />
        </svg>
      )}
      {el.type === 'frame' && !editing && (
        <div className="absolute left-0 -top-6 text-[13px] font-semibold text-muted whitespace-nowrap font-sans">{el.text || 'Frame'}</div>
      )}
      {el.type !== 'frame' && el.type !== 'text' && !editing && <BoundText el={el} />}
    </div>
  );
});
