import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useEditor } from '../store/editor';
import { commitTextEdit } from '../store/actions';
import { isLinear, isText } from '../core/schema';
import { FONT_FAMILIES, LINE_HEIGHT } from '../core/elements';
import { boundTextBox, measureTextBlock } from '../core/text';
import { linearLabelPosition } from './ElementView';

/** Editor de texto direto no canvas (posicionado em coordenadas do mundo). */
export function TextEditor() {
  const id = useEditor((s) => s.editingTextId);
  if (!id) return null;
  return <TextEditorInner key={id} id={id} />;
}

function TextEditorInner({ id }: { id: string }) {
  const el = useEditor((s) => s.elements.find((e) => e.id === id));
  const [value, setValue] = useState(() => initialTextOf(id));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  // Foco síncrono (antes da pintura) para não perder teclas digitadas logo após o clique.
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus({ preventScroll: true });
    t.select();
  }, []);

  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }, [value, el?.width, el?.style.fontSize, el?.style.fontFamily]);

  if (!el) return null;

  const finish = () => {
    if (done.current) return;
    done.current = true;
    commitTextEdit(id, value);
  };

  const s = el.style;
  const font: CSSProperties = {
    fontFamily: FONT_FAMILIES[s.fontFamily].css,
    fontSize: s.fontSize,
    lineHeight: LINE_HEIGHT,
    color: s.textColor || s.strokeColor,
    textAlign: s.textAlign,
  };

  let style: CSSProperties;
  if (isText(el)) {
    const m = measureTextBlock(value || ' ', s, el.autoSize ? Infinity : el.width - 4);
    style = {
      left: el.x,
      top: el.y,
      width: el.autoSize ? Math.max(40, m.width + 24) : el.width,
      transform: el.angle ? `rotate(${el.angle}rad)` : undefined,
      transformOrigin: `${el.width / 2}px ${el.height / 2}px`,
      whiteSpace: el.autoSize ? 'pre' : 'pre-wrap',
      padding: '0 2px',
    };
  } else if (isLinear(el)) {
    const pos = linearLabelPosition(el);
    const fontSize = Math.max(12, s.fontSize * 0.8);
    const m = measureTextBlock(value || ' ', { ...s, fontSize });
    const w = Math.max(80, m.width + 24);
    style = { left: el.x + pos.x - w / 2, top: el.y + pos.y - (fontSize * LINE_HEIGHT) / 2, width: w, fontSize, textAlign: 'center', whiteSpace: 'pre' };
  } else if (el.type === 'frame') {
    style = { left: el.x, top: el.y - 26, width: Math.max(160, el.width * 0.6), fontSize: 13, fontFamily: FONT_FAMILIES.sans.css, color: '#c5d3e6', textAlign: 'left', whiteSpace: 'pre' };
  } else {
    const box = boundTextBox(el);
    const m = measureTextBlock(value || ' ', s, box.width);
    const h = Math.max(m.height, s.fontSize * LINE_HEIGHT);
    const offset = s.verticalAlign === 'top' ? 0 : s.verticalAlign === 'bottom' ? box.height - h : (box.height - h) / 2;
    style = {
      left: el.x + box.x,
      top: el.y + box.y + Math.max(0, offset),
      width: box.width,
      transform: el.angle ? `rotate(${el.angle}rad)` : undefined,
      transformOrigin: `${el.width / 2 - box.x}px ${el.height / 2 - box.y - Math.max(0, offset)}px`,
      whiteSpace: 'pre-wrap',
    };
  }

  return (
    <textarea
      ref={ref}
      data-testid="text-editor"
      className="absolute m-0 p-0 border-0 outline-none resize-none overflow-hidden bg-transparent caret-accent"
      style={{ ...font, ...style, overflowWrap: 'anywhere', minHeight: s.fontSize * LINE_HEIGHT, zIndex: 50 }}
      value={value}
      spellCheck
      placeholder={isText(el) ? '' : 'Escreva…'}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
          e.preventDefault();
          finish();
        }
        if (e.key === 'Tab') e.preventDefault();
      }}
    />
  );
}

function initialTextOf(id: string): string {
  return useEditor.getState().elements.find((e) => e.id === id)?.text ?? '';
}
