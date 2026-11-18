import { useMemo, useRef } from 'react';
import { Code2, Copy } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import type { WidgetPlugin } from '../registry';
import { CODE_LANGUAGES, sanitizeCode, type CodeData } from '../../core/widgetData';
import { WIDGET } from '../../core/widgetIds';

for (const [name, lang] of Object.entries({ typescript, javascript, python, json, css, xml, bash, sql, markdown, plaintext })) hljs.registerLanguage(name, lang);

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export const codePlugin: WidgetPlugin<CodeData> = {
  id: WIDGET.code,
  name: 'Código',
  description: 'Editor de código com destaque de sintaxe e cópia.',
  icon: Code2,
  version: '1.0.0',
  category: 'Desenvolvimento',
  status: 'ready',
  accent: '#8fd3ff',
  permissions: ['clipboard:write'],
  defaultSize: { width: 420, height: 280 },
  inputs: [],
  outputs: [{ id: 'code', label: 'Código', type: 'text' }],
  createData: () => ({ language: 'typescript', code: '', wrap: false }),
  sanitize: sanitizeCode,
  compute: (d) => ({ code: d.code }),
  summarize: (d) => '```' + d.language + '\n' + d.code + '\n```',
  Component: function CodeBlock({ data, update, api }) {
    const preRef = useRef<HTMLPreElement>(null);
    const html = useMemo(() => {
      try {
        return hljs.highlight(data.code + '\n', { language: data.language, ignoreIllegals: true }).value;
      } catch {
        return data.code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
      }
    }, [data.code, data.language]);
    const font = 'font-mono text-[12px] leading-[1.55] p-2.5 m-0 tab-[2]';
    const ws = data.wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre';
    return (
      <div className="flex flex-col gap-2 h-full">
        <div className="flex gap-1.5 items-center">
          <select aria-label="Linguagem" value={data.language} onChange={(e) => update({ language: e.target.value })} className="h-7 px-1.5 rounded-md bg-[#0f1826] border border-line text-[11px]">
            {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" checked={data.wrap} onChange={(e) => update({ wrap: e.target.checked })} className="accent-accent" /> Quebrar linhas
          </label>
          <button
            className="ml-auto inline-flex items-center gap-1 h-7 px-2 rounded-md border border-line text-[11px] text-fg-2 hover:bg-panel-3"
            onClick={async () => api.toast((await copyToClipboard(data.code)) ? 'Código copiado.' : 'Não foi possível copiar.', 'info')}
          >
            <Copy size={12} /> Copiar
          </button>
        </div>
        <div className="relative flex-1 min-h-[80px] rounded-lg bg-[#0a111c] border border-line/70 overflow-auto" data-scrollable>
          <pre ref={preRef} aria-hidden className={`${font} ${ws} absolute inset-0 pointer-events-none hljs`} dangerouslySetInnerHTML={{ __html: html }} />
          <textarea
            spellCheck={false}
            value={data.code}
            placeholder="// cole ou escreva seu código"
            onChange={(e) => update({ code: e.target.value }, { coalesce: true })}
            onScroll={(e) => {
              if (preRef.current) { preRef.current.scrollTop = e.currentTarget.scrollTop; preRef.current.scrollLeft = e.currentTarget.scrollLeft; }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const t = e.currentTarget, s = t.selectionStart, end = t.selectionEnd;
                const next = data.code.slice(0, s) + '  ' + data.code.slice(end);
                update({ code: next }, { coalesce: true });
                requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
              }
            }}
            className={`${font} ${ws} absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-white outline-none overflow-auto`}
          />
        </div>
      </div>
    );
  },
};
