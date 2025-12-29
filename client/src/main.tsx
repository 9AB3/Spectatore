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
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
