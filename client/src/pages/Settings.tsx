import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { disablePush, enablePush, getExistingSubscription, isPushSupported } from '../lib/push';
import { getDB } from '../lib/idb';

type Me = { email: string; site: string | null };

export default function Settings() {
  const { Toast, setMsg } = useToast();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);

  // push notifications
  const [pushSupported, setPushSupported] = useState<boolean>(false);
  const [pushEnabled, setPushEnabled] = useState<boolean>(false);
  const [pushBusy, setPushBusy] = useState<boolean>(false);

  // form state
  const [email, setEmail] = useState('');
  const [site, setSite] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await api('/api/user/me')) as Me;
        if (cancelled) return;
        setMe(res);
        setEmail(res.email || '');
        setSite(res.site || '');
      } catch (e: any) {
        console.error(e);
        setMsg(e?.message || 'Failed to load settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


useEffect(() => {
  (async () => {
    try {
      const sup = await isPushSupported();
      setPushSupported(!!sup);
      if (!sup) return;
      const sub = await getExistingSubscription();
      setPushEnabled(!!sub);
    } catch {
      setPushSupported(false);
      setPushEnabled(false);
    }
  })();
}, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    try {
      const emailChanged = (me?.email || '').trim() !== email.trim();
      const siteChanged = (me?.site || '').trim() !== site.trim();

      const payload: any = {
        email: email.trim(),
        site: site.trim(),
      };

      if (newPassword || confirmPassword || currentPassword) {
        if (!currentPassword) throw new Error('Enter your current password');
        if (!newPassword) throw new Error('Enter a new password');
        if (newPassword.length < 6) throw new Error('New password must be at least 6 characters');
        if (newPassword !== confirmPassword) throw new Error('New passwords do not match');
        payload.current_password = currentPassword;
        payload.new_password = newPassword;
      }

      const res = (await api('/api/user/me', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })) as any;

      // If the API returns a new token (email change), update local session
      if (res?.token) {
        const db = await getDB();
        const session = (await db.get('session', 'auth')) || {};
        await db.put('session', { ...session, token: res.token }, 'auth');
      }

      const passwordChanged = !!payload.new_password;
      if (passwordChanged) setMsg('Password updated');
      else if (emailChanged) setMsg('Email updated');
      else if (siteChanged) setMsg('Site updated');
      else setMsg('Settings updated');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (res?.me) {
        setMe(res.me);
        setEmail(res.me.email || '');
        setSite(res.me.site || '');
      }
    } catch (err: any) {
      setMsg(err?.message || 'Update failed');
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-xl mx-auto">
        <h2 className="text-xl font-semibold mb-4">Settings</h2>

        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Push notifications</h3>
          <p style={{ marginTop: 6, opacity: 0.85 }}>
            Get a phone/desktop notification for crew requests and milestones.
          </p>

          {!pushSupported ? (
            <p style={{ margin: 0, color: '#999' }}>Not supported on this browser/device.</p>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ opacity: 0.9 }}>
                Status: <b>{pushEnabled ? 'Enabled' : 'Off'}</b>
              </span>
              <span style={{ opacity: 0.65, fontSize: 12 }}>
                (You may need to install the PWA for reliable push.)
              </span>

              {!pushEnabled ? (
                <button
                  type="button"
                  className="btn"
                  disabled={pushBusy}
                  onClick={async () => {
                    setPushBusy(true);
                    const r = await enablePush();
                    if (!r.ok) setMsg(r.error);
                    setPushBusy(false);
                    const sub = await getExistingSubscription();
                    setPushEnabled(!!sub);
                  }}
                >
                  Enable
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={pushBusy}
                  onClick={async () => {
                    setPushBusy(true);
                    const r = await disablePush();
                    if (!r.ok) setMsg(r.error);
                    setPushBusy(false);
                    const sub = await getExistingSubscription();
                    setPushEnabled(!!sub);
                  }}
                >
                  Disable
                </button>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="opacity-70">Loading...</div>
        ) : (
          <form className="grid gap-4" onSubmit={saveProfile}>
            <div className="card">
              <div className="grid gap-3">
                <div>
                  <label className="block text-sm mb-1">Email</label>
                  <input
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label className="block text-sm mb-1">Site</label>
                  <input
                    className="input"
                    value={site}
                    onChange={(e) => setSite(e.target.value)}
                    placeholder="e.g. Mine / Project"
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="text-sm font-semibold mb-2">Change password</div>
              <div className="grid gap-3">
                <div>
                  <label className="block text-sm mb-1">Current password</label>
                  <input
                    type="password"
                    className="input"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1">New password</label>
                  <input
                    type="password"
                    className="input"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1">Confirm new password</label>
                  <input
                    type="password"
                    className="input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <button className="btn" type="submit">
              Save changes
            </button>

            {me?.email && (
              <div className="text-xs opacity-70">
                Signed in as: {me.email}
              </div>
            )}
          </form>
        )}

      </div>
    </div>
  );
}
