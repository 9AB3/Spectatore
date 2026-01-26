import Header from '../components/Header';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  workSite?: { id: number; name: string } | null;
  subscribedSite?: { id: number; name: string } | null;
  name?: string | null;
  community_state?: string | null;
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
  const nav = useNavigate();

  // Main Settings is a dashboard. Panels open into focused sub-views.
  const [view, setView] = useState<'dashboard' | 'account' | 'sites' | 'notifications' | 'data'>('dashboard');

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);

  // profile
  const [email, setEmail] = useState('');
  const [communityState, setCommunityState] = useState<string>('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // active site selector
  const [activeSiteIdStr, setActiveSiteIdStr] = useState<string>('0');

  // membership / join
  const [officialSites, setOfficialSites] = useState<Array<{ id: number; name: string }>>([]);
  const [showAddSite, setShowAddSite] = useState(false);
  const [joinSiteId, setJoinSiteId] = useState<number>(0);
  // Join requests are always "member". Role changes happen after approval.
  const [siteConsent, setSiteConsent] = useState<{ site_id: number; site: string; role: 'member' | 'validator' | 'admin' } | null>(null);
  const [siteConsentTick, setSiteConsentTick] = useState(false);
  const [siteConsentScrolled, setSiteConsentScrolled] = useState(false);
  const siteConsentBoxRef = useRef<HTMLDivElement | null>(null);

  // Ensure scroll-to-bottom gating doesn't deadlock when content doesn't overflow.
  useEffect(() => {
    if (!siteConsent) return;
    setSiteConsentTick(false);
    setSiteConsentScrolled(false);

    const t = setTimeout(() => {
      const el = siteConsentBoxRef.current;
      if (!el) return;
      const noScrollNeeded = el.scrollHeight <= el.clientHeight + 2;
      if (noScrollNeeded) setSiteConsentScrolled(true);
    }, 0);

    return () => clearTimeout(t);
  }, [siteConsent]);

  const [confirmLeave, setConfirmLeave] = useState<{ site_id: number; site: string } | null>(null);

  // Work Site
  const [workSiteOptions, setWorkSiteOptions] = useState<string[]>([]);
  const [workSiteSelect, setWorkSiteSelect] = useState<string>('');
  const [workSiteManual, setWorkSiteManual] = useState<string>('');

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
    setCommunityState((res as any).community_state || '');
    setActiveSiteIdStr(res.subscribedSite?.id ? String(res.subscribedSite.id) : '0');
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await api('/api/user/me')) as Me;
        if (cancelled) return;
        setMe(res);
        setEmail(res.email || '');
        setCommunityState((res as any).community_state || '');
        setActiveSiteIdStr((res as any).subscribedSite?.id ? String((res as any).subscribedSite.id) : '0');
        const wsName = String((res as any).workSite?.name || '').trim();
        if (wsName) {
          setWorkSiteSelect(wsName);
          setWorkSiteManual('');
        }
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

  // Work Site directory for the chooser
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r: any = await api('/api/work-sites');
        if (cancelled) return;
        const names = Array.isArray(r?.sites)
          ? r.sites
              .map((s: any) => String(s?.name || '').trim())
              .filter(Boolean)
          : [];
        if (names.length) setWorkSiteOptions(names);
      } catch {
        if (!cancelled) setWorkSiteOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the Work Site selector consistent when the official list loads.
  useEffect(() => {
    const current = String((me as any)?.workSite?.name || '').trim();
    if (!current) return;

    // If the current Work Site is not in the official list, show it as "Not in List" + manual value.
    if (workSiteOptions.length && !workSiteOptions.includes(current)) {
      setWorkSiteSelect('Not in List');
      setWorkSiteManual(current);
      return;
    }

    // If it is in the official list, select it.
    if (workSiteOptions.length && workSiteOptions.includes(current)) {
      setWorkSiteSelect(current);
      setWorkSiteManual('');
    }
  }, [me, workSiteOptions]);



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
      const currentCommunityState = String((me as any)?.community_state || '').trim();
      const desiredCommunityState = String(communityState || '').trim().toUpperCase();
      if (desiredCommunityState !== currentCommunityState) {
        payload.community_state = desiredCommunityState || 'UNK';
      }


      // Apply Work Site change (separate from memberships / Subscribed Site)
      const currentWorkSite = String((me as any)?.workSite?.name || '').trim();
      const desiredWorkSite =
        (workSiteSelect === 'Not in List' ? workSiteManual : workSiteSelect).trim();
      const workSiteDirty = !!desiredWorkSite && desiredWorkSite !== currentWorkSite;

      // Apply Subscribed Site change (requires active membership)
      const currentSubscribedId = Number((me as any)?.subscribedSite?.id || 0);
      const desiredSubscribedId = Number(activeSiteIdStr || '0') || 0;
      const subscribedDirty = desiredSubscribedId !== currentSubscribedId;



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


      // Save Work Site and/or Subscribed Site as part of the single "Save changes" action
      if (workSiteDirty) {
        await api('/api/user/work-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ work_site_name: desiredWorkSite }),
        });
      }
      if (subscribedDirty) {
        await api('/api/user/active-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ site_id: desiredSubscribedId }),
        });
      }

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

  async function requestJoinWithConsent(site_id: number, consentVersion = 'v1') {
    try {
      if (!site_id) {
        setMsg('Please select a site');
        return;
      }
      await api('/api/user/site-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id, site_consent_version: consentVersion }),
      });
      await refreshMe();
      setShowAddSite(false);
      setJoinSiteId(0);
      setMsg('Request sent');
    } catch (e: any) {
      console.error(e);
      setMsg(e?.message || 'Failed to request access');
    }
  }

  function beginJoinFlow() {
    if (!joinSiteId) {
      setMsg('Please select a site');
      return;
    }
    const site = officialSites.find((s) => Number(s.id) === Number(joinSiteId))?.name || 'Site';
    setSiteConsent({ site_id: joinSiteId, site, role: 'member' });
    setSiteConsentTick(false);
    setSiteConsentScrolled(false);
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

      <div className="p-6 max-w-4xl mx-auto">
        {/* Title + in-page back */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-2xl font-semibold">Settings</h2>
            <div className="text-sm opacity-70 mt-1">
              {view === 'dashboard'
                ? 'Control dashboard for your account, sites, notifications and data.'
                : 'Adjust one panel at a time.'}
            </div>
          </div>
          {view !== 'dashboard' ? (
            <button type="button" className="btn" onClick={() => setView('dashboard')}>Back</button>
          ) : null}
        </div>

        {/* DASHBOARD */}
        {view === 'dashboard' ? (
          <div className="grid gap-4 md:grid-cols-2 mb-4">
            <div className="card">
              <div className="text-xs tracking-wider uppercase opacity-70">Account</div>
              <div className="text-lg font-semibold mt-1">Profile & security</div>
              <div className="text-sm opacity-80 mt-1">Email, password, and sign out.</div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="text-xs opacity-60 truncate">{me?.email ? `Signed in as ${me.email}` : ''}</div>
                <button type="button" className="btn" onClick={() => setView('account')}>Open</button>
              </div>
            </div>

            <div className="card">
              <div className="text-xs tracking-wider uppercase opacity-70">Billing</div>
              <div className="text-lg font-semibold mt-1">My subscription</div>
              <div className="text-sm opacity-80 mt-1">View your plan, renewal date, and manage billing.</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" className="btn" onClick={() => nav('/Subscription')}>Open</button>
              </div>
            </div>

            <div className="card">
              <div className="text-xs tracking-wider uppercase opacity-70">Sites</div>
              <div className="text-lg font-semibold mt-1">Work & subscribed</div>
              <div className="text-sm opacity-80 mt-1">Memberships, roles, active subscribed site.</div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="text-xs opacity-60 truncate">
                  Active: {activeSiteIdStr !== '0' ? (activeSites.find((s) => String(s.site_id) === activeSiteIdStr)?.site || 'Site') : 'Personal'}
                </div>
                <button type="button" className="btn" onClick={() => setView('sites')}>Open</button>
              </div>
            </div>

            <div className="card">
              <div className="text-xs tracking-wider uppercase opacity-70">Notifications</div>
              <div className="text-lg font-semibold mt-1">In-app & push</div>
              <div className="text-sm opacity-80 mt-1">Milestones, crew requests, bundling and push status.</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" className="btn" onClick={() => setView('notifications')}>Open</button>
              </div>
            </div>

            <div className="card">
              <div className="text-xs tracking-wider uppercase opacity-70">Data</div>
              <div className="text-lg font-semibold mt-1">Storage & reset</div>
              <div className="text-sm opacity-80 mt-1">Clear offline cache, troubleshooting and legal links.</div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" className="btn" onClick={() => setView('data')}>Open</button>
              </div>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="text-sm opacity-70">Loading…</div>
        ) : (
          <>
            {/* ACCOUNT PANEL */}
            {view === 'account' ? (
              <form onSubmit={saveProfile} className="grid gap-4">
                <div className="card">
                  <div className="text-xs tracking-wider uppercase opacity-70">Account</div>
                  <div className="text-lg font-semibold mt-1">Profile</div>

                  <div className="mt-3 grid gap-3">
                    <div>
                      <label className="block text-sm mb-1">Email</label>
                      <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                    </div>
                    {me?.email ? <div className="text-xs opacity-70">Signed in as: {me.email}</div> : null}
                    <div className="mt-2">
                      <label className="block text-sm mb-1">State (Australia) <span className="opacity-60 text-xs">(optional)</span></label>
                      <select className="input" value={communityState} onChange={(e) => setCommunityState(e.target.value)}>
                        <option value="">Unknown</option>
                        <option value="NSW">NSW</option>
                        <option value="VIC">VIC</option>
                        <option value="QLD">QLD</option>
                        <option value="WA">WA</option>
                        <option value="SA">SA</option>
                        <option value="TAS">TAS</option>
                        <option value="ACT">ACT</option>
                        <option value="NT">NT</option>
                      </select>
                      <div className="text-xs opacity-60 mt-1">
                        Used only for aggregated Community stats (state heatmap) when automatic geolocation headers aren&apos;t available.
                      </div>
                    </div>

                  </div>
                </div>

                <div className="card">
                  <div className="text-xs tracking-wider uppercase opacity-70">Security</div>
                  <div className="text-lg font-semibold mt-1">Password</div>

                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div>
                      <label className="block text-sm mb-1">Current</label>
                      <input type="password" className="input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">New</label>
                      <input type="password" className="input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">Confirm</label>
                      <input type="password" className="input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <button className="btn" type="submit">Save</button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      localStorage.removeItem('token');
                      nav('/');
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </form>
            ) : null}

            {/* SITES PANEL */}
            {view === 'sites' ? (
              <form onSubmit={saveProfile} className="grid gap-4">
                <div className="card">
                  <div className="text-xs tracking-wider uppercase opacity-70">Sites</div>
                  <div className="text-lg font-semibold mt-1">Work & subscribed</div>
                  <div className="mt-3 grid gap-3">
                    <div>
                      <label className="block text-sm mb-1">Work Site</label>
                      <select className="input" value={workSiteSelect} onChange={(e) => setWorkSiteSelect(e.target.value)}>
                        {workSiteOptions.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                        <option value="Not in List">Not in List</option>
                      </select>
                      {workSiteSelect === 'Not in List' ? (
                        <input className="input mt-2" value={workSiteManual} onChange={(e) => setWorkSiteManual(e.target.value)} placeholder="Enter Work Site name" />
                      ) : null}
                      <div className="text-xs opacity-60 mt-1">
                        Where you currently work (persists across moves). If your work site has an official Spectatore subscription, select it below as your
                        <b> subscribed site</b> to enable official equipment/locations, validation and dashboards.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs tracking-wider uppercase opacity-70">Membership</div>
                      <div className="text-lg font-semibold mt-1">Access & roles</div>
                      <div className="text-sm opacity-80 mt-1">Join sites, set your active subscribed site, and leave when needed.</div>
                    </div>
                    <button type="button" className="btn" onClick={() => setShowAddSite(true)}>+ Add site</button>
                  </div>

                  <div className="mt-3">
                    <label className="block text-sm mb-1">Active subscribed site</label>
                    <select className="input" value={activeSiteIdStr} onChange={(e) => setActiveSiteIdStr(e.target.value)}>
                      <option value="0">Personal (no subscribed site)</option>
                      {activeSites.map((s) => (
                        <option key={String(s.site_id)} value={String(s.site_id)}>{s.site}</option>
                      ))}
                    </select>
                    <div className="text-xs opacity-60 mt-1">
                      <b>Work site</b> = where you currently work. <b>Subscribed site</b> = the same work site <i>when that site has a paid Spectatore subscription</i>
                      for official data management (site equipment/locations, validation, and dashboards).
                    </div>
                  </div>

                  <div className="mt-3 text-sm">
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
                            <div key={key} className="tv-list-item">
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
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <button className="btn" type="submit">Save</button>
                  <div className="text-xs opacity-60">Tip: membership requests apply immediately; Work/Subscribed site changes require Save.</div>
                </div>
              </form>
            ) : null}

            {/* NOTIFICATIONS PANEL */}
            {view === 'notifications' ? (
              <div className="grid gap-4 md:grid-cols-2 mb-4">
                <div className="card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs tracking-wider uppercase opacity-70">Notifications</div>
                      <div className="text-lg font-semibold mt-1">Preferences</div>
                      <div className="text-sm opacity-80 mt-1">Milestones, crew requests, in-app vs push.</div>
                    </div>
                    <button className="btn" onClick={() => nav('/NotificationPreferences')}>Open</button>
                  </div>
                </div>

                <div className="card">
                  <div className="text-xs tracking-wider uppercase opacity-70">Notifications</div>
                  <div className="text-lg font-semibold mt-1">Push</div>
                  <div className="text-sm opacity-80 mt-1">Phone/desktop notifications for crew requests and milestones.</div>

                  <div className="mt-3">
                    {!pushSupported ? (
                      <div className="text-sm" style={{ color: '#999' }}>Not supported on this browser/device.</div>
                    ) : (
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-sm">
                          Status: <b>{pushEnabled ? 'Enabled' : 'Off'}</b>
                          <div className="text-xs opacity-60 mt-1">(Installing the PWA is usually best for reliable push.)</div>
                        </div>

                        <button
                          type="button"
                          className="btn"
                          disabled={pushBusy}
                          onClick={async () => {
                            try {
                              setPushBusy(true);
                              if (!pushEnabled) {
                                await enablePush();
                                setPushEnabled(true);
                                setMsg('Push enabled');
                              } else {
                                await disablePush();
                                setPushEnabled(false);
                                setMsg('Push disabled');
                              }
                            } catch (e: any) {
                              console.error(e);
                              setMsg(e?.message || 'Failed to update push settings');
                            } finally {
                              setPushBusy(false);
                            }
                          }}
                        >
                          {pushEnabled ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {/* DATA PANEL */}
            {view === 'data' ? (
              <div className="grid gap-4">
                <div className="card">
                  <div className="text-xs tracking-wider uppercase opacity-70">Troubleshooting</div>
                  <div className="text-lg font-semibold mt-1">Clear offline cache</div>
                  <div className="text-sm opacity-80 mt-1">If something feels stuck, clear local storage and reload.</div>
                  <div className="flex gap-2 flex-wrap mt-3">
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        try {
                          // IndexedDB
                          await new Promise<void>((resolve, reject) => {
                            const req = indexedDB.deleteDatabase('spectatore');
                            req.onsuccess = () => resolve();
                            req.onerror = () => reject(req.error);
                            req.onblocked = () => resolve();
                          });
                          // localStorage (token is managed separately)
                          setMsg('Offline cache cleared. Refreshing…');
                          setTimeout(() => window.location.reload(), 250);
                        } catch (e: any) {
                          console.error(e);
                          setMsg('Failed to clear cache');
                        }
                      }}
                    >
                      Clear cache & reload
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => {
                        setMsg('Refreshing…');
                        setTimeout(() => window.location.reload(), 150);
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}

        <div className="card mt-4">
          <div className="text-xs tracking-wider uppercase opacity-70">Legal</div>
          <div className="text-lg font-semibold mt-1">Terms & privacy</div>
          <div className="text-sm opacity-80 mt-1">Review Spectatore’s terms and privacy documents.</div>
          <div className="flex gap-2 flex-wrap mt-3">
            <button type="button" className="btn btn-outline" onClick={() => nav('/Terms')}>Terms &amp; Conditions</button>
            <button type="button" className="btn btn-outline" onClick={() => nav('/Privacy')}>Privacy &amp; Data Use</button>
          </div>
        </div>
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

              <div className="text-xs opacity-70">
                Requests are sent as <b>member</b>. Site admins can promote you to validator/admin after approval.
              </div>

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    setShowAddSite(false);
                    setJoinSiteId(0);
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="btn" onClick={beginJoinFlow} disabled={!joinSiteId}>
                  Request access
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {siteConsent ? (
        <div className="fixed inset-0 z-[1001] flex items-start justify-center bg-black/60 overflow-auto pt-6 pb-24">
          <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-xl w-full max-w-2xl mx-4 p-5">
            <div className="text-lg font-semibold">Site data consent</div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mt-1">
              You&apos;re requesting access to <b>{siteConsent.site}</b> as a <b>member</b>. Before we send the request,
              please review how site-linked data is shared.
            </div>

            <div
              ref={siteConsentBoxRef}
              className="mt-4 border rounded-2xl p-4 bg-slate-50 dark:bg-slate-800/40"
              style={{ maxHeight: 320, overflowY: 'auto' }}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 6) setSiteConsentScrolled(true);
              }}
            >
              <div className="space-y-3 text-sm text-slate-800 dark:text-slate-200">
                <div className="font-semibold">What changes when you join a site</div>
                <ul className="list-disc pl-5 space-y-2">
                  <li>
                    Your <b>validated</b> shift data for that site may be visible to site admins/validators for reporting, reconciliation,
                    and Power BI dashboards.
                  </li>
                  <li>
                    Your personal (non-site) data remains available in personal mode, but site-linked lists (equipment/locations) may be
                    available when the active site is selected.
                  </li>
                  <li>
                    You should only record/submit information you are authorised to share under your employer/site policies.
                  </li>
                  <li>You can leave a site at any time from Settings.</li>
                </ul>
                <div className="text-xs opacity-70 pt-2">Scroll to the bottom to enable consent.</div>
              </div>
            </div>

            <label className="flex gap-3 items-start text-sm mt-4">
              <input
                type="checkbox"
                className="mt-1"
                checked={siteConsentTick}
                onChange={(e) => setSiteConsentTick(e.target.checked)}
              />
              <span>
                I understand and consent to site-linked data visibility for <b>{siteConsent.site}</b>.
              </span>
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setSiteConsent(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!siteConsentTick || !siteConsentScrolled}
                onClick={async () => {
                  const c = siteConsent;
                  if (!c) return;
                  await requestJoinWithConsent(c.site_id, 'v1');
                  setSiteConsent(null);
                }}
              >
                Confirm &amp; send request
              </button>
            </div>
          </div>
        </div>
      ) : null}


      {confirmLeave ? (
        <div className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 overflow-auto pt-6 pb-24">
          <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-xl w-full max-w-md mx-4 p-4">
            <div className="font-semibold text-lg mb-2">Leave site?</div>
            <div className="text-sm text-slate-700 dark:text-slate-300 mb-4">
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
