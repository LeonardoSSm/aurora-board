import type { ReactNode } from 'react';
import { getState, setState } from './editor';
import type { DialogButton, Toast } from './types';
import { uid } from '../core/elements';

export function toast(message: string, kind: Toast['kind'] = 'info', ms = 3200) {
  const t: Toast = { id: uid(), message, kind };
  setState({ toasts: [...getState().toasts, t].slice(-4) });
  setTimeout(() => setState({ toasts: getState().toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? ms * 1.8 : ms);
}

export function openDialog(opts: {
  title: string;
  message?: string;
  body?: ReactNode;
  input?: { placeholder?: string; initial?: string; multiline?: boolean };
  buttons: DialogButton[];
  wide?: boolean;
}): Promise<{ button: string | null; value: string }> {
  return new Promise((resolve) => {
    const id = uid();
    setState({
      dialog: {
        id,
        ...opts,
        resolve: (r) => {
          if (getState().dialog?.id === id) setState({ dialog: null });
          resolve(r);
        },
      },
    });
  });
}

export async function confirmDialog(title: string, message: string, confirmLabel = 'Confirmar', danger = false): Promise<boolean> {
  const r = await openDialog({
    title,
    message,
    buttons: [
      { label: 'Cancelar', value: 'cancel', variant: 'ghost' },
      { label: confirmLabel, value: 'ok', variant: danger ? 'danger' : 'primary' },
    ],
  });
  return r.button === 'ok';
}

export async function promptDialog(title: string, message: string, initial = '', placeholder = '', confirmLabel = 'Salvar'): Promise<string | null> {
  const r = await openDialog({
    title,
    message,
    input: { initial, placeholder },
    buttons: [
      { label: 'Cancelar', value: 'cancel', variant: 'ghost' },
      { label: confirmLabel, value: 'ok', variant: 'primary' },
    ],
  });
  return r.button === 'ok' ? r.value.trim() : null;
}
