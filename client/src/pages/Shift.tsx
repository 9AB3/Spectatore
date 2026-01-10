import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';

type ShiftMeta = {
  date?: string;
  dn?: string;
};

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function TileButton({
  title,
  subtitle,
  tone,
  onClick,
  icon,
}: {
  title: string;
  subtitle: string;
  tone: 'brand' | 'neutral' | 'danger';
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const toneClass =
    tone === 'brand'
      ? 'border-white/10'
      : tone === 'danger'
        ? 'border-red-500/30'
        : 'border-white/10';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'tv-tile text-left w-[78vw] sm:w-[360px] md:w-auto md:min-h-[132px]',
        'transition-all active:translate-y-[1px]',
        toneClass,
      )}
      style={{
        background:
          tone === 'brand'
            ? 'linear-gradient(180deg, rgba(10, 132, 255, 0.18), rgba(0,0,0,0.10))'
            : tone === 'danger'
              ? 'linear-gradient(180deg, rgba(255, 69, 58, 0.12), rgba(0,0,0,0.10))'
              : 'linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0.10))',
      }}
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-2xl flex items-center justify-center border" style={{ borderColor: 'var(--hairline)', background: 'rgba(255,255,255,0.06)' }}>
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-lg font-extrabold tracking-tight">{title}</div>
          <div className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {subtitle}
          </div>
        </div>
      </div>
    </button>
  );
}

function IconPlus(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function IconList(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function IconLock(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M7 11V8a5 5 0 0 1 10 0v3" />
      <path d="M6 11h12v10H6z" />
    </svg>
  );
}

function IconTrash(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 16h10l1-16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export default function Shift() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [abortOpen, setAbortOpen] = useState(false);
  const [meta, setMeta] = useState<ShiftMeta>({});

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const ls = localStorage.getItem('spectatore-shift');
      if (ls) {
        const data = JSON.parse(ls);
        await db.put('shift', { date: data.date, dn: data.dn }, 'current');
        setMeta({ date: data.date, dn: data.dn });
      }
      setLoaded(true);
    })();
  }, []);

  const shiftLabel = useMemo(() => {
    const dn = meta.dn ? String(meta.dn).toUpperCase() : '';
    const date = meta.date ? String(meta.date) : '';
    if (dn && date) return `${dn} • ${date}`;
    return dn || date || '';
  }, [meta]);

  function handleFinalize() {
    if (!navigator.onLine) {
      setMsg('Offline - please connect to network and try again');
      return;
    }
    nav('/FinalizeShift');
  }

  async function cancelShift() {
    // UI modal confirmation (matches the Start Shift modal pattern)
    setAbortOpen(true);
  }

  async function confirmAbort() {
    setAbortOpen(false);

    try {
      const db = await getDB();

      // Clear activities for current local device (since activities aren't tagged by shift yet)
      const tx = db.transaction('activities', 'readwrite');
      const store = tx.objectStore('activities');
      const all = await store.getAll();
      for (const row of all) {
        await store.delete(row.id);
      }
      await tx.done;

      // Clear shift state
      await db.delete('shift', 'current');
      localStorage.removeItem('spectatore-shift');

      setMsg('Shift cancelled');
      // Keep toast visible for at least 2s before route change
      setTimeout(() => nav('/Main'), 2000);
    } catch (e) {
      console.error(e);
      setMsg('Failed to cancel shift');
    }
  }

  if (!loaded) return null;

  return (
    <div>
      <Toast />
      <Header />

      <div className="p-4 max-w-5xl mx-auto space-y-5 pb-24">
        {/* Hero */}
        <div className="tv-tile">
          <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
            Shift Portal
          </div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight">Log activities</div>
          <div className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
            Create, review, and finalize your shift data.
          </div>
          {shiftLabel ? (
            <div className="mt-4 inline-flex items-center gap-2 rounded-2xl px-3 py-2 border" style={{ borderColor: 'var(--hairline)', background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-2 w-2 rounded-full" style={{ background: 'var(--brand)' }} />
              <div className="text-sm font-semibold">{shiftLabel}</div>
            </div>
          ) : null}
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-lg font-extrabold tracking-tight">Continue Working</div>
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              Tap a tile
            </div>
          </div>

          {/* Mobile: horizontal row */}
          <div className="md:hidden tv-row">
            <TileButton
              title="New Activity"
              subtitle="Add a task for this shift"
              tone="brand"
              onClick={() => nav('/Activity')}
              icon={<IconPlus className="h-6 w-6" />}
            />
            <TileButton
              title="View Activity"
              subtitle="Review and edit entries"
              tone="neutral"
              onClick={() => nav('/ViewActivities')}
              icon={<IconList className="h-6 w-6" />}
            />
            <TileButton
              title="Finalize Shift"
              subtitle="Save to backend & lock in totals"
              tone="brand"
              onClick={handleFinalize}
              icon={<IconLock className="h-6 w-6" />}
            />
            <TileButton
              title="Cancel Shift"
              subtitle="Discard local data"
              tone="danger"
              onClick={cancelShift}
              icon={<IconTrash className="h-6 w-6" />}
            />
          </div>

          {/* Desktop: grid */}
          <div className="hidden md:grid grid-cols-2 gap-4">
            <TileButton
              title="New Activity"
              subtitle="Add a task for this shift"
              tone="brand"
              onClick={() => nav('/Activity')}
              icon={<IconPlus className="h-6 w-6" />}
            />
            <TileButton
              title="View Activity"
              subtitle="Review and edit entries"
              tone="neutral"
              onClick={() => nav('/ViewActivities')}
              icon={<IconList className="h-6 w-6" />}
            />
            <TileButton
              title="Finalize Shift"
              subtitle="Save to backend & lock in totals"
              tone="brand"
              onClick={handleFinalize}
              icon={<IconLock className="h-6 w-6" />}
            />
            <TileButton
              title="Cancel Shift"
              subtitle="Discard local data"
              tone="danger"
              onClick={cancelShift}
              icon={<IconTrash className="h-6 w-6" />}
            />
          </div>
        </div>

        {abortOpen && (
          <div className="fixed inset-0 z-[1200] bg-black/60 flex items-center justify-center p-4">
            <div className="tv-tile w-full max-w-sm">
              <div className="text-xs font-bold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
                Confirm
              </div>
              <h3 className="text-xl font-extrabold mt-1">Abort shift</h3>
              <div className="mt-3" style={{ color: 'var(--muted)' }}>
                Abort shift — shift data will be lost.
              </div>

              <div className="flex gap-2 mt-5">
                <button className="btn btn-primary flex-1" onClick={confirmAbort}>
                  Yes
                </button>
                <button className="btn btn-secondary flex-1" onClick={() => setAbortOpen(false)}>
                  No
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
