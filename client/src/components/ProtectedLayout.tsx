import React from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

/**
 * Wraps all authenticated pages with a persistent bottom navigation bar.
 * Adds bottom padding so page content doesn't sit behind the nav.
 */
export default function ProtectedLayout() {
  return (
    // Mobile browsers (especially iOS Safari) dynamically resize the visual viewport as the URL bar
    // hides/shows while scrolling. Using dvh/svh + safe-area padding helps keep the bottom nav
    // visually pinned to the bottom of the screen.
    <div
      className="w-full"
      style={{
        minHeight: '100dvh',
        paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))',
      }}
    >
      <Outlet />
      <BottomNav />
    </div>
  );
}
