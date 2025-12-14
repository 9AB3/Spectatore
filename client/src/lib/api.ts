import { getDB } from './idb';

/**
 * Environment flags
 */
const IS_DEV = import.meta.env.MODE !== 'production';

/**
 * API base resolution
 *
 * - DEV:
 *   - allow Vite proxy (/api)
 *   - fallback to localhost:5000 if called directly
 *
 * - PROD:
 *   - MUST use VITE_API_BASE
 *   - never guess ports or hostnames
 */
const DEV_FALLBACK_BASE =
  typeof window !== 'undefined' && window.location
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : 'http://localhost:5000';

const BASE = IS_DEV
  ? import.meta.env.VITE_API_BASE || DEV_FALLBACK_BASE
  : import.meta.env.VITE_API_BASE;

if (!IS_DEV && !BASE) {
  // Fail fast instead of silently hitting the wrong host
  console.error(
    '❌ VITE_API_BASE is not set for production build – API calls will fail',
  );
}

/**
 * Main API wrapper
 */
export async function api(path: string, init: RequestInit = {}) {
  let url: string;

  // Absolute URLs are passed through untouched
  if (path.startsWith('http')) {
    url = path;
  }
  // Dev mode: allow proxy paths like /api/...
  else if (IS_DEV && path.startsWith('/api')) {
    url = path;
  }
  // Everything else must go via BASE
  else {
    if (!BASE) {
      throw new Error('API base URL is not configured');
    }
    url = `${BASE}${path}`;
  }

  const headers = new Headers(init.headers || {});

  // Attach auth token from IndexedDB session store
  try {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    if (session?.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${session.token}`);
    }
  } catch {
    // ignore – offline or no session yet
  }

  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const res = await fetch(url, {
      ...init,
      headers,
      credentials: init.credentials ?? 'same-origin',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || res.statusText || `HTTP ${res.status}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  } catch (e: any) {
    if (e?.message?.includes('Failed to fetch')) {
      throw new Error(
        'Network error: failed to reach API (CORS, server down, or wrong API base)',
      );
    }
    throw e;
  }
}

/**
 * Helper when cookies / credentials are required
 */
export function apiWithCreds(path: string, init: RequestInit = {}) {
  return api(path, { ...init, credentials: 'include' });
}
