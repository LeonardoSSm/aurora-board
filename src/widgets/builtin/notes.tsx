import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { NotebookPen } from 'lucide-react';
import type { WidgetPlugin } from '../registry';
import { sanitizeNotes, type NotesData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';
import { Segmented } from '../../ui/primitives';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(md: string): string {
  const html = marked.parse(md || '', { async: false }) as string;
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form'], FORBID_ATTR: ['style'] });
  // Links sempre em nova aba e sem acesso ao opener.
  return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
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
          <div className="md flex-1 text-fg-2" dangerouslySetInnerHTML={{ __html: html || '<p class="text-soft italic">Nota vazia.</p>' }} />
        )}
      </div>
    );
  },
};
