import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function SiteAdminLogin() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  async function login() {
    if (!online) {
      setMsg('No connection – Log in requires network');
      return;
    }
    if (!username) {
      setMsg('Enter email (or Admin)');
      return;
    }
    if (!password) {
      setMsg('Enter password');
      return;
    }
    try {
      const res = await api('/api/site-admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      const db = await getDB();
      await db.put(
        'session',
        { token: res.token, username: res.username, sites: res.sites, super_admin: !!res.super_admin },
        'site_admin',
      );
      setMsg('Admin logged in');
      setTimeout(() => nav('/SiteAdmin'), 600);
    } catch {
      setMsg('User or password is incorrect');
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
            placeholder="Email (or Admin)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!online && (
            <div className="text-red-600 text-sm">No connection – Log in requires network</div>
          )}
          <button className="btn w-full" onClick={login} disabled={!online}>
            TAG IN
          </button>
          <div className="text-xs text-sky-600 cursor-pointer" onClick={() => nav('/Home')}>
            User Login
          </div>
        </div>
      </div>
    </div>
  );
}
