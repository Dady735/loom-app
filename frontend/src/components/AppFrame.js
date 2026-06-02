import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Frame,
  Navigation,
  TopBar,
} from '@shopify/polaris';
import {
  HomeIcon,
  RefreshIcon,
  SearchIcon,
  AlertTriangleIcon,
  ListBulletedIcon,
} from '@shopify/polaris-icons';

export default function AppFrame({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  const navigationItems = [
    {
      label: 'Dashboard',
      icon: HomeIcon,
      onClick: () => navigate('/'),
      selected: location.pathname === '/',
    },
    {
      label: 'Sync Control',
      icon: RefreshIcon,
      onClick: () => navigate('/sync'),
      selected: location.pathname === '/sync',
    },
    {
      label: 'Tracking Lookup',
      icon: SearchIcon,
      onClick: () => navigate('/tracking'),
      selected: location.pathname === '/tracking',
    },
    {
      label: 'Manual Override',
      icon: AlertTriangleIcon,
      onClick: () => navigate('/override'),
      selected: location.pathname === '/override',
    },
    {
      label: 'Log Viewer',
      icon: ListBulletedIcon,
      onClick: () => navigate('/logs'),
      selected: location.pathname === '/logs',
    },
  ];

  const topBarMarkup = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setIsMobileNavOpen((prev) => !prev)}
    />
  );

  const navigationMarkup = (
    <Navigation location={location.pathname}>
      <Navigation.Section
        title="Loom"
        items={navigationItems}
        separator
      />
    </Navigation>
  );

  return (
    <Frame
      topBar={topBarMarkup}
      navigation={navigationMarkup}
      showMobileNavigation={isMobileNavOpen}
      onNavigationDismiss={() => setIsMobileNavOpen(false)}
    >
      {children}
    </Frame>
  );
}
