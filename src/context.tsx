import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { api, setCsrf, errorMessage } from './api';
import type { Permission, SessionInfo, User } from '../shared/types';

interface Toast { id: number; message: string; type: 'success' | 'error' }
interface Context {
  session: SessionInfo | null; setSession: (s: SessionInfo | null) => void; reloadSession: () => Promise<void>;
  revision: number; refresh: () => void; live: boolean; toast: (message: string, type?: 'success' | 'error') => void;
  hasPermission: (permission: Permission) => boolean;
}
const AppContext = createContext<Context>(null!);
export const useApp = () => useContext(AppContext);
export const roleLabels = { owner: 'Owner', supervisor: 'Supervisor', staff: 'Shipping staff' };
const permissionMap: Record<string, Permission[]> = {
  owner: ['import', 'assign', 'verify', 'pack', 'dispatch', 'check', 'reconcile', 'reports', 'staff', 'settings', 'activity'],
  supervisor: ['import', 'assign', 'verify', 'pack', 'dispatch', 'check', 'reports', 'activity'],
  staff: ['verify', 'pack', 'dispatch', 'check'],
};
export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionInfo | null>(null);
  const [revision, setRevision] = useState(0); const [live, setLive] = useState(false); const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const setSession = useCallback((value: SessionInfo | null) => { setCsrf(value?.csrf || null); setSessionState(value); }, []);
  const reloadSession = useCallback(async () => { const value = await api<SessionInfo>('/session'); setSession(value); }, [setSession]);
  useEffect(() => { reloadSession().catch(e => setToasts([{ id: 0, message: errorMessage(e), type: 'error' }])); }, [reloadSession]);
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) return;
    const source = new EventSource('/api/events');
    source.addEventListener('ready', () => { setLive(true); refresh(); });
    source.addEventListener('change', refresh);
    source.onerror = () => setLive(false);
    const fallback = setInterval(refresh, 60000);
    return () => { source.close(); clearInterval(fallback); setLive(false); };
  }, [userId, refresh]);
  useEffect(() => {
    const handle = (event: Event) => { const status = (event as CustomEvent).detail; if (status === 401) { setSession(null); void reloadSession().catch(() => {}); } };
    window.addEventListener('session-expired', handle); return () => window.removeEventListener('session-expired', handle);
  }, [reloadSession, setSession]);
  const toast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++nextId.current; setToasts(t => [...t.slice(-3), { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), type === 'error' ? 8000 : 4500);
  }, []);
  const hasPermission = useCallback((p: Permission) => !!session?.user && permissionMap[session.user.role].includes(p), [session?.user]);
  return <AppContext.Provider value={{ session, setSession, reloadSession, revision, refresh, live, toast, hasPermission }}>
    {children}
    <div className="toast-stack" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.type === 'success' ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}<span>{t.message}</span><button aria-label="Dismiss notification" onClick={() => setToasts(v => v.filter(x => x.id !== t.id))}><X size={16} /></button></div>)}</div>
  </AppContext.Provider>;
}
export function userInitials(user: Pick<User, 'name'>) { return user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase(); }
