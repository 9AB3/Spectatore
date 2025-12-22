import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-2xl">{children}</div>;
}

export default function SiteAdmin() {
  const nav = useNavigate();
  const [label, setLabel] = useState<string>('');
  const [mode, setMode] = useState<'site_admin' | 'auth'>('site_admin');
  const [superAdmin, setSuperAdmin] = useState(false);

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const sa = await db.get('session', 'site_admin');
      if (sa?.token) {
        setMode('site_admin');
        setLabel(sa?.username || 'Site Admin');
        setSuperAdmin(!!sa?.super_admin || (Array.isArray(sa?.sites) && sa.sites.includes('*')));
        return;
      }
      const auth = await db.get('session', 'auth');
      setMode('auth');
      setLabel(auth?.user_id ? `Admin` : 'Admin');
      setSuperAdmin(false);
    })();
  }, []);

  async function logout() {
    const db = await getDB();
    if (mode === 'site_admin') {
      await db.delete('session', 'site_admin');
      nav('/SiteAdminLogin');
    } else {
      // Auth admins generally want to return to the normal app; logout stays in Home.
      await db.delete('session', 'auth');
      nav('/Home');
    }
  }

  return (
    <div className="min-h-screen flex items-start justify-center p-4">
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <img src="/logo.png" alt="Spectatore" className="w-14 h-14 object-contain" />
          <div className="flex-1">
            <div className="text-xl font-semibold">Site Admin</div>
            <div className="text-sm opacity-70">{label || 'Admin tools'}</div>
          </div>
          <button className="btn" onClick={logout}>
            Logout
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-2">Validation</div>
            <div className="text-sm opacity-70 mb-3">
              Review finalized shifts, make edits, and validate daily totals.
            </div>
            <button className="btn w-full" onClick={() => nav('/SiteAdmin/Validate')}>
              Go to Validate
            </button>
          </div>

          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-2">Master lists</div>
            <div className="text-sm opacity-70 mb-3">
              Manage site equipment + location lists used in validation dropdowns.
            </div>
            <button className="btn w-full" onClick={() => nav('/SiteAdmin/Equipment&Locations')}>
              Locations & Equipment
            </button>
          </div>

          {superAdmin && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Sites</div>
              <div className="text-sm opacity-70 mb-3">Create sites and view the admin site list.</div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/Sites')}>
                Manage Sites
              </button>
            </div>
          )}

          {superAdmin && (
            <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
              <div className="font-semibold mb-2">Feedback</div>
              <div className="text-sm opacity-70 mb-3">Approve or decline user-submitted feedback.</div>
              <button className="btn w-full" onClick={() => nav('/SiteAdmin/ApproveFeedback')}>
                Approve Feedback
              </button>
            </div>
          )}

          <div className="p-4 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="font-semibold mb-2">Site admins</div>
            <div className="text-sm opacity-70 mb-3">
              Create and remove site admin accounts{superAdmin ? ' (any site).' : ' (your site only).'}
            </div>
            <button className="btn w-full" onClick={() => nav('/SiteAdmin/SiteAdmins')}>
              Manage Site Admins
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
