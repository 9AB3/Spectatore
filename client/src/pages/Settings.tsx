import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { disablePush, enablePush, getExistingSubscription, isPushSupported } from '../lib/push';
import { getDB } from '../lib/idb';

type Membership = {
  id: number;
  site_id: number | null;
  site: string;
  role: string;
  status: string;
};

type Me = {
  id: number;
  email: string;
  site: string | null;
  name?: string | null;
  memberships?: Membership[];
};

function normaliseRole(raw: any): 'member' | 'validator' | 'admin' {
  const r = String(raw || '').toLowerCase();
  if (['admin', 'site_admin'].includes(r)) return 'admin';
  if (['validator', 'site_validator'].includes(r)) return 'validator';
  return 'member';
}

export default function Settings() {
  const { Toast, setMsg } = useToast();

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);

  // profile
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // active site selector
  const [activeSiteIdStr, setActiveSiteIdStr] = useState<string>('0');

  // membership / join
  const [officialSites, setOfficialSites] = useState<Array<{ id: number; name: string }>>([]);
  const [showAddSite, setShowAddSite] = useState(false);
  const [joinSiteId, setJoinSiteId] = useState<number>(0);
  const [joinRole, setJoinRole] = useState<'member' | 'validator' | 'admin'>('member');
  const [confirmLeave, setConfirmLeave] = useState<{ site_id: number; site: string } | null>(null);

  // push notifications
  const [pushSupported, setPushSupported] = useState<boolean>(false);
  const [pushEnabled, setPushEnabled] = useState<boolean>(false);
  const [pushBusy, setPushBusy] = useState<boolean>(false);

  const memberships = useMemo(() => {
    const raw = Array.isArray(me?.memberships) ? (me!.memberships as Membership[]) : [];
    return raw.filter((m) => {
      const st = String(m?.status || '').toLowerCase();
      return st === 'active' || st === 'requested';
    });
  }, [me]);

  const activeSites = useMemo(() => {
    return memberships
      .filter((m) => String(m?.status || '').toLowerCase() === 'active' && m.site_id)
      .map((m) => ({ site_id: Number(m.site_id), site: String(m.site) }));
  }, [memberships]);

  async function refreshMe() {
    const res = (await api('/api/user/me')) as Me;
    setMe(res);
    setEmail(res.email || '');

    // Selector should match an active membership site (if current user.site corresponds), else Personal
    const currentSiteName = String(res.site || '').trim();
    const activeMatch = (Array.isArray(res?.memberships) ? res!.memberships! : []).find((m: any) => {
      const st = String(m?.status || '').toLowerCase();
      return st === 'active' && m.site_id && String(m.site || '').trim() === currentSiteName;
    });
    setActiveSiteIdStr(activeMatch ? String(activeMatch.site_id) : '0');
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await api('/api/user/me')) as Me;
        if (cancelled) return;
        setMe(res);
        setEmail(res.email || '');
        const currentSiteName = String(res.site || '').trim();
        const activeMatch = (Array.isArray(res?.memberships) ? res!.memberships! : []).find((m: any) => {
          const st = String(m?.status || '').toLowerCase();
          return st === 'active' && m.site_id && String(m.site || '').trim() === currentSiteName;
        });
        setActiveSiteIdStr(activeMatch ? String(activeMatch.site_id) : '0');
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
  }, [setMsg]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await api('/api/user/sites')) as any;
        if (cancelled) return;
        const sites = Array.isArray(r?.sites) ? r.sites : [];
        setOfficialSites(sites);
      } catch {
        // ignore
        setOfficialSites([]);
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
      const payload: any = { email: email.trim() };

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })) as any;

      if (res?.token) {
        const db = await getDB();
        const session = (await db.get('session', 'auth')) || {};
        await db.put('session', { ...session, token: res.token }, 'auth');
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      // Always refresh after a profile update so we keep derived fields
      // like memberships / roles in-sync.
      await refreshMe();

      setMsg('Saved');
    } catch (err: any) {
      setMsg(err?.message || 'Update failed');
    }
  }

  async function requestJoin() {
    try {
      if (!joinSiteId) {
        setMsg('Please select a site');
        return;
      }
      await api('/api/user/site-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: joinSiteId, role: joinRole }),
      });
      await refreshMe();
      setShowAddSite(false);
      setJoinSiteId(0);
      setJoinRole('member');
      setMsg('Request sent');
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message || 'Failed to request access');
    }
  }

  async function leaveSite(site_id: number) {
    try {
      await api('/api/user/memberships/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id }),
      });
      await refreshMe();
      setMsg('Updated');
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message || 'Failed to leave site');
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
          <p style={{ marginTop: 6, opacity: 0.85 }}>Get a phone/desktop notification for crew requests and milestones.</p>

          {!pushSupported ? (
            <p style={{ margin: 0, color: '#999' }}>Not supported on this browser/device.</p>
          ) : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ opacity: 0.9 }}>
                Status: <b>{pushEnabled ? 'Enabled' : 'Off'}</b>
              </span>
              <span style={{ opacity: 0.65, fontSize: 12 }}>(You may need to install the PWA for reliable push.)</span>

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
                  <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>

                <div>
                  <label className="block text-sm mb-1">Current site</label>
                  <select
                    className="input"
                    value={activeSiteIdStr}
                    onChange={async (e) => {
                      const v = e.target.value;
                      setActiveSiteIdStr(v);
                      const sid = Number(v || '0') || 0;
                      try {
                        await api('/api/user/active-site', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ site_id: sid }),
                        });
                        await refreshMe();
                      } catch (err: any) {
                        setMsg(err?.message || 'Failed to change current site');
                      }
                    }}
                  >
                    <option value="0">Personal (not linked to a site)</option>
                    {activeSites.map((s) => (
                      <option key={String(s.site_id)} value={String(s.site_id)}>
                        {s.site}
                      </option>
                    ))}
                  </select>
                  <div className="text-xs opacity-60 mt-1">
                    Personal equipment/locations always stay available. If you select a site you&apos;re a member of, that site&apos;s equipment/locations are also available.
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="font-semibold mb-2">Membership & roles</div>

              <div className="text-sm">
                {!memberships.length ? (
                  <div className="text-xs opacity-70">No site memberships found.</div>
                ) : (
                  <div className="space-y-2">
                    {memberships.map((m) => {
                      const st = String(m.status || '').toLowerCase();
                      const siteId = Number(m.site_id || 0);
                      const siteName = String(m.site || '');
                      const key = String(siteId || m.id || siteName);
                      return (
                        <div key={key} className="flex items-center justify-between gap-2 border rounded-xl p-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{siteName}</div>
                            <div className="text-xs opacity-70">
                              Role: <b>{normaliseRole(m.role)}</b>
                              {st === 'requested' ? <span className="opacity-70"> (requested)</span> : null}
                            </div>
                          </div>
                          {siteId ? (
                            <button type="button" className="btn btn-outline" onClick={() => setConfirmLeave({ site_id: siteId, site: siteName })}>
                              {st === 'requested' ? 'Cancel' : 'Leave'}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="border-t pt-3 mt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">Access</div>
                    <button type="button" className="btn" onClick={() => setShowAddSite(true)}>
                      + Add site
                    </button>
                  </div>
                  <div className="text-xs opacity-60 mt-1">Request membership to another site (member/validator/admin).</div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="text-sm font-semibold mb-2">Change password</div>
              <div className="grid gap-3">
                <div>
                  <label className="block text-sm mb-1">Current password</label>
                  <input type="password" className="input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm mb-1">New password</label>
                  <input type="password" className="input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm mb-1">Confirm new password</label>
                  <input type="password" className="input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                </div>
              </div>
            </div>

            <button className="btn" type="submit">
              Save changes
            </button>

            {me?.email ? <div className="text-xs opacity-70">Signed in as: {me.email}</div> : null}
          </form>
        )}
      </div>

      {showAddSite ? (
        <div className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 overflow-auto pt-6 pb-24">
          <div className="card w-full max-w-md mx-4">
            <div className="font-semibold mb-2">Add site</div>

            <div className="space-y-3 text-sm">
              <div>
                <div className="opacity-70 mb-1">Site</div>
                <select className="input w-full" value={joinSiteId} onChange={(e) => setJoinSiteId(Number(e.target.value) || 0)}>
                  <option value={0}>Select a site…</option>
                  {officialSites.map((s) => (
                    <option key={String(s.id)} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="opacity-70 mb-1">Role requested</div>
                <select className="input w-full" value={joinRole} onChange={(e) => setJoinRole(e.target.value as any)}>
                  <option value="member">Member</option>
                  <option value="validator">Validator</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    setShowAddSite(false);
                    setJoinSiteId(0);
                    setJoinRole('member');
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="btn" onClick={requestJoin} disabled={!joinSiteId}>
                  Request access
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmLeave ? (
        <div className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 overflow-auto pt-6 pb-24">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-md mx-4 p-4">
            <div className="font-semibold text-lg mb-2">Leave site?</div>
            <div className="text-sm opacity-80 mb-4">
              Are you sure you want to leave <b>{confirmLeave.site}</b>?
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmLeave(null)}>
                No
              </button>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const c = confirmLeave;
                  setConfirmLeave(null);
                  if (c?.site_id) await leaveSite(c.site_id);
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
