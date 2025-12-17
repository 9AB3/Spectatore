import React from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

/**
 * Wraps all authenticated pages with a persistent bottom navigation bar.
 * Adds bottom padding so page content doesn't sit behind the nav.
 */
export default function ProtectedLayout() {
  return (
    <div className="min-h-screen pb-20">
      <Outlet />
      <BottomNav />
    </div>
  );
}
