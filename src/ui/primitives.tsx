import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

type Variant = 'default' | 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-panel-3 border-line hover:bg-[#28405d] text-fg-2',
  primary: 'bg-[#3174db] border-[#4288f5] hover:bg-[#3a80ea] text-white',
  ghost: 'bg-transparent border-transparent hover:bg-panel-3 text-muted hover:text-fg',
  danger: 'bg-[#311d2b] border-[#714250] hover:bg-[#3d2232] text-[#ffb7bf]',
};

export function Button({ variant = 'default', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 h-8 text-xs font-semibold whitespace-nowrap transition-colors ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function IconButton({ active, label, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...props}
      className={`grid place-items-center w-8 h-8 rounded-lg border transition-colors ${
        active ? 'bg-[#2c3a6e] border-[#6b74d8] text-[#d8dcff]' : 'border-transparent text-fg-2 hover:bg-panel-3'
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full h-8 px-2.5 rounded-lg border border-line bg-[#0f1826] text-fg outline-none focus:border-accent placeholder:text-soft ${props.className ?? ''}`}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full px-2.5 py-2 rounded-lg border border-line bg-[#0f1826] text-fg outline-none focus:border-accent placeholder:text-soft resize-y leading-relaxed ${props.className ?? ''}`}
    />
  );
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      {...props}
      className={`h-8 px-2 rounded-lg border border-line bg-[#0f1826] text-fg outline-none focus:border-accent ${props.className ?? ''}`}
    >
      {children}
    </select>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-[10px] font-bold tracking-wider uppercase text-muted mt-3 mb-1.5 ${className}`}>{children}</div>;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title ?? (typeof o.label === 'string' ? o.label : undefined)}
          onClick={() => onChange(o.value)}
          className={`min-w-8 h-8 px-2 rounded-lg border text-xs font-semibold transition-colors ${
            value === o.value ? 'bg-[#3a3f7a] border-[#7d84e6] text-white' : 'bg-panel-3 border-line text-fg-2 hover:bg-[#28405d]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'muted' | 'accent' | 'danger' }) {
  const t = {
    ok: 'bg-ok/15 text-ok border-ok/30',
    warn: 'bg-warn/15 text-warn border-warn/30',
    muted: 'bg-muted/10 text-muted border-line',
    accent: 'bg-accent-2/15 text-accent-2 border-accent-2/30',
    danger: 'bg-danger/15 text-danger border-danger/30',
  }[tone];
  return <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${t}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-xs text-soft italic py-1">{children}</div>;
}
