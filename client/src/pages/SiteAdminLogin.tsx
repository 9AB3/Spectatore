import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

/**
 * FIX18: Single login, role-driven SiteAdmin
 * - One screen (email + password)
 * - Authentication via /api/auth/login
 * - Authorization enforced ONLY by server via /api/site-admin/me
 */
export default function SiteAdminLogin() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  // If already logged in, try to enter SiteAdmin immediately.
  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        const savedEmail = localStorage.getItem('spectatore-login-email');
        if (savedEmail && !email) setEmail(savedEmail);

        if (session?.token) {
          try {
            const me: any = await api('/api/site-admin/me');
            if (me?.ok) {
              nav('/SiteAdmin', { replace: true });
              return;
            }
          } catch {
            // ignore, user may be logged in but not authorized
          }
        }
      } finally {
        setChecking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login() {
    if (!online) return setMsg('No connection – Log in requires network');
    if (!email.trim()) return setMsg('Enter your email');
    if (password.length < 8) return setMsg('Password must be at least 8 characters');

    setBusy(true);
    try {
      localStorage.setItem('spectatore-login-email', email.trim());

      const res: any = await api('/api/auth/login', {
        method: 'POST',
        body: { email: email.trim(), password },
      });

      const db = await getDB();
      await db.put('session', { token: res.token, user_id: res.user_id }, 'auth');

      // Server is the only source of truth for SiteAdmin authorization.
      const scope: any = await api('/api/site-admin/me');
      if (scope?.ok) {
        nav('/SiteAdmin', { replace: true });
        return;
      }

      setMsg('You do not have Site Admin access');
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        setMsg(msg ? String(msg) : 'Email or password is incorrect');
      } catch {
        setMsg('Email or password is incorrect');
      }
    } finally {
      setBusy(false);
    }
  }

  if (checking) return null;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Toast />
      <div className="card w-full max-w-sm text-center">
        <img src="/logo.png" alt="Spectatore" className="mx-auto mb-4 w-56 h-56 object-contain" />

        <div className="space-y-3">
          <input
            className="input"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {!online && <div className="text-red-600 text-sm">No connection – Log in requires network</div>}
          <button className="btn w-full" onClick={login} disabled={!online || busy}>
            {busy ? 'Signing in…' : 'TAG IN'}
          </button>

          <div className="text-xs text-sky-600 cursor-pointer" onClick={() => nav('/Home')}>
            Back to User Login
          </div>
        </div>
      </div>
    </div>
  );
}
