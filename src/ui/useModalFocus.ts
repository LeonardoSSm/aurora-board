/**
 * Foco de diálogo modal: leva o foco para dentro ao abrir, mantém Tab/Shift+Tab dentro enquanto aberto e
 * devolve o foco a quem o tinha ao fechar (se ainda estiver no documento).
 *
 * `initial` escolhe o primeiro alvo (seletor CSS dentro do diálogo); sem ele, o primeiro controle focável.
 * Se nada for focável, o próprio diálogo recebe o foco (precisa de `tabIndex={-1}`), para que as teclas
 * cheguem ao `onKeyDown` dele e não aos atalhos do quadro.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { isTypingTarget } from './useKeyboard';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && (el.offsetParent !== null || el === document.activeElement));
}

export function useModalFocus(ref: RefObject<HTMLElement | null>, initial?: string, fallback?: () => HTMLElement | null) {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prev = document.activeElement as HTMLElement | null;
    const target = (initial ? root.querySelector<HTMLElement>(initial) : null) ?? focusableIn(root)[0] ?? root;
    target.focus({ preventScroll: true });

    // Foco que escapa (clique fora, script, elemento removido) volta para dentro.
    const onFocusIn = (e: FocusEvent) => {
      if (!root.isConnected) return;
      const t = e.target as Node | null;
      if (t && !root.contains(t) && !(t as HTMLElement).closest?.('[role="dialog"]')) (focusableIn(root)[0] ?? root).focus({ preventScroll: true });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Backspace fora de campo de texto volta a página em alguns navegadores (WebKit): dentro do modal, nunca.
      if (e.key === 'Backspace' && !isTypingTarget(e.target)) { e.preventDefault(); return; }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (!items.length) { e.preventDefault(); root.focus({ preventScroll: true }); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && root.contains(active);
      if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    // Foco perdido para o <body> (blur por script, controle focado removido): volta para o diálogo, para que
    // Esc e as demais teclas continuem chegando a ele.
    let raf = 0;
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const a = document.activeElement;
        if (root.isConnected && (!a || a === document.body)) root.focus({ preventScroll: true });
      });
    };
    document.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKeyDown);
      // Quem abriu pode ter saído do documento (ex.: o mini chat que abriu a conversa completa): usa o substituto.
      const back = prev && prev !== document.body && document.contains(prev) ? prev : fallbackRef.current?.() ?? null;
      back?.focus({ preventScroll: true });
    };
  }, [ref, initial]);
}
