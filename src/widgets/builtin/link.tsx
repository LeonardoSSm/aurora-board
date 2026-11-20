/**
 * Widget Link (`aurora.link`). Dois modos no MESMO widget (issue #22, docs/SMART_LINKS.md):
 * - Clássico: campos de URL/descrição/pré-visualização no próprio bloco (padrão para dados sem `visual`);
 * - Atalho Visual: só `[ÍCONE] Nome`, moldura `bare`, clique consciente abre o destino; configuração no
 *   painel Propriedades. Ícones locais, imagem enviada (asset local) ou imagem da pré-visualização com opt-in.
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, ImageUp, Link2, RefreshCw, Trash2 } from 'lucide-react';
import type { AuroraElement, WidgetElement } from '../../core/schema';
import type { WidgetHostApi, WidgetPlugin, WidgetPreset, WidgetProps } from '../registry';
import { safeHttpUrl, sanitizeLink, type LinkData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { LOCAL_API_ENABLED, STATIC_LINK_PREVIEW_MESSAGE } from '../../config/runtime';
import { postJSON } from '../../integrations/apiFetch';
import {
  LAYOUT_LABEL,
  LINK_LAYOUTS,
  autoIconId,
  defaultVisual,
  displayLabel,
  fitLabel,
  initialLabel,
  isInsecureHttp,
  isShortcut,
  linkHost,
  linkTargetUrl,
  redactUrl,
  referenceSize,
  shortcutLayout,
  titleFollowingLabel,
  type LinkIconMode,
  type LinkLayout,
  type LinkVisual,
  type ShortcutLayoutResult,
} from '../../core/smartLinks';
import { checkImageBytes, dataURLHead } from '../../core/media';
import { getState, useEditor } from '../../store/editor';
import { cachedAsset, getAsset, openWidgetInspector, updateElements } from '../../store/actions';
import { toast } from '../../store/ui';
import { Button, Field, Label, Segmented, TextArea } from '../../ui/primitives';
import { LINK_ICONS, linkIconDataURL, getLinkIcon } from './linkIcons';

export async function fetchLinkPreview(url: string) {
  if (!LOCAL_API_ENABLED) throw new Error(STATIC_LINK_PREVIEW_MESSAGE);
  const res = await postJSON('/api/link-preview', { url });
  if (res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) throw new Error('Servidor local indisponível. Rode "npm run dev" para iniciar web + API.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Falha (${res.status})`);
  return body as { title: string; description: string; image: string; siteName: string };
}

/* ------------------------------------------------------------------ */
/* Ações                                                               */
/* ------------------------------------------------------------------ */

/** Imagens enviadas aceitas na v1 (pelos BYTES, não pela extensão). GIF/SVG ficam de fora — ver docs. */
const UPLOAD_KINDS = new Set(['png', 'jpeg', 'webp']);
export const MAX_LINK_IMAGE_BYTES = 2 * 1024 * 1024;

const lastOpen = new Map<string, number>();

/**
 * Abre o destino do atalho em nova aba (`noopener,noreferrer`). Só por ação direta do usuário (clique, Enter,
 * menu, botão). URL vazia/inválida nunca abre nada (nem about:blank): leva às Propriedades.
 * Cliques repetidos em menos de 700 ms (ex.: duplo clique) abrem UMA aba.
 */
