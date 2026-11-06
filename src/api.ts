import { useCallback, useEffect, useRef, useState } from 'react';

let csrf: string | null = null;
export function setCsrf(value: string | null) { csrf = value; }
export class ApiError extends Error { constructor(message: string, public status: number, public code = '') { super(message); } }
export async function api<T = any>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET', credentials: 'same-origin', signal: options.signal,
    headers: { 'Content-Type': 'application/json', 'X-Mettwear-Client': 'web', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['/login', '/session', '/setup'].includes(path)) window.dispatchEvent(new CustomEvent('session-expired', { detail: 401 }));
    throw new ApiError(data.error || `Request failed (${response.status}).`, response.status, data.code);
  }
  return data as T;
}
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export async function download(path: string, filename: string) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'X-Mettwear-Client': 'web' } });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new ApiError(data.error || 'Download failed.', response.status); }
  const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function queryString(values: Record<string, string | number | undefined>) {
  return new URLSearchParams(Object.entries(values).filter(([,v]) => v !== '' && v !== undefined).map(([k,v]) => [k, String(v)])).toString();
}
export function useLiveQuery<T>(path: string | null, revision: number) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [localRevision, setLocalRevision] = useState(0);
  const current = useRef<T | null>(null); const previousPath = useRef(path);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    if (previousPath.current !== path) { current.current = null; setData(null); previousPath.current = path; }
    const controller = new AbortController(); setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(result => { current.current = result; setData(result); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, localRevision]);
  const refresh = useCallback(() => setLocalRevision(v => v + 1), []);
  return { data: data !== null ? data : current.current, error, loading, refresh, setData };
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function dateTime(value?: string | null, timezone?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value));
}
export function dateOnly(value?: string | null, timezone?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}
export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'Just now'; if (minutes < 60) return `${minutes}m ago`; if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`; return `${Math.floor(minutes / 1440)}d ago`;
}
export const statusLabels: Record<string, string> = { ready: 'To pack', packed: 'Packed', dispatched: 'Dispatched', review: 'Needs review', pending: 'Pending', unassigned: 'No CN assigned' };
export const eventLabels: Record<string, string> = {
  ORDER_IMPORTED: 'Imported an order', ORDER_PACKED: 'Packed an order', ORDER_DISPATCHED: 'Dispatched a parcel', ITEMS_VERIFIED: 'Verified products', CN_ASSIGNED: 'Assigned a courier CN', CN_IMPORTED: 'Imported tracking details', PARCEL_SCANNED: 'Looked up a parcel', PENDING_VERIFIED: 'Checked an outstanding order', ORDER_UPDATED: 'Shopify order updated', SYNC_STARTED: 'Started a Shopify import', SYNC_COMPLETED: 'Completed a Shopify import', SYNC_FAILED: 'Shopify import needs attention', SYNC_PAUSED: 'Import will continue shortly', SHOPIFY_FULFILLED: 'Synced fulfillment to Shopify', SHOPIFY_SYNC_FAILED: 'Shopify dispatch sync failed', SHOPIFY_SYNC_RETRIED: 'Retried Shopify sync', RECONCILIATION_RECORDED: 'Recorded a reconciliation', REVIEW_CHECKED: 'Checked a Shopify discrepancy', USER_CREATED: 'Created a staff account', USER_UPDATED: 'Updated staff access', USER_SIGNED_IN: 'Signed in', PASSWORD_CHANGED: 'Changed their password', PASSWORD_RESET: 'Reset a staff password', WORKSPACE_CREATED: 'Created the workspace', SETTINGS_UPDATED: 'Updated workspace settings', SHOPIFY_CONNECTED: 'Connected Shopify', WEBHOOKS_REGISTERED: 'Enabled live webhooks', BACKUP_CREATED: 'Created a database backup', BACKUP_FAILED: 'Backup needs attention', BACKUP_DOWNLOADED: 'Downloaded a backup', REPORT_EXPORTED: 'Exported an Excel report', DAILY_ROLLOVER: 'Carried pending orders forward', CN_CONFLICT: 'Detected a duplicate or conflicting CN',
};
