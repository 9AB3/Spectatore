import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getDB } from '../lib/idb';

function SyncIndicator() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const acts = await db.getAll('activities');
      setPending(acts.length);
    })();
  }, []);
  const cls = !online ? 'sync-bad' : pending > 0 ? 'sync-warn' : 'sync-ok';
  const label = !online ? 'Offline' : pending > 0 ? `Pending sync (${pending})` : 'Synced';
  return <span title={label} className={`sync-dot ${cls}`}></span>;
}

export default function Header() {
  const [shift, setShift] = useState<{ date?: string; dn?: 'DS' | 'NS' }>({});
  const loc = useLocation();
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const s = await db.get('shift', 'current');
      setShift(s || {});
    })();
  }, []);

  function fmt(dateIso?: string) {
    if (!dateIso) return '';
    const d = new Date(dateIso + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }

  // Only show date on pages beyond Shift (i.e., not Home/Main/Shift)
  const hideDate = !['/Activity', '/ViewActivities', '/FinalizeShift', '/Shift'].includes(
    loc.pathname,
  );

  return (
    <div className="header-bar">
      <div className="logo-title text-xl">Spectatore</div>
      <div className="flex items-center gap-3 text-sm text-slate-700">
        {!hideDate && shift?.date && shift?.dn && (
          <div>
            {fmt(shift.date)} • {shift.dn}
          </div>
        )}
        <SyncIndicator />
      </div>
    </div>
  );
}
