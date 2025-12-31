import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';

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

export default function Header({ showSync = true, showBell = true }: { showSync?: boolean; showBell?: boolean }) {
  const [shift, setShift] = useState<{ date?: string; dn?: 'DS' | 'NS' }>({});
  const [unread, setUnread] = useState<number>(0);
  const loc = useLocation();
  const nav = useNavigate();

  const path = (loc.pathname || '').toLowerCase();
  const isSiteAdminArea = path.startsWith('/siteadmin');
  const isSiteAdminLogin = path.startsWith('/siteadminlogin');
  // Hide the bell inside the SiteAdmin area (except on the login page)
  const canShowBell = showBell && !(isSiteAdminArea && !isSiteAdminLogin);
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

  // Poll unread notification count while authed
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api('/api/notifications/unread-count');
        if (alive) setUnread(Number(r?.count || 0));
      } catch {
        if (alive) setUnread(0);
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    const on = () => tick();
    window.addEventListener('focus', on);
    window.addEventListener('spectatore:notifications', on as any);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', on);
      window.removeEventListener('spectatore:notifications', on as any);
    };
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
      <div className="flex items-center gap-3 min-w-0">
        <img src="/logo.png" alt="Spectatore" className="w-10 h-10 object-contain flex-shrink-0" />
        <div className="min-w-0">
          <div className="logo-title text-xl truncate">Spectatore</div>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm text-slate-700 flex-shrink-0">
        {canShowBell ? (
          <button
            type="button"
            className="relative w-10 h-10 rounded-full border flex items-center justify-center hover:bg-slate-50"
            style={{ borderColor: '#e9d9c3' }}
            onClick={() => nav('/Notifications')}
            aria-label="Notifications"
            title="Notifications"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {unread > 0 ? (
              <span
                className="absolute -top-1 -right-1 text-[10px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center"
                style={{ background: '#b00020', color: 'white' }}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </button>
        ) : null}


        {!hideDate && shift?.date && shift?.dn && (
          <div>
            {fmt(shift.date)} • {shift.dn}
          </div>
        )}
        {showSync ? <SyncIndicator /> : null}
      </div>
    </div>
  );
}
