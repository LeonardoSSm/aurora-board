import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Link2, Paperclip, Trash2 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { safeHttpUrl, sanitizeDocuments, type DocumentItem, type DocumentsData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { uid } from '../../core/elements';
import { Empty } from '../../ui/primitives';
import { classifyDocument, downloadableBlob, parseDataURL, safeDownloadName, type MediaVerdict } from '../../core/media';

function sizeLabel(n: number) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface PreviewState {
  status: 'loading' | 'ready' | 'missing' | 'error';
  verdict?: MediaVerdict;
  imageUrl?: string;
  text?: string;
  downloadUrl?: string;
  error?: string;
}

/**
 * Prévia de documento (S1-SEC-001/002): a decisão vem dos BYTES (`classifyDocument`), nunca do MIME declarado.
 * Não há iframe nem documento ativo: imagens em `<img>`, texto em `<pre>`, o resto só para download — e o download
 * é sempre `application/octet-stream`, então abrir o link numa aba não renderiza HTML/SVG na origem do app.
 */
function Preview({ doc, getURL }: { doc: DocumentItem; getURL: (id: string) => Promise<string | null> }) {
  const [st, setSt] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    const urls: string[] = [];
    let alive = true;
    setSt({ status: 'loading' });
    if (doc.assetId) {
      getURL(doc.assetId)
        .then((data) => {
          if (!alive) return;
          if (!data) { setSt({ status: 'missing' }); return; }
          const { bytes } = parseDataURL(data);
          const verdict = classifyDocument(bytes, doc.mimeType, doc.name);
          const next: PreviewState = { status: 'ready', verdict };
          if (verdict.preview === 'image') {
            next.imageUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: verdict.previewMime }));
            urls.push(next.imageUrl);
          } else if (verdict.preview === 'text') {
            next.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 80_000)).slice(0, 20_000);
          }
          next.downloadUrl = URL.createObjectURL(downloadableBlob(bytes));
          urls.push(next.downloadUrl);
          setSt(next);
        })
        .catch((e: Error) => alive && setSt({ status: 'error', error: e.message }));
    }
    return () => { alive = false; for (const u of urls) URL.revokeObjectURL(u); };
  }, [doc.assetId, doc.mimeType, doc.name, getURL]);

  if (doc.url) {
    const safe = safeHttpUrl(doc.url);
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className="text-accent underline text-[12px] break-all">{safe}</a> : <div className="text-warn text-[11px]">URL inválida.</div>;
  }
  if (st.status === 'missing') return <div data-testid="doc-missing" className="text-[11px] text-warn">Arquivo indisponível neste navegador (ausente no backup).</div>;
  if (st.status === 'error') return <div data-testid="doc-error" className="text-[11px] text-warn">{st.error}</div>;
  if (st.status === 'loading' || !st.verdict) return <div className="text-[11px] text-soft">Carregando…</div>;
  const v = st.verdict;
  return (
    <div className="flex flex-col gap-1.5" data-testid="doc-preview" data-preview={v.preview} data-sniffed={v.sniffed}>
      {v.mismatch && <div data-testid="doc-mismatch" className="text-[11px] text-warn">O conteúdo real não corresponde ao tipo informado ({doc.mimeType || 'sem tipo'}); exibido de forma segura.</div>}
      {st.imageUrl && <img src={st.imageUrl} alt={doc.name} className="max-h-48 object-contain rounded" />}
      {st.text !== undefined && <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto bg-[#0a111c] p-2 rounded">{st.text}</pre>}
      {v.note && <div className="text-[11px] text-soft">{v.note}</div>}
      {st.downloadUrl && <a href={st.downloadUrl} download={safeDownloadName(doc.name)} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"><Download size={12} /> Baixar {doc.name}</a>}
    </div>
  );
}

export const documentsPlugin: WidgetPlugin<DocumentsData> = {
  id: WIDGET.documents,
  name: 'Documentos',
  description: 'Anexe arquivos (guardados localmente) ou referências por URL, com metadados editáveis.',
  icon: FileText,
  version: '1.0.0',
  category: 'Mídia',
  status: 'ready',
  accent: '#f59abf',
  permissions: ['storage:assets'],
  defaultSize: { width: 360, height: 380 },
  inputs: [],
  outputs: [],
  createData: () => ({ docs: [], selected: '' }),
  sanitize: sanitizeDocuments,
  summarize: (d) => d.docs.map((x) => `${x.name}${x.url ? ` (${x.url})` : ''}${x.description ? ` — ${x.description}` : ''}${x.tags.length ? ` [${x.tags.join(', ')}]` : ''}`).join('\n'),
  Component: function Documents({ data, update, api }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const sel = data.docs.find((d) => d.id === data.selected) ?? data.docs[0];
    const patch = (id: string, p: Partial<DocumentItem>) => update((d) => ({ ...d, docs: d.docs.map((x) => (x.id === id ? { ...x, ...p } : x)) }), { coalesce: true });
    const addFiles = async (files: FileList | null) => {
      if (!files) return;
      const added: DocumentItem[] = [];
      for (const f of [...files]) {
        try {
          const assetId = await api.putAsset(f, f.name);
          added.push({ id: uid(), name: f.name, mimeType: f.type, size: f.size, assetId, url: '', description: '', tags: [], addedAt: Date.now() });
        } catch (e) {
          api.toast(`${f.name}: ${(e as Error).message}`, 'error');
        }
      }
      if (added.length) update((d) => ({ ...d, docs: [...d.docs, ...added], selected: added[0].id }));
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5">
          <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line text-[11px] text-fg-2 hover:bg-panel-3"><Paperclip size={12} /> Anexar arquivo</button>
          <button
            onClick={() => {
              const id = uid();
              update((d) => ({ ...d, docs: [...d.docs, { id, name: 'Referência', mimeType: 'text/uri-list', size: 0, assetId: '', url: 'https://', description: '', tags: [], addedAt: Date.now() }], selected: id }));
            }}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line text-[11px] text-fg-2 hover:bg-panel-3"
          >
            <Link2 size={12} /> Referência (URL)
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        </div>
        <ul className="flex flex-col">
          {data.docs.map((d) => (
            <li key={d.id} className={`group flex items-center gap-2 px-1.5 py-1 rounded-md cursor-pointer text-[12px] ${sel?.id === d.id ? 'bg-panel-3' : 'hover:bg-panel-3/60'}`} onClick={() => update({ selected: d.id })}>
              {d.url ? <Link2 size={12} className="text-accent shrink-0" /> : <FileText size={12} className="text-[#f59abf] shrink-0" />}
              <span className="flex-1 truncate">{d.name}</span>
              <span className="text-[10px] text-soft">{sizeLabel(d.size)}</span>
              <button aria-label="Remover documento" className="text-soft hover:text-danger opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); update((x) => ({ ...x, docs: x.docs.filter((y) => y.id !== d.id) })); }}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        {!data.docs.length && <Empty>Arraste arquivos para o quadro ou use “Anexar arquivo”.</Empty>}
        {sel && (
          <div className="flex flex-col gap-1.5 border-t border-line/60 pt-2">
            <input value={sel.name} onChange={(e) => patch(sel.id, { name: e.target.value })} className="h-7 px-2 rounded-md bg-[#0f1826] border border-line text-[12px] font-semibold" aria-label="Nome" />
            {!sel.assetId && <input value={sel.url} onChange={(e) => patch(sel.id, { url: e.target.value })} className="h-7 px-2 rounded-md bg-[#0f1826] border border-line text-[12px] font-mono" aria-label="URL" />}
            <textarea value={sel.description} placeholder="Descrição" onChange={(e) => patch(sel.id, { description: e.target.value })} className="min-h-[36px] px-2 py-1 rounded-md bg-[#0f1826] border border-line text-[12px] resize-y" />
            <input
              value={sel.tags.join(', ')}
              placeholder="tags, separadas, por vírgula"
              onChange={(e) => patch(sel.id, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
              className="h-7 px-2 rounded-md bg-[#0f1826] border border-line text-[11px]"
            />
            <Preview doc={sel} getURL={api.getAssetURL} />
          </div>
        )}
      </div>
    );
  },
};
