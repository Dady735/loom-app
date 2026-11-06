import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, Package, X, type LucideIcon } from 'lucide-react';
import { statusLabels } from './api';

export function Button({ children, variant = 'primary', icon: Icon, loading, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'light'; icon?: LucideIcon; loading?: boolean }) {
  return <button className={`btn btn-${variant} ${className}`} {...props} disabled={props.disabled || loading}>{loading ? <Loader2 size={17} className="spin" /> : Icon ? <Icon size={17} /> : null}{children}</button>;
}
export function Badge({ status, children }: { status: string; children?: ReactNode }) { return <span className={`badge badge-${status}`}><span className="badge-dot" />{children || statusLabels[status] || status}</span>; }
export function Avatar({ name, size = '' }: { name: string; size?: 'large' | '' }) { const colors = ['sage', 'peach', 'blue', 'lavender']; const color = colors[name.charCodeAt(0) % colors.length]; return <span className={`avatar ${color} ${size}`}>{name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()}</span>; }
export function PageHeader({ eyebrow, title, description, children }: { eyebrow?: string; title: string; description?: string; children?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</div>;
}
export function EmptyState({ icon: Icon = Package, title, description, children, compact = false }: { icon?: LucideIcon; title: string; description: string; children?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={27} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{children}</div>;
}
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) { if (!message) return null; return <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{message}</span>{onRetry && <button onClick={onRetry}>Try again</button>}</div>; }
export function Loading({ label = 'Loading your workspace…' }: { label?: string }) { return <div className="loading-state"><Loader2 className="spin" size={24} /><span>{label}</span></div>; }
export function Modal({ title, subtitle, children, onClose, wide = false, drawer = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement; const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,button,select,textarea,[tabindex="0"]')?.focus(), 50);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') || []).filter(el => el.offsetParent !== null);
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return createPortal(<div className={`modal-overlay ${drawer ? 'drawer-overlay' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${drawer ? 'drawer' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></div><div className="modal-body">{children}</div></div></div>, document.body);
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) { return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>; }
export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description: string; disabled?: boolean }) { return <div className="toggle-row"><div><strong>{label}</strong><p>{description}</p></div><button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span>{checked && <Check size={11} />}</span></button></div>; }
export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pagination"><span>{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : '0 results'}</span><div><button className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={17} /></button><span>Page {page} of {pages}</span><button className="icon-btn" aria-label="Next page" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={17} /></button></div></div>;
}
export function PanelHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) { return <div className="panel-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{children}</div>; }
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowRight size={15} /></button>; }
export function BackButton({ onClick, children = 'Back' }: { onClick: () => void; children?: ReactNode }) { return <button className="back-link" onClick={onClick}><ArrowLeft size={16} />{children}</button>; }
export function ConfirmCheck({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) { return <label className="confirm-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span>{children}</span></label>; }
