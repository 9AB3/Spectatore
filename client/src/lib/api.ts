import { getDB } from './idb';

const defaultApiBase =
  typeof window !== 'undefined' && window.location
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : 'http://localhost:5000';

const USE_PROXY = (import.meta as any).env?.VITE_USE_PROXY === '1';
//const IS_DEV = (import.meta as any).env?.MODE !== 'production';
const IS_DEV = import.meta.env.MODE !== 'production'; // add this near the top if missing
/* debug */ try {
  console.info('API base', defaultApiBase);
} catch {}
const BASE = (import.meta as any).env?.VITE_API_BASE || defaultApiBase;

export async function api(path: string, init: RequestInit = {}) {
  const url =
    IS_DEV && path.startsWith('/api') ? path : path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = new Headers(init.headers || {});
  try {
    const db = await getDB();
    const session = await db.get('session', 'auth');
    if (session?.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${session.token}`);
    }
  } catch (e) {}
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
      const txt = await res.text().catch(() => '');
      throw new Error(txt || res.statusText || `HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
  } catch (e: any) {
    if (e?.message && e.message.includes('Failed to fetch')) {
      throw new Error('Network error: failed to reach API (CORS, server down, or mixed content)');
    }
    throw e;
  }
}

export function apiWithCreds(path: string, init: RequestInit = {}) {
  return api(path, { ...init, credentials: 'include' });
}
