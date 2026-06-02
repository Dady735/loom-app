import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import AppFrame from './components/AppFrame';
import Dashboard from './pages/Dashboard';
import SyncControl from './pages/SyncControl';
import TrackingLookup from './pages/TrackingLookup';
import ManualOverride from './pages/ManualOverride';
import LogViewer from './pages/LogViewer';

function App() {
  return (
    <AppProvider i18n={enTranslations}>
      <BrowserRouter>
        <AppFrame>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sync" element={<SyncControl />} />
            <Route path="/tracking" element={<TrackingLookup />} />
            <Route path="/override" element={<ManualOverride />} />
            <Route path="/logs" element={<LogViewer />} />
          </Routes>
        </AppFrame>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;
