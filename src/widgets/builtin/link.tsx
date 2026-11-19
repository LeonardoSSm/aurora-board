import { useState } from 'react';
import { ExternalLink, Link2, RefreshCw } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { safeHttpUrl, sanitizeLink, type LinkData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { LOCAL_API_ENABLED, STATIC_LINK_PREVIEW_MESSAGE } from '../../config/runtime';

export async function fetchLinkPreview(url: string) {
  if (!LOCAL_API_ENABLED) throw new Error(STATIC_LINK_PREVIEW_MESSAGE);
  const res = await fetch('/api/link-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  if (res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) throw new Error('Servidor local indisponível. Rode "npm run dev" para iniciar web + API.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Falha (${res.status})`);
  return body as { title: string; description: string; image: string; siteName: string };
}

export const linkPlugin: WidgetPlugin<LinkData> = {
  id: WIDGET.link,
  name: 'Link',
  description: 'Salva URLs com título, descrição e pré-visualização (via servidor local).',
  icon: Link2,
  version: '1.0.0',
  category: 'Mídia',
  status: 'ready',
  accent: '#63d7dd',
  permissions: ['network:link-preview'],
  defaultSize: { width: 320, height: 210 },
  inputs: [],
  outputs: [{ id: 'url', label: 'URL', type: 'text' }],
  createData: () => ({ url: '', description: '', preview: null }),
  sanitize: sanitizeLink,
  compute: (d) => ({ url: d.url }),
  summarize: (d) => [d.url, d.preview?.title, d.description || d.preview?.description].filter(Boolean).join('\n'),
  Component: function Link({ data, update, element, api }) {
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
  },
};
