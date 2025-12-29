import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type AdminSite = { id: number; name: string; state?: string | null };

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

export default function SiteAdminSites() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [superAdmin, setSuperAdmin] = useState(false);

  const [sites, setSites] = useState<AdminSite[]>([]);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [state, setState] = useState('NSW');
  const [saving, setSaving] = useState(false);

  const sorted = useMemo(
    () => [...sites].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [sites],
  );

  async function loadSites() {
    setLoading(true);
    try {
      const res: any = await api('/api/site-admin/admin-sites');
      if (!res?.ok) throw new Error(res?.error || 'Failed to load sites');
      setSites(res.sites || []);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load sites');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      // Determine super-admin capability from server (supports both:
      //  - dedicated Admin/Password site_admin token
      //  - normal user token where users.is_admin=true)
      try {
        const me: any = await api('/api/site-admin/me');
        const isSuper = !!me?.is_super || (Array.isArray(me?.sites) && me.sites.includes('*'));
        setSuperAdmin(isSuper);
        if (!isSuper) {
          // Regular site admins/validators are not allowed to manage the global site list
          nav('/SiteAdmin');
          return;
        }
        loadSites();
        return;
      } catch {
        // fall through
      }

      // If we can't confirm super-admin, bounce to menu
      nav('/SiteAdmin');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    const n = name.trim();
    if (!n) return setMsg('Please enter a site name');
    setSaving(true);
    try {
      const res: any = await api('/api/site-admin/admin-sites', {
        method: 'POST',
        body: JSON.stringify({ name: n, state }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to create site');
      setMsg('Site created');
      setName('');
      await loadSites();
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create site');
    } finally {
      setSaving(false);
    }
  }

  async function removeSite(siteName: string) {
    const ok = window.confirm(
      `Delete site "${siteName}"?\n\n` +
        `This will:\n` +
        `• Remove the site from the Sites list\n` +
        `• Delete ALL shift data for this site\n` +
        `• Delete the site's admin equipment/locations\n` +
        `• Move any users currently on this site back to 'default'\n\n` +
        `This cannot be undone.`
    );
    if (!ok) return;
    try {
      const res: any = await api('/api/site-admin/admin-sites', {
        method: 'DELETE',
        body: JSON.stringify({ name: siteName, force: true }),
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed to delete site');
      setMsg('Site deleted');
      await loadSites();
    } catch (e: any) {
      // If server returns a structured in-use error (when force not set), show a friendly message.
      if (String(e?.message || '').includes('site_in_use')) {
        setMsg('Site is in use and cannot be deleted without force');
      } else {
        setMsg(e?.message || 'Failed to delete site');
      }
    }
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Toast />
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <img src="/logo.png" alt="Spectatore" className="w-12 h-12 object-contain" />
          <div>
            <div className="text-xl font-semibold">Sites</div>
            <div className="text-sm opacity-70">Create a site and view all sites in the admin list.</div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* Create */}
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-3">Create site</div>

            <div className="space-y-3">
              <div>
                <div className="text-xs opacity-70 mb-1">New Site Name</div>
                <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div>
                <div className="text-xs opacity-70 mb-1">State</div>
                <select className="input w-full" value={state} onChange={(e) => setState(e.target.value)}>
                  <option>NSW</option>
                  <option>QLD</option>
                  <option>VIC</option>
                  <option>WA</option>
                  <option>SA</option>
                  <option>TAS</option>
                  <option>NT</option>
                  <option>ACT</option>
                </select>
              </div>

              <button className="btn w-full" onClick={submit} disabled={saving}>
                {saving ? 'Saving…' : 'Create Site'}
              </button>
              <div className="text-[11px] opacity-60">
                Tip: If you create a new site, the list on the right updates immediately.
              </div>
            </div>
          </div>

          {/* List */}
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-semibold">All sites</div>
              <button className="btn" onClick={loadSites} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {sorted.length === 0 ? (
              <div className="text-sm opacity-70">No sites yet.</div>
            ) : (
              <div className="space-y-2">
                {sorted.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-xl px-3 py-2"
                    style={{ background: 'rgba(0,0,0,0.04)' }}
                  >
                    <div>
                      <div className="font-semibold">{s.name}</div>
                      <div className="text-xs opacity-70">{s.state || '-'}</div>
                    </div>
                    <button className="btn" onClick={() => removeSite(s.name)}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
