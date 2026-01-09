import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './router';
import './index.css';
import { registerSW } from './lib/sw';

// Only register the PWA service worker on the app subdomain.
// IMPORTANT: Do NOT register on localhost during dev, otherwise the SW cache
// can make the UI appear "stuck" (you end up needing hard refresh / clear site data).
const host = typeof window !== 'undefined' ? window.location.hostname : '';
const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
const isAppHost = host.startsWith('app.');

// Allow opting-in locally if you explicitly need SW (e.g. push testing)
// Set VITE_ENABLE_SW_DEV=1 in client/.env.local
const enableSwDev = String(import.meta.env.VITE_ENABLE_SW_DEV || '') === '1';

if (isAppHost || (isLocal && enableSwDev)) registerSW();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
      React Router v6 shows future-flag warnings in dev. These flags opt-in early
      to the v7 behaviors and silence the warnings.
      If your installed react-router-dom types don't yet include `future`, update react-router-dom to a recent v6 release.
    */}
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);