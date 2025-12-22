import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type AdminSite = { id: number; name: string; state?: string | null };
type SiteAdminRow = { id: number; name: string; email: string; site: string };

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

function Tabs({ value, onChange }: { value: 'create' | 'list'; onChange: (v: 'create' | 'list') => void }) {
  const b = (v: 'create' | 'list') =>
    value === v
      ? 'px-3 py-2 rounded-xl font-semibold bg-[rgba(0,0,0,0.06)]'
      : 'px-3 py-2 rounded-xl opacity-70';
  return (
    <div className="flex gap-2">
      <button className={b('create')} onClick={() => onChange('create')}>
        Create Admin
      </button>
      <button className={b('list')} onClick={() => onChange('list')}>
        Site Admins
      </button>
    </div>
  );
}

export default function SiteAdminSiteAdmins() {
  const { setMsg, Toast } = useToast();

  const [tab, setTab] = useState<'create' | 'list'>('create');

  const [sites, setSites] = useState<AdminSite[]>([]);
  const [siteTyped, setSiteTyped] = useState('');
  const [isSuper, setIsSuper] = useState(false);
  const [scopedSite, setScopedSite] = useState<string>('');

  const [admins, setAdmins] = useState<SiteAdminRow[]>([]);
  const [loadingAdmins, setLoadingAdmins] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const allSiteNames = useMemo(() => sites.map((s) => s.name), [sites]);

  async function loadScope() {
    try {
      const res: any = await api('/api/site-admin/me');
      if (!res?.ok) return;
      const sitesFromToken: string[] = Array.isArray(res.sites) ? res.sites : [];
      const superFlag = !!res.is_super || sitesFromToken.includes('*');
      setIsSuper(superFlag);
      if (!superFlag) {
        const ss = sitesFromToken.find((x) => x && x !== '*') || '';
        setScopedSite(ss);
        if (ss) setSiteTyped(ss);
      }
    } catch {
      // ignore; UI will still work with sites list if available
    }
  }

  async function loadSites() {
    try {
      const res: any = await api('/api/site-admin/admin-sites');
      if (!res?.ok) throw new Error(res?.error || 'Failed to load sites');
      setSites(res.sites || []);
      const first = (res.sites || [])[0]?.name || '';
      setSiteTyped((prev) => prev || first);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load sites');
    }
  }

  async function loadAdmins() {
    setLoadingAdmins(true);
    try {
      const res: any = await api('/api/site-admin/site-admins');
      if (!res?.ok) throw new Error(res?.error || 'Failed to load admins');
      setAdmins(res.admins || []);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load admins');
    } finally {
      setLoadingAdmins(false);
    }
  }

  useEffect(() => {
    loadScope();
    loadSites();
    loadAdmins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    const nm = name.trim();
    const em = email.trim().toLowerCase();
    const s = (isSuper ? siteTyped : (scopedSite || siteTyped)).trim();

    if (!nm || !em || !password || !confirm || !s) return setMsg('Please complete all required fields');
    if (password !== confirm) return setMsg('Passwords do not match');
    if (isSuper && !allSiteNames.includes(s)) {
      return setMsg('Please choose a site from the list (create the site first if missing)');
    }

    setSaving(true);
    try {
      const res: any = await api('/api/site-admin/create-site-admin', {
        method: 'POST',
        body: JSON.stringify({ name: nm, email: em, password, site: s }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to create site administrator');
      setMsg('Site administrator created');
      setName('');
      setEmail('');
      setPassword('');
      setConfirm('');
      setTab('list');
      await loadAdmins();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create site administrator');
    } finally {
      setSaving(false);
    }
  }

  async function removeAdmin(row: SiteAdminRow) {
    const ok = window.confirm(`Delete site admin ${row.name} (${row.email})?\n\nThis will remove their account and any saved data.`);
    if (!ok) return;
    try {
      const res: any = await api('/api/site-admin/site-admins', {
        method: 'DELETE',
        body: JSON.stringify({ id: row.id }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to delete admin');
      setMsg('Admin deleted');
      await loadAdmins();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to delete admin');
    }
  }

  const sortedAdmins = useMemo(
    () => [...admins].sort((a, b) => (a.site || '').localeCompare(b.site || '') || (a.name || '').localeCompare(b.name || '')),
    [admins],
  );

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Toast />
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <img src="/logo.png" alt="Spectatore" className="w-12 h-12 object-contain" />
          <div className="flex-1">
            <div className="text-xl font-semibold">Site Admins</div>
            <div className="text-sm opacity-70">Create site admins, or view & delete existing admins.</div>
          </div>
          <Tabs value={tab} onChange={setTab} />
        </div>

        {tab === 'create' ? (
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-3">Create admin</div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <div className="text-xs opacity-70 mb-1">Full Name</div>
                  <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <div className="text-xs opacity-70 mb-1">Email</div>
                  <input className="input w-full" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <div className="text-xs opacity-70 mb-1">Site</div>
                  {isSuper ? (
                    <>
                      <input
                        className="input w-full"
                        list="admin-sites"
                        value={siteTyped}
                        onChange={(e) => setSiteTyped(e.target.value)}
                        placeholder={sites.length ? 'Select site…' : 'No sites yet'}
                      />
                      <datalist id="admin-sites">
                        {sites.map((s) => (
                          <option key={s.id} value={s.name} />
                        ))}
                      </datalist>
                      <div className="text-[11px] opacity-60 mt-1">
                        If the site isn’t listed, create it first in “Sites”.
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        className="input w-full opacity-70"
                        value={scopedSite || siteTyped || 'Your site'}
                        disabled
                        title="You can only create admins for your own site"
                      />
                      <div className="text-[11px] opacity-60 mt-1">
                        You can only create admins for your assigned site.
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="text-xs opacity-70 mb-1">Password</div>
                  <input
                    className="input w-full"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div>
                  <div className="text-xs opacity-70 mb-1">Confirm Password</div>
                  <input
                    className="input w-full"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                <button className="btn w-full" onClick={submit} disabled={saving}>
                  {saving ? 'Creating…' : 'Create Admin'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-semibold">All site admins</div>
              <button className="btn" onClick={loadAdmins} disabled={loadingAdmins}>
                {loadingAdmins ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {sortedAdmins.length === 0 ? (
              <div className="text-sm opacity-70">No site admins found.</div>
            ) : (
              <div className="space-y-2">
                {sortedAdmins.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-xl px-3 py-2"
                    style={{ background: 'rgba(0,0,0,0.04)' }}
                  >
                    <div>
                      <div className="font-semibold">{a.name}</div>
                      <div className="text-xs opacity-70">{a.email} • {a.site}</div>
                    </div>
                    <button className="btn" onClick={() => removeAdmin(a)}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
