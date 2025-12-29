import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function Home() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [isAdmin, setIsAdmin] = useState(false);

  // Track browser online/offline state
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  // On mount, restore remembered email (if any)
  useEffect(() => {
    const savedEmail = localStorage.getItem('spectatore-login-email');
    if (savedEmail) setEmail(savedEmail);

    // Persist "Remember me" state until user unticks it
    const savedRemember = localStorage.getItem('spectatore-remember-me');
    if (savedRemember === '1') setRemember(true);
  }, []);

  // When connectivity changes, decide whether to auto-continue based on session + remember flag
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');

      if (session) {
        setIsAdmin(!!session.is_admin);
        // Offline: if we have a session token, allow continuing into Main (existing behaviour)
        // Online: only auto-continue if the user previously ticked "Remember me"
        if (session.token && (!online || session.remember)) {
          nav('/Main');
        }
      }
    })();
  }, [online, nav]);

  const canLogin = online && !!email;

  async function login() {
    if (!online) {
      setMsg('No connection – Log in requires network');
      return;
    }
    if (!email) {
      setMsg('Enter your email');
      return;
    }
    if (password.length < 8) {
      setMsg('Password must be at least 8 characters');
      return;
    }
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const db = await getDB();
      const isAdminFlag = !!(res.is_admin || res.role === 'admin');
      await db.put(
        'session',
        { token: res.token, user_id: res.user_id, is_admin: isAdminFlag, remember },
        'auth',
      );

      // Persist email locally only if user chose "Remember me"
      if (remember) {
        localStorage.setItem('spectatore-login-email', email);
      } else {
        localStorage.removeItem('spectatore-login-email');
      }

      // Persist remember tick until explicitly unticked
      localStorage.setItem('spectatore-remember-me', remember ? '1' : '0');

      setIsAdmin(isAdminFlag);
      setMsg('Tagged on');
      // Keep toast visible for at least 2s before route change
      setTimeout(() => nav('/Main'), 2000);
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        setMsg(
          msg.includes('Too many')
            ? 'Too many attempts. Try again in 5 minutes'
            : 'Email or password is incorrect',
        );
      } catch {
        setMsg('Email or password is incorrect');
      }
    }
  }

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
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                const v = e.target.checked;
                setRemember(v);
                localStorage.setItem('spectatore-remember-me', v ? '1' : '0');
              }}
            />
            Remember me
          </label>
          {!online && (
            <div className="text-red-600 text-sm">No connection – Log in requires network</div>
          )}
          <button className="btn w-full" onClick={login} disabled={!canLogin}>
            TAG IN
          </button>
          <button className="btn w-full" onClick={() => nav('/Register')}>
            GET INDUCTED
          </button>
          <button className="btn w-full" onClick={() => nav('/ForgotPassword')}>
            LOST TAG
          </button>
          <div
            className="text-xs text-sky-600 cursor-pointer mt-1"
            onClick={() => nav('/SiteAdminLogin')}
          >
            Site Admin
          </div>
        </div>
      </div>
    </div>
  );
}
