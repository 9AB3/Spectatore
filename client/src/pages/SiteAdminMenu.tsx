import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';

function Card({ children }: { children: any }) {
  return <div className="card w-full max-w-sm text-center">{children}</div>;
}

export default function SiteAdminMenu() {
  const nav = useNavigate();
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'site_admin');
      setUsername(session?.name || session?.email || '');
    })();
  }, []);

  async function logout() {
    const db = await getDB();
    await db.delete('session', 'site_admin');
    nav('/SiteAdminLogin');
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <Card>
        <img src="/logo.png" alt="Spectatore" className="mx-auto mb-4 w-48 h-48 object-contain" />
        <div className="text-sm opacity-80 mb-4">{username}</div>
        <div className="space-y-3">
          <button className="btn w-full" onClick={() => nav('/SiteAdmin/Validate')}>
            Validate Data
          </button>
          <button className="btn w-full" onClick={() => nav('/SiteAdmin/Equipment&Locations')}>
            Locations &amp; Equipment
          </button>
          <button className="btn w-full" onClick={() => nav('/SiteAdmin/Edit')}>
            Edit Data
          </button>
          <button className="btn w-full" onClick={() => nav('/SiteAdmin/Export')}>
            Export Data
          </button>
          <div className="text-xs text-sky-600 cursor-pointer" onClick={logout}>
            Logout
          </div>
        </div>
      </Card>
    </div>
  );
}
