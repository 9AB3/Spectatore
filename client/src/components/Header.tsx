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
  // Refresh pending count periodically (keeps indicator accurate while user logs activities)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const db = await getDB();
        const acts = await db.getAll('activities');
        if (alive) setPending(acts.length);
      } catch {
        // ignore
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const syncedOn = online && pending === 0;
  const pendingOn = pending > 0;
  const offlineOn = !online;

  // Three lights always visible
return (
  <div className="sync-inline" aria-label="Sync status">
    <div className="sync-item">
      <span
        title={syncedOn ? 'Synced' : 'Synced (not active)'}
        className={`sync-dot sync-ok ${syncedOn ? '' : 'sync-off'}`}
      />
      <span className="sync-text">Synced</span>
    </div>

    <div className="sync-item">
      <span
        title={pendingOn ? `Pending Sync (${pending})` : 'Pending Sync (0)'}
        className={`sync-dot sync-warn ${pendingOn ? '' : 'sync-off'}`}
      />
      <span className="sync-text">Pending Sync</span>
    </div>

    <div className="sync-item">
      <span
        title={offlineOn ? 'Offline' : 'Offline (not active)'}
        className={`sync-dot sync-bad ${offlineOn ? '' : 'sync-off'}`}
      />
      <span className="sync-text">Offline</span>
    </div>
  </div>
);

}

export default function Header() {
  const [shift, setShift] = useState<{ date?: string; dn?: 'DS' | 'NS' }>({});
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const db = await getDB();
        const s = await db.get('shift', 'current');
        if (alive) setShift(s || {});
      } catch {
        if (alive) setShift({});
      }
    };

    // initial + whenever route changes
    load();

    // allow pages to force-refresh the shift display (e.g. FinalizeShift change date/shift)
    const onShift = () => load();
    window.addEventListener('spectatore:shift', onShift as any);
    return () => {
      alive = false;
      window.removeEventListener('spectatore:shift', onShift as any);
    };
  }, [loc.pathname]);

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
