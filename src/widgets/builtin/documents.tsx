import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Link2, Paperclip, Trash2 } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { safeHttpUrl, sanitizeDocuments, type DocumentItem, type DocumentsData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { uid } from '../../core/elements';
import { Empty } from '../../ui/primitives';

function sizeLabel(n: number) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dataURLToBlob(dataURL: string): Blob {
  const [head, body] = dataURL.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function Preview({ doc, getURL }: { doc: DocumentItem; getURL: (id: string) => Promise<string | null> }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    setBlobUrl(null);
    setText(null);
    if (doc.assetId) {
      getURL(doc.assetId).then(async (data) => {
        if (!alive || !data) return;
        const blob = dataURLToBlob(data);
        if (doc.mimeType.startsWith('text/') || /\.(md|txt|csv|json|log)$/i.test(doc.name)) setText((await blob.text()).slice(0, 20000));
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      });
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [doc.assetId, doc.mimeType, doc.name, getURL]);

  if (doc.url) {
    const safe = safeHttpUrl(doc.url);
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className="text-accent underline text-[12px] break-all">{safe}</a> : <div className="text-warn text-[11px]">URL inválida.</div>;
  }
  if (!blobUrl) return <div className="text-[11px] text-soft">Carregando…</div>;
  return (
    <div className="flex flex-col gap-1.5">
      {doc.mimeType.startsWith('image/') && <img src={blobUrl} alt={doc.name} className="max-h-48 object-contain rounded" />}
      {doc.mimeType === 'application/pdf' && <iframe title={doc.name} src={blobUrl} className="w-full h-56 rounded border border-line bg-white" />}
      {text !== null && <pre className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto bg-[#0a111c] p-2 rounded">{text}</pre>}
      <a href={blobUrl} download={doc.name} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"><Download size={12} /> Baixar {doc.name}</a>
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
