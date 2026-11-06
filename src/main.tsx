import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './styles.css';
import { AppProvider, useApp } from './context';
import { Button, Loading } from './components';
import Layout, { PermissionGate } from './Layout';
import Login from './Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Orders = lazy(() => import('./pages/Orders'));
const Packing = lazy(() => import('./pages/Packing'));
const Dispatch = lazy(() => import('./pages/Dispatch'));
const Pending = lazy(() => import('./pages/Pending'));
const Reports = lazy(() => import('./pages/Reports'));
const Activity = lazy(() => import('./pages/Activity'));
const Staff = lazy(() => import('./pages/Staff'));
const Settings = lazy(() => import('./pages/Settings'));
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <div className="fatal-error"><h1>Let’s reload your workspace.</h1><p>Your saved orders and activity are safe. Reload to reconnect.</p><Button onClick={() => window.location.reload()}>Reload workspace</Button></div> : this.props.children; }
}
function App() {
  const { session } = useApp();
  if (!session) return <div className="boot-screen"><span className="boot-logo">m.</span><Loading label="Preparing your Mettwear workspace…" /></div>;
  if (!session.user) return <Login />;
  return <HashRouter><Suspense fallback={<Loading />}><Routes><Route element={<Layout />}><Route index element={<Dashboard />} /><Route path="orders" element={<Orders />} /><Route path="packing" element={<Packing />} /><Route path="packing/:id" element={<Packing />} /><Route path="dispatch" element={<Dispatch />} /><Route path="pending" element={<Pending />} /><Route path="reports" element={<PermissionGate permission="reports"><Reports /></PermissionGate>} /><Route path="activity" element={<Activity />} /><Route path="staff" element={<PermissionGate permission="staff"><Staff /></PermissionGate>} /><Route path="settings" element={<PermissionGate permission="settings"><Settings /></PermissionGate>} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes></Suspense></HashRouter>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><AppProvider><App /></AppProvider></ErrorBoundary></React.StrictMode>);
