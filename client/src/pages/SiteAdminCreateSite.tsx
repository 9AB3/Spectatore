import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-md text-center">{children}</div>;
}

export default function SiteAdminCreateSite() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [name, setName] = useState('');
  const [state, setState] = useState('NSW');
  const [saving, setSaving] = useState(false);

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
    } catch (e: any) {
      setMsg(e?.message || 'Failed to create site');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Toast />
      <Card>
        <div className="text-xl font-semibold mb-2">Create New Site</div>
        <div className="text-sm opacity-70 mb-6">Add a site to the Site Admin list.</div>

        <div className="text-left space-y-4">
          <div>
            <div className="text-xs opacity-70 mb-1">New Site Name</div>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <div className="text-xs opacity-70 mb-1">New Site Location</div>
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

          <div className="grid grid-cols-2 gap-3 pt-2">
            <button className="btn w-full" onClick={() => nav('/SiteAdmin')} disabled={saving}>
              Back
            </button>
            <button className="btn w-full" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : 'Create Site'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
