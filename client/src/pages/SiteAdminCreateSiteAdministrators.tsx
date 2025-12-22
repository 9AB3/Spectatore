import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type AdminSite = { id: number; name: string; state?: string | null };

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-md text-center">{children}</div>;
}

export default function SiteAdminCreateSiteAdministrators() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [sites, setSites] = useState<AdminSite[]>([]);
  const [site, setSite] = useState('');
  const [siteTyped, setSiteTyped] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const allSiteNames = useMemo(() => sites.map((s) => s.name), [sites]);

  useEffect(() => {
    (async () => {
      try {
        const res: any = await api('/api/site-admin/admin-sites');
        if (!res?.ok) throw new Error(res?.error || 'Failed to load sites');
        setSites(res.sites || []);
        // default to first site if available
        const first = (res.sites || [])[0]?.name || '';
        setSite(first);
        setSiteTyped(first);
      } catch (e: any) {
        setMsg(e?.message || 'Failed to load sites');
      }
    })();
  }, []);

  async function submit() {
    const nm = name.trim();
    const em = email.trim().toLowerCase();
    const s = (siteTyped || site).trim();

    if (!nm || !em || !password || !confirm || !s) return setMsg('Please complete all required fields');
    if (password !== confirm) return setMsg('Passwords do not match');

    // Ensure the typed site is one of admin_sites (this page references admin_sites only)
    if (!allSiteNames.includes(s)) {
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
      // After creating, send to the restricted menu (no create-site-admin button)
      nav('/SiteAdmin/Menu');
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create site administrator');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Toast />
      <Card>
        <div className="text-xl font-semibold mb-2">Create Site Administrators</div>
        <div className="text-sm opacity-70 mb-6">Create a Site Admin account for an existing site.</div>

        <div className="text-left space-y-4">
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
            {/* Datalist = dropdown that also allows typing, but we enforce it must match admin_sites */}
            <input
              className="input w-full"
              list="admin-sites"
              value={siteTyped}
              onChange={(e) => {
                const v = e.target.value;
                setSiteTyped(v);
                setSite(v);
              }}
              placeholder={sites.length ? 'Select site…' : 'No sites yet'}
            />
            <datalist id="admin-sites">
              {sites.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
            <div className="text-[11px] opacity-60 mt-1">
              If the site isn’t listed, create it first using “Create New Site”.
            </div>
          </div>

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

          <div className="grid grid-cols-2 gap-3 pt-2">
            <button className="btn w-full" onClick={() => nav('/SiteAdmin')} disabled={saving}>
              Back
            </button>
            <button className="btn w-full" onClick={submit} disabled={saving}>
              {saving ? 'Creating…' : 'Create Admin'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
