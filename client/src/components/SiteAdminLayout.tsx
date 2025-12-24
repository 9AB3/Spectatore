import React from 'react';
import { Outlet } from 'react-router-dom';
import SiteAdminBottomNav from './SiteAdminBottomNav';

/**
 * Wraps Site Admin pages with a persistent bottom navigation bar.
 * Adds bottom padding so page content doesn't sit behind the nav.
 */
export default function SiteAdminLayout() {
  return (
    <div
      className="w-full"
      style={{
        minHeight: '100dvh',
        paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))',
      }}
    >
      <Outlet />
      <SiteAdminBottomNav />
    </div>
  );
}