export function openLinkElement(id: string): boolean {
  const el = getState().elements.find((e) => e.id === id);
  if (!el || el.type !== 'widget' || el.widgetType !== WIDGET.link) return false;
  const d = sanitizeLink(el.data);
  const target = linkTargetUrl(d.url);
  if (!target) {
    toast(d.url.trim() ? 'Link inválido: corrija o endereço em Propriedades.' : 'Atalho sem endereço: configure o link em Propriedades.', 'warning');
    openWidgetInspector(id, 'url');
    return false;
  }
  const now = performance.now();
  if (now - (lastOpen.get(id) ?? -Infinity) < 700) return false;
  lastOpen.set(id, now);
  if (lastOpen.size > 500) lastOpen.clear();
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

function patchLink(id: string, fn: (d: LinkData, el: WidgetElement) => Partial<LinkData>, extra?: (el: WidgetElement, next: LinkData, prev: LinkData) => Partial<WidgetElement>, coalesceKey?: string) {
  updateElements(new Set([id]), (el) => {
    if (el.type !== 'widget') return el;
    const cur = sanitizeLink(el.data);
    const next = sanitizeLink({ ...cur, ...fn(cur, el) });
    return { ...el, ...(extra ? extra(el, next, cur) : {}), data: next } as AuroraElement;
  }, coalesceKey);
}

function patchVisual(id: string, p: Partial<LinkVisual>, coalesceKey?: string, resize = false) {
  patchLink(
    id,
    (d) => ({ visual: { ...(d.visual ?? defaultVisual()), ...p } }),
    resize
      ? (el, next) => {
          const size = referenceSize(next.visual);
          return { x: el.x + (el.width - size.width) / 2, y: el.y + (el.height - size.height) / 2, width: size.width, height: size.height };
        }
      : undefined,
    coalesceKey,
  );
}

/** Converte entre Clássico e Atalho Visual sem perder URL, descrição nem pré-visualização. */
export function setLinkMode(id: string, mode: 'classic' | 'shortcut') {
  patchVisual(id, { displayMode: mode }, undefined, true);
}

export function setLinkLayout(id: string, layout: LinkLayout) {
  patchVisual(id, { layout }, undefined, true);
}

function nextLayout(l: LinkLayout): LinkLayout {
  return LINK_LAYOUTS[(LINK_LAYOUTS.indexOf(l) + 1) % LINK_LAYOUTS.length];
}

/* ------------------------------------------------------------------ */
/* Imagens                                                             */
/* ------------------------------------------------------------------ */

function useAssetDataURL(id: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => (id ? cachedAsset(id)?.dataURL : null));
  useEffect(() => {
    if (!id) { setUrl(null); return; }
    let alive = true;
    const hit = cachedAsset(id);
    if (hit) setUrl(hit.dataURL);
    else { setUrl(undefined); getAsset(id).then((a) => alive && setUrl(a?.dataURL ?? null)).catch(() => alive && setUrl(null)); }
    return () => { alive = false; };
  }, [id]);
  return url;
}

const verdicts = new Map<string, boolean>();
/** Só exibe asset cujos BYTES sejam PNG/JPEG/WebP dentro dos limites (um backup pode apontar para outra coisa). */
export function displayableImage(assetId: string, dataURL: string): boolean {
  const key = `${assetId}|${dataURL.length}`;
  const hit = verdicts.get(key);
  if (hit !== undefined) return hit;
  let v = checkImageBytes(dataURLHead(dataURL));
  if (v.ok && v.width === null && v.kind !== 'svg') v = checkImageBytes(dataURLHead(dataURL, 4 * 1024 * 1024));
  const ok = v.ok && UPLOAD_KINDS.has(v.kind);
  if (verdicts.size > 1000) verdicts.clear();
  verdicts.set(key, ok);
  return ok;
}

type MediaSource = { kind: 'icon'; iconId: string; reason?: 'missing' | 'invalid' | 'no-consent' | 'no-preview' } | { kind: 'image'; src: string; remote: boolean };

function useMediaSource(data: LinkData): MediaSource {
  const v = data.visual ?? defaultVisual();
  const assetUrl = useAssetDataURL(v.iconMode === 'uploaded' ? v.assetId : '');
  const icon = autoIconId(v, data.url);
  if (v.iconMode === 'uploaded') {
    if (!v.assetId || assetUrl === null) return { kind: 'icon', iconId: icon, reason: 'missing' };
    if (assetUrl === undefined) return { kind: 'icon', iconId: icon };
    return displayableImage(v.assetId, assetUrl) ? { kind: 'image', src: assetUrl, remote: false } : { kind: 'icon', iconId: icon, reason: 'invalid' };
  }
  if (v.iconMode === 'preview') {
    const img = data.preview?.image && linkTargetUrl(data.preview.image);
    if (!img) return { kind: 'icon', iconId: icon, reason: 'no-preview' };
    // Privacidade (S1-SEC-011): imagem remota só com opt-in persistente gravado neste navegador.
    return v.remoteImageConsent ? { kind: 'image', src: img, remote: true } : { kind: 'icon', iconId: icon, reason: 'no-consent' };
  }
  return { kind: 'icon', iconId: icon };
}

/* ------------------------------------------------------------------ */
/* Atalho visual                                                       */
/* ------------------------------------------------------------------ */

