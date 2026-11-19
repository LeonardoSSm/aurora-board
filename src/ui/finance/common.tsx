/** Peças visuais compartilhadas pelo módulo “Minhas contas” (identidade Dark Tech do Aurora Board). */
import type { ReactNode } from 'react';
import type { Currency } from '../../core/finance';
import { formatMoney } from '../../core/finance';
import { shiftPeriod, periodLabel } from '../../core/scalar';
import type { DataOrigin } from '../../finance/model';

export const brl = (cents: number, currency: Currency = 'BRL') => formatMoney(cents, currency);

export function Card({ title, children, className = '', testid }: { title?: ReactNode; children: ReactNode; className?: string; testid?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel p-3 ${className}`} data-testid={testid}>
      {title && <h3 className="text-[11px] uppercase tracking-wider font-bold text-muted mb-2">{title}</h3>}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone, hint, testid }: { label: string; value: string; tone?: 'ok' | 'danger' | 'warn' | 'muted'; hint?: string; testid?: string }) {
  const cls = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg';
  return (
    <div className="rounded-lg border border-line/70 bg-[#0f1826] px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-soft font-bold">{label}</div>
      <div className={`text-[18px] font-bold tracking-tight truncate ${cls}`} data-testid={testid}>{value}</div>
      {hint && <div className="text-[10px] text-soft mt-0.5">{hint}</div>}
    </div>
  );
}

const ORIGIN: Record<DataOrigin, string> = { manual: 'Manual', csv: 'CSV', ofx: 'OFX', provider: 'Conector', backup: 'Backup' };
export function OriginBadge({ origin, mock }: { origin: DataOrigin; mock?: boolean }) {
  return <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${mock ? 'border-warn/60 text-warn' : 'border-line text-soft'}`}>{mock ? 'Fictício' : ORIGIN[origin]}</span>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-6 text-center" data-testid="finance-empty">
      <div className="text-[14px] font-bold text-fg-2">{title}</div>
      {children && <div className="text-[12px] text-muted mt-1 max-w-md mx-auto">{children}</div>}
      {action && <div className="mt-3 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function MonthPicker({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  return (
    <div className="inline-flex items-center gap-1" data-testid="finance-month">
      <button aria-label="Mês anterior" className="h-7 w-7 rounded-md border border-line hover:bg-panel-3" onClick={() => onChange(shiftPeriod(value, -1))}>‹</button>
      <span className="text-[12px] font-semibold min-w-[120px] text-center">{periodLabel(value)}</span>
      <button aria-label="Mês seguinte" className="h-7 w-7 rounded-md border border-line hover:bg-panel-3" onClick={() => onChange(shiftPeriod(value, 1))}>›</button>
    </div>
  );
}

export const inputCls = 'h-8 px-2 rounded-lg bg-[#0f1826] border border-line outline-none focus:border-accent text-[12px] min-w-0';
export const btnCls = 'h-8 px-3 rounded-lg border border-line bg-panel-3 hover:bg-[#28405d] text-[12px] font-semibold text-fg-2 disabled:opacity-40';
export const primaryCls = 'h-8 px-3 rounded-lg bg-[#3174db] hover:bg-[#3b82f0] text-white text-[12px] font-semibold disabled:opacity-40';
export const dangerCls = 'h-8 px-3 rounded-lg border border-danger/60 text-danger hover:bg-danger/10 text-[12px] font-semibold disabled:opacity-40';

export function lastDay(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
