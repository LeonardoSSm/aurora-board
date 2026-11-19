import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { NotebookPen } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { safeHttpUrl, sanitizeNotes, type NotesData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { Segmented } from '../../ui/primitives';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Privacidade (S1-SEC-011): imagens remotas no Markdown não são carregadas automaticamente — abrir um quadro
 * importado não pode avisar um servidor de terceiros (IP, horário). A imagem vira um marcador; o clique carrega.
 * Só data: (embutidas) carregam direto. Hook registrado uma vez; a sanitização em si continua com o DOMPurify.
 */
let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (raw) => {
    if (!raw || typeof (raw as Element).getAttribute !== 'function') return;
    const node = raw as Element;
    node.removeAttribute('srcset');
    node.removeAttribute('ping');
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (src && !/^data:image\//i.test(src)) {
        let host = '';
        try { host = new URL(src).host; } catch { /* relativa ou inválida */ }
        node.removeAttribute('src');
        if (host) node.setAttribute('data-ext-src', src);
        node.setAttribute('class', 'ext-img');
        node.setAttribute('alt', host ? `🖼 Imagem externa (${host}) — clique para carregar` : '🖼 Imagem indisponível');
        node.setAttribute('referrerpolicy', 'no-referrer');
      }
    }
  });
}

/** Tags que fariam requisições ou imitariam a interface do app (formulários/campos). */
const FORBID_TAGS = ['style', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'option', 'video', 'audio', 'source', 'track', 'picture', 'object', 'embed', 'link', 'meta', 'base'];

export function renderMarkdown(md: string): string {
  ensureHooks();
  const html = marked.parse(md || '', { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR: ['style', 'srcset', 'ping', 'poster', 'background'] });
  // Links sempre em nova aba e sem acesso ao opener.
  return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

/** Clique num marcador de imagem externa: carrega só aquela imagem, sem referrer. */
export function loadExternalImage(e: { target: EventTarget | null }) {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  const src = img?.getAttribute('data-ext-src');
  if (!img || !src) return;
  const safe = safeHttpUrl(src);
  if (!safe) return;
  img.removeAttribute('data-ext-src');
  img.referrerPolicy = 'no-referrer';
  img.alt = '';
  img.src = safe;
  img.classList.remove('ext-img');
}

export const notesPlugin: WidgetPlugin<NotesData> = {
  id: WIDGET.notes,
  name: 'Notas',
  description: 'Editor de texto com Markdown: títulos, listas, links e anotações livres.',
  icon: NotebookPen,
  version: '1.0.0',
  category: 'Produtividade',
  status: 'ready',
  accent: '#f3c577',
  permissions: [],
  defaultSize: { width: 320, height: 260 },
  inputs: [],
  outputs: [{ id: 'text', label: 'Texto', type: 'text' }],
  createData: () => ({ markdown: '', mode: 'edit' }),
  sanitize: sanitizeNotes,
  compute: (d) => ({ text: d.markdown }),
  summarize: (d) => d.markdown,
  Component: function Notes({ data, update }) {
    const html = useMemo(() => (data.mode === 'preview' ? renderMarkdown(data.markdown) : ''), [data.mode, data.markdown]);
    return (
      <div className="flex flex-col h-full gap-2">
        <div className="flex justify-end">
          <Segmented
            value={data.mode}
            onChange={(mode) => update({ mode })}
            options={[
              { value: 'edit', label: 'Editar' },
              { value: 'preview', label: 'Visualizar' },
            ]}
          />
        </div>
        {data.mode === 'edit' ? (
          <textarea
            className="flex-1 min-h-[80px] w-full resize-none rounded-lg bg-[#0f1826] border border-line/70 focus:border-accent outline-none p-2.5 leading-relaxed text-fg font-mono text-[12px]"
            placeholder={'# Título\n- item\n**negrito**, [link](https://...)'}
            value={data.markdown}
            onChange={(e) => update({ markdown: e.target.value }, { coalesce: true })}
          />
        ) : (
          <div className="md flex-1 text-fg-2" onClick={loadExternalImage} dangerouslySetInnerHTML={{ __html: html || '<p class="text-soft italic">Nota vazia.</p>' }} />
        )}
      </div>
    );
  },
};