function ShortcutView({ element, data, selected }: { element: WidgetElement; data: LinkData; selected: boolean }) {
  const v = data.visual!;
  const lay = useMemo(() => shortcutLayout(v, element.width, element.height), [v, element.width, element.height]);
  const media = useMediaSource(data);
  const target = linkTargetUrl(data.url);
  const name = displayLabel(element.title, data.url, v);
  const state = !data.url.trim() ? 'unconfigured' : target ? 'ready' : 'invalid';
  const host = linkHost(data.url);
  return (
    <div
      role="link"
      aria-label={state === 'ready' ? `Abrir ${name} (${host}) em nova aba` : `${name} — link não configurado`}
      aria-disabled={state !== 'ready' || undefined}
      title={state === 'ready' ? `${name} — abre ${host}` : 'Configure o link em Propriedades'}
      data-testid="link-shortcut"
      data-layout={v.layout}
      data-state={state}
      data-media={media.kind === 'image' ? (media.remote ? 'remote' : 'uploaded') : `icon:${media.iconId}`}
      className={`absolute inset-0 overflow-hidden border bg-panel-2 text-fg select-none ${state === 'ready' ? 'border-line' : 'border-dashed border-warn/60'}`}
      style={{ borderRadius: lay.radius, boxShadow: selected ? '0 0 0 1px #63d7dd66, 0 10px 26px rgba(0,0,0,.45)' : '0 8px 20px rgba(0,0,0,.35)' }}
    >
      <ShortcutMedia media={media} lay={lay} layout={v.layout} fit={v.fit} />
      {lay.label && (
        <div
          data-testid="link-shortcut-label"
          className={`absolute font-semibold leading-tight ${state === 'ready' ? 'text-fg' : 'text-muted italic'}`}
          style={{ left: lay.label.x, top: lay.label.y, width: lay.label.w, height: lay.label.h, fontSize: lay.label.size, lineHeight: `${lay.label.h}px`, textAlign: lay.label.align, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {name}
        </div>
      )}
      {lay.external && state === 'ready' && (
        <ExternalLink aria-hidden className="absolute text-soft" style={{ left: lay.external.x, top: lay.external.y }} size={lay.external.size} />
      )}
    </div>
  );
}

function ShortcutMedia({ media, lay, layout, fit }: { media: MediaSource; lay: ShortcutLayoutResult; layout: LinkLayout; fit: 'cover' | 'contain' }) {
  const m = lay.media;
  const card = layout === 'card';
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [media.kind === 'image' ? media.src : '']);
  const iconUrl = linkIconDataURL(media.kind === 'icon' ? media.iconId : 'globe');
  const box = { left: m.x, top: m.y, width: m.w, height: m.h };
  if (media.kind === 'image' && !broken) {
    return (
      <img
        data-testid="link-shortcut-image"
        src={media.src}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="absolute pointer-events-none"
        style={{ ...box, objectFit: fit, borderRadius: card ? `${lay.radius}px ${lay.radius}px 0 0` : lay.mediaRadius, background: '#0f1826' }}
      />
    );
  }
  if (card) {
    const s = Math.min(m.w, m.h) * 0.5;
    return (
      <div className="absolute pointer-events-none" style={{ ...box, background: 'linear-gradient(180deg,#1b2a40,#121c2b)' }}>
        <img data-testid="link-shortcut-icon" src={iconUrl} alt="" draggable={false} className="absolute" style={{ left: (m.w - s) / 2, top: (m.h - s) / 2, width: s, height: s }} />
      </div>
    );
  }
  return <img data-testid="link-shortcut-icon" src={iconUrl} alt="" draggable={false} className="absolute pointer-events-none" style={box} />;
}

/* ------------------------------------------------------------------ */
/* Modo clássico (idêntico ao anterior)                                */
/* ------------------------------------------------------------------ */

function ClassicView({ data, update, element, api }: WidgetProps<LinkData>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showImage, setShowImage] = useState(false);
  const safe = safeHttpUrl(data.url);
  let host = '';
  try { host = safe ? new URL(safe).host : ''; } catch { /* ignore */ }
  const refresh = async () => {
    if (!safe) return;
    setLoading(true);
    setError('');
    try {
      const p = await fetchLinkPreview(safe);
      update({ preview: { ...p, fetchedAt: Date.now() } });
      if (p.title && (element.title === 'Link' || !element.title)) api.updateElement(element.id, { title: p.title.slice(0, 80) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        value={data.url}
        placeholder="https://..."
        onChange={(e) => update({ url: e.target.value.trim(), preview: null }, { coalesce: true })}
        className="h-8 px-2 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[12px] font-mono"
      />
      {data.url && !safe && <div className="text-[11px] text-warn">URL inválida (use http:// ou https://).</div>}
      {data.preview && (
        <div className="flex gap-2 rounded-lg border border-line/70 p-2 bg-[#0f1826]">
          {/* Imagem remota só por clique (S1-SEC-011): abrir um quadro não avisa servidores de terceiros. */}
          {data.preview.image && safeHttpUrl(data.preview.image) && (showImage
            ? <img src={data.preview.image} alt="" referrerPolicy="no-referrer" className="w-16 h-16 object-cover rounded shrink-0" />
            : <button data-testid="link-load-image" title={`Carregar imagem de ${(() => { try { return new URL(data.preview.image).host; } catch { return ''; } })()}`} onClick={() => setShowImage(true)} className="w-16 h-16 rounded shrink-0 border border-dashed border-line text-[9px] text-soft leading-tight">imagem externa<br />carregar</button>)}
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-fg line-clamp-2">{data.preview.title}</div>
            <div className="text-[11px] text-muted line-clamp-3">{data.preview.description}</div>
            <div className="text-[10px] text-soft mt-0.5">{data.preview.siteName || host}</div>
          </div>
        </div>
      )}
      <textarea
        value={data.description}
        placeholder="Descrição / por que este link importa"
        onChange={(e) => update({ description: e.target.value }, { coalesce: true })}
        className="min-h-[44px] px-2 py-1.5 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[12px] resize-y"
      />
      <div className="flex gap-1.5 items-center">
        {safe && (
          <a href={safe} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line text-[11px] text-accent hover:bg-panel-3">
            <ExternalLink size={12} /> Abrir {host}
          </a>
        )}
        {safe && LOCAL_API_ENABLED && (
          <button onClick={refresh} disabled={loading} className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line text-[11px] text-muted hover:bg-panel-3">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Pré-visualizar
          </button>
        )}
      </div>
      {error && <div className="text-[11px] text-warn">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inspetor (painel Propriedades)                                      */
/* ------------------------------------------------------------------ */

function urlProblem(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (linkTargetUrl(s)) return '';
  if (s.length > 2048) return 'Endereço longo demais (máximo de 2048 caracteres).';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return `Endereços “${u.protocol}” não são aceitos. Use https://.`;
    if (u.username || u.password) return 'Endereços com usuário/senha embutidos não são aceitos.';
  } catch { /* cai na mensagem geral */ }
  return 'Use um endereço https:// válido (ex.: https://studio.youtube.com/).';
}

function Inspector({ element, data, api }: { element: WidgetElement; data: LinkData; api: WidgetHostApi }) {
  const id = element.id;
  const v = data.visual;
  const shortcut = isShortcut(v);
  const vis = v ?? defaultVisual({ displayMode: 'classic' });
  const focus = useEditor((s) => s.inspectorFocus);
  const [urlDraft, setUrlDraft] = useState(data.url);
  useEffect(() => setUrlDraft(data.url), [data.url, id]);
  const [labelDraft, setLabelDraft] = useState(vis.label);
  useEffect(() => setLabelDraft(vis.label), [vis.label, id]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const media = useMediaSource({ ...data, visual: vis });
  const problem = urlProblem(urlDraft);
  const target = linkTargetUrl(data.url);
  const shownName = displayLabel(element.title, data.url, vis);

  useEffect(() => {
    if (!focus || focus.id !== id) return;
    const el = document.querySelector<HTMLInputElement>(focus.section === 'url' ? '[data-testid="link-inspector"] [aria-label="Endereço (URL)"]' : '[data-testid="link-inspector"] [aria-label="Nome exibido"]');
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }, [focus, id]);

  const commitUrl = () => {
    const next = urlDraft.trim();
    if (next === data.url || urlProblem(next)) return;
    // Trocar o destino invalida a pré-visualização (e o opt-in da imagem dela).
    patchLink(id, (d) => ({ url: next, preview: null, ...(d.visual ? { visual: { ...d.visual, remoteImageConsent: undefined } } : {}) }));
  };

  const commitLabel = (raw: string) => {
    const label = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    patchLink(
      id,
      (d) => ({ visual: { ...(d.visual ?? defaultVisual({ displayMode: 'classic' })), label } }),
      (el, _n, prev) => {
        const t = titleFollowingLabel(el.title, displayLabel(el.title, prev.url, prev.visual), label);
        return t ? { title: t } : {};
      },
      `link:label:${id}`,
    );
  };

  const preview = async () => {
    if (!target) return;
    setBusy('preview');
    setError('');
    try {
      const p = await fetchLinkPreview(target);
      patchLink(id, () => ({ preview: { ...p, fetchedAt: Date.now() } }), (el) => (p.title && (el.title === 'Link' || !el.title) ? { title: p.title.slice(0, 80) } : {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const upload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setBusy('upload');
      setError('');
      try {
        if (f.size > MAX_LINK_IMAGE_BYTES) throw new Error('Imagem maior que 2 MB.');
        let verdict = checkImageBytes(new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer()));
        if (verdict.ok && verdict.width === null) verdict = checkImageBytes(new Uint8Array(await f.arrayBuffer()));
        if (!verdict.ok) throw new Error(verdict.reason);
        if (!UPLOAD_KINDS.has(verdict.kind)) throw new Error('Formato não aceito: use PNG, JPEG ou WebP.');
        const assetId = await api.putAsset(f, f.name);
        patchVisual(id, { iconMode: 'uploaded', assetId });
      } catch (e) {
        setError(`Não foi possível usar a imagem: ${(e as Error).message}`);
      } finally {
        setBusy('');
      }
    };
    input.click();
  };

  const previewHost = (() => { try { return data.preview?.image ? new URL(data.preview.image).host : ''; } catch { return ''; } })();

  return (
    <div className="flex flex-col text-[12px]" data-testid="link-inspector">
      <Label>Modo</Label>
      <Segmented<'classic' | 'shortcut'>
        label="Modo do link"
        value={shortcut ? 'shortcut' : 'classic'}
        onChange={(m) => setLinkMode(id, m)}
        options={[{ value: 'shortcut', label: 'Atalho visual', title: '[Ícone] Nome — clique abre o destino' }, { value: 'classic', label: 'Clássico', title: 'Campos de URL e descrição no bloco' }]}
      />

      <Label>Endereço (URL)</Label>
      <Field
        aria-label="Endereço (URL)"
        value={urlDraft}
        placeholder="https://"
        spellCheck={false}
        onChange={(e) => setUrlDraft(e.target.value)}
        onBlur={commitUrl}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={problem ? '!border-danger font-mono' : 'font-mono'}
      />
      {problem && <div className="text-[11px] text-danger mt-1" data-testid="link-url-error">{problem}</div>}
      {!problem && isInsecureHttp(urlDraft) && <div className="text-[11px] text-warn mt-1">Conexão sem criptografia (http). Prefira https:// quando o site oferecer.</div>}

      {shortcut && (
        <>
          <Label>Nome exibido</Label>
          <Field
            aria-label="Nome exibido"
            value={labelDraft}
            maxLength={120}
            placeholder={initialLabel(data.url) || 'Configurar link'}
            onChange={(e) => { setLabelDraft(e.target.value); commitLabel(e.target.value); }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="text-[10px] text-soft mt-1">Mudar o nome não altera o endereço. Vazio = nome automático ({initialLabel(data.url) || 'Configurar link'}).</div>
        </>
      )}

      <Label>Descrição (opcional)</Label>
      <TextArea aria-label="Descrição do link" rows={2} value={data.description} placeholder="Por que este link importa" onChange={(e) => patchLink(id, () => ({ description: e.target.value }), undefined, `link:desc:${id}`)} onKeyDown={(e) => e.stopPropagation()} />

      {shortcut && (
        <>
          <Label>Layout</Label>
          <Segmented<LinkLayout> label="Layout do atalho" value={vis.layout} onChange={(l) => setLinkLayout(id, l)} options={LINK_LAYOUTS.map((l) => ({ value: l, label: LAYOUT_LABEL[l] }))} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-fg-2">
            {vis.layout === 'compact' && <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={vis.showLabel} onChange={(e) => patchVisual(id, { showLabel: e.target.checked }, undefined, true)} /> Mostrar nome (desligado = só ícone)</label>}
            {vis.layout === 'horizontal' && <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={vis.showExternal} onChange={(e) => patchVisual(id, { showExternal: e.target.checked })} /> Indicador de link externo</label>}
          </div>

          <Label>Ícone / imagem</Label>
          <Segmented<LinkIconMode>
            label="Fonte da imagem"
            value={vis.iconMode}
            onChange={(m) => patchVisual(id, { iconMode: m })}
            options={[{ value: 'local', label: 'Ícone', title: 'Biblioteca local de ícones' }, { value: 'uploaded', label: 'Imagem', title: 'Imagem enviada (fica no navegador)' }, { value: 'preview', label: 'Do site', title: 'Imagem da pré-visualização (remota, só com permissão)' }]}
          />
          {vis.iconMode === 'local' && (
            <div className="mt-2">
              <div className="grid grid-cols-6 gap-1" role="radiogroup" aria-label="Ícone do atalho">
                <button type="button" role="radio" aria-checked={!vis.iconId} aria-label="Ícone automático" title={`Automático (${getLinkIcon(autoIconId({ iconId: '' }, data.url))?.label})`} onClick={() => patchVisual(id, { iconId: '' })} className={`h-9 rounded-md border text-[10px] font-semibold ${!vis.iconId ? 'border-[#7d84e6] bg-[#3a3f7a] text-white' : 'border-line text-fg-2 hover:bg-panel-3'}`}>Auto</button>
                {LINK_ICONS.map((ic) => (
                  <button key={ic.id} type="button" role="radio" aria-checked={vis.iconId === ic.id} aria-label={`Ícone ${ic.label}`} title={ic.label} onClick={() => patchVisual(id, { iconId: ic.id })} className={`h-9 grid place-items-center rounded-md border ${vis.iconId === ic.id ? 'border-[#7d84e6] bg-[#3a3f7a]' : 'border-line hover:bg-panel-3'}`}>
                    <img src={linkIconDataURL(ic.id)} alt="" width={22} height={22} draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {vis.iconMode === 'uploaded' && (
            <div className="flex flex-col gap-1.5 mt-2">
              <div className="flex gap-1.5">
                <Button onClick={upload} disabled={busy === 'upload'}><ImageUp size={13} /> {vis.assetId ? 'Trocar imagem…' : 'Escolher imagem…'}</Button>
                {vis.assetId && <Button aria-label="Remover imagem" onClick={() => patchVisual(id, { assetId: '', iconMode: 'local' })}><Trash2 size={13} /></Button>}
              </div>
              <div className="text-[10px] text-soft">PNG, JPEG ou WebP até 2 MB. Fica guardada neste navegador e vai junto no backup.</div>
              {media.kind === 'icon' && media.reason === 'missing' && vis.assetId && <div className="text-[11px] text-warn" data-testid="link-image-missing">Imagem não encontrada neste navegador — usando o ícone.</div>}
              {media.kind === 'icon' && media.reason === 'invalid' && <div className="text-[11px] text-warn">O arquivo guardado não é PNG/JPEG/WebP válido — usando o ícone.</div>}
            </div>
          )}
          {vis.iconMode === 'preview' && (
            <div className="flex flex-col gap-1.5 mt-2 text-[11px]">
              {!data.preview?.image ? (
                <div className="text-soft">Sem imagem de pré-visualização. Use “Pré-visualizar” (servidor local) para buscá-la — nada é buscado sozinho.</div>
              ) : !vis.remoteImageConsent ? (
                <>
                  <div className="text-soft leading-relaxed">A imagem fica em <b>{previewHost}</b>. Exibi-la faz o navegador contatar esse site sempre que o quadro abrir (sem enviar o endereço do Aurora).</div>
                  <Button onClick={() => patchVisual(id, { remoteImageConsent: { at: Date.now() } })}>Exibir imagem de {previewHost}</Button>
                </>
              ) : (
                <>
                  <div className="text-soft">Imagem remota autorizada neste navegador. Backups importados voltam a pedir permissão.</div>
                  <Button onClick={() => patchVisual(id, { remoteImageConsent: undefined })}>Revogar permissão</Button>
                </>
              )}
            </div>
          )}
          {vis.iconMode !== 'local' && (
            <>
              <Label>Encaixe da imagem</Label>
              <Segmented label="Encaixe da imagem" value={vis.fit} onChange={(f) => patchVisual(id, { fit: f })} options={[{ value: 'cover', label: 'Preencher' }, { value: 'contain', label: 'Inteira' }]} />
            </>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-1.5 mt-3">
        <Button aria-label="Abrir link" title="Abrir em nova aba" disabled={!target} onClick={() => openLinkElement(id)}><ExternalLink size={13} /> Abrir link</Button>
        {LOCAL_API_ENABLED && <Button disabled={!target || busy === 'preview'} onClick={preview}><RefreshCw size={13} className={busy === 'preview' ? 'animate-spin' : ''} /> Pré-visualizar</Button>}
      </div>
      {data.preview && <div className="text-[11px] text-muted mt-1.5 line-clamp-2" title={data.preview.description}>Pré-visualização: {data.preview.title || data.preview.siteName || '—'}</div>}
      {error && <div className="text-[11px] text-warn mt-1">{error}</div>}
      {shortcut && <div className="text-[10px] text-soft mt-2 leading-relaxed">Clique no atalho abre “{shownName}”. Para só selecionar: clique na borda, Shift+clique ou segure. Enter abre o atalho selecionado.</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Exportação SVG                                                      */
/* ------------------------------------------------------------------ */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const n2 = (v: number) => Math.round(v * 100) / 100;

/** SVG fiel do atalho. Imagem remota NUNCA entra na exportação (sem rede, sem “tainted canvas”): vira o ícone. */
export async function shortcutSVG(d: LinkData, el: WidgetElement): Promise<string> {
  const v = d.visual!;
  const lay = shortcutLayout(v, el.width, el.height);
  const name = displayLabel(el.title, d.url, v);
  const icon = autoIconId(v, d.url);
  const clip = `lk-${el.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  let mediaHref = '';
  if (v.iconMode === 'uploaded' && v.assetId) {
    const a = await getAsset(v.assetId).catch(() => null);
    if (a && displayableImage(v.assetId, a.dataURL)) mediaHref = a.dataURL;
  }
  const m = lay.media;
  const parts: string[] = [];
  parts.push(`<rect x="0.5" y="0.5" width="${n2(Math.max(0, el.width - 1))}" height="${n2(Math.max(0, el.height - 1))}" rx="${n2(lay.radius)}" fill="#182436" stroke="#2e405a"/>`);
  if (mediaHref) {
    const r = v.layout === 'card' ? lay.radius : lay.mediaRadius;
    parts.push(`<clipPath id="${clip}"><rect x="${n2(m.x)}" y="${n2(m.y)}" width="${n2(m.w)}" height="${n2(m.h)}" rx="${n2(r)}"/></clipPath>`);
    parts.push(`<image href="${esc(mediaHref)}" x="${n2(m.x)}" y="${n2(m.y)}" width="${n2(m.w)}" height="${n2(m.h)}" preserveAspectRatio="xMidYMid ${v.fit === 'contain' ? 'meet' : 'slice'}" clip-path="url(#${clip})"/>`);
  } else if (v.layout === 'card') {
    const s = Math.min(m.w, m.h) * 0.5;
    parts.push(`<rect x="${n2(m.x)}" y="${n2(m.y)}" width="${n2(m.w)}" height="${n2(m.h)}" fill="#152132"/>`);
    parts.push(`<image href="${esc(linkIconDataURL(icon))}" x="${n2(m.x + (m.w - s) / 2)}" y="${n2(m.y + (m.h - s) / 2)}" width="${n2(s)}" height="${n2(s)}"/>`);
  } else {
    parts.push(`<image href="${esc(linkIconDataURL(icon))}" x="${n2(m.x)}" y="${n2(m.y)}" width="${n2(m.w)}" height="${n2(m.h)}"/>`);
  }
  if (lay.label) {
    const L = lay.label;
    const x = L.align === 'center' ? L.x + L.w / 2 : L.x;
    parts.push(`<text x="${n2(x)}" y="${n2(L.y + L.h / 2 + L.size * 0.35)}" font-size="${n2(L.size)}" font-weight="600" fill="#edf3fc" text-anchor="${L.align === 'center' ? 'middle' : 'start'}" font-family="Inter Variable, Inter, system-ui, sans-serif">${esc(fitLabel(name, L.w, L.size))}</text>`);
  }
  if (lay.external && linkTargetUrl(d.url)) {
    const e = lay.external;
    parts.push(`<path d="M${n2(e.x + e.w * 0.35)} ${n2(e.y + e.h * 0.2)}H${n2(e.x + e.w * 0.8)}V${n2(e.y + e.h * 0.65)}M${n2(e.x + e.w * 0.8)} ${n2(e.y + e.h * 0.2)}L${n2(e.x + e.w * 0.25)} ${n2(e.y + e.h * 0.75)}" fill="none" stroke="#8ea3bf" stroke-width="${n2(Math.max(1, e.size / 10))}" stroke-linecap="round"/>`);
  }
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* Plugin e presets                                                    */
/* ------------------------------------------------------------------ */

function iconPresetIcon(iconId: string) {
  const Icon = ({ size = 16, className }: { size?: number; className?: string }) => (
    <img src={linkIconDataURL(iconId)} width={size} height={size} alt="" draggable={false} className={className} />
  );
  Icon.displayName = `LinkIcon(${iconId})`;
  return Icon;
}

const SITE_PRESETS: { id: string; name: string; url: string }[] = [
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'youtube-studio', name: 'YouTube Studio', url: 'https://studio.youtube.com/' },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/' },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/' },
];

const presets: WidgetPreset<LinkData>[] = [
  { id: 'shortcut', name: 'Atalho visual', description: '[Ícone] Nome — clique abre o destino', keywords: ['link', 'atalho', 'url', 'site', 'botão', 'smart link'], icon: iconPresetIcon('link'), data: { visual: defaultVisual() }, size: { ...referenceSize(defaultVisual()) }, title: 'Atalho', accent: '#63d7dd' },
  { id: 'classic', name: 'Link clássico', description: 'URL, descrição e pré-visualização no bloco', keywords: ['link', 'url', 'pré-visualização'], icon: Link2, data: { visual: defaultVisual({ displayMode: 'classic' }) }, size: { width: 320, height: 210 }, title: 'Link', accent: '#63d7dd' },
  ...SITE_PRESETS.map((p) => ({
    id: `site-${p.id}`,
    name: p.name,
    description: `Atalho para ${linkHost(p.url)}`,
    keywords: ['atalho', 'rede social', 'link', p.id],
    icon: iconPresetIcon(p.id),
    data: { url: p.url, visual: defaultVisual({ label: p.name }) },
    size: { ...referenceSize(defaultVisual()) },
    title: p.name,
    accent: '#63d7dd',
  })),
];

export const linkPlugin: WidgetPlugin<LinkData> = {
  id: WIDGET.link,
  name: 'Link',
  description: 'Atalho visual clicável ([ícone] nome) ou link clássico com descrição e pré-visualização.',
  icon: Link2,
  version: '1.0.0',
  category: 'Mídia',
  status: 'ready',
  accent: '#63d7dd',
  permissions: ['network:link-preview', 'storage:assets'],
  defaultSize: { ...referenceSize(defaultVisual()) },
  inputs: [],
  outputs: [{ id: 'url', label: 'URL', type: 'text' }],
  presets,
  librarySection: 'Links e atalhos',
  hideInLibrary: true,
  // Inserção nova (biblioteca/colar URL) começa como Atalho Visual; dados SEM `visual` continuam Clássicos.
  createData: () => ({ url: '', description: '', preview: null, visual: defaultVisual() }),
  sanitize: sanitizeLink,
  compute: (d) => ({ url: d.url }),
  // Resumo automático (IA por conexão de contexto, exportação genérica): sem query/fragmento da URL.
  summarize: (d, el) => [displayLabel(el.title, d.url, d.visual), redactUrl(d.url), d.preview?.title, d.description || d.preview?.description].filter(Boolean).join('\n'),
  frameFor: (d) => (isShortcut(d.visual) ? 'bare' : 'standard'),
  Component: (props) => (isShortcut(props.data.visual) ? <ShortcutView element={props.element} data={props.data} selected={props.selected} /> : <ClassicView {...props} />),
  Inspector: ({ element, data, api }) => <Inspector element={element} data={data} api={api} />,
  clickAction: (d, el) => (isShortcut(d.visual) ? () => { openLinkElement(el.id); } : null),
  menuItems: (el, d) =>
    isShortcut(d.visual)
      ? [
          { id: 'open', label: 'Abrir link', disabled: !linkTargetUrl(d.url), run: () => { openLinkElement(el.id); } },
          { id: 'edit', label: 'Editar atalho', run: () => openWidgetInspector(el.id) },
          { id: 'layout', label: `Layout: ${LAYOUT_LABEL[nextLayout(d.visual.layout)]}`, run: () => setLinkLayout(el.id, nextLayout(d.visual!.layout)) },
          { id: 'classic', label: 'Converter para link clássico', run: () => setLinkMode(el.id, 'classic') },
        ]
      : [{ id: 'shortcut', label: 'Converter em atalho visual', run: () => setLinkMode(el.id, 'shortcut') }],
  exportSVG: (d, el) => (isShortcut(d.visual) ? shortcutSVG(d, el) : null),
};
