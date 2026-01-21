import Header from '../components/Header';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { useEffect, useState } from 'react';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';



function FeedbackIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 8h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 12h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((v) => parseInt(v, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function Main() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dn, setDn] = useState<'DS' | 'NS'>('DS');
  const [isAdmin, setIsAdmin] = useState(false);
  const [datesWithData, setDatesWithData] = useState<Set<string>>(() => new Set());
  const [dupeOpen, setDupeOpen] = useState<boolean>(false);
  const [dupeInfo, setDupeInfo] = useState<any>(null);

  async function tagOut() {
    try {
      const db = await getDB();
      // Clear any stored auth session so Home won't auto-redirect back to /Main
      await db.delete('session', 'auth');
    } catch {
      // ignore local delete errors
    }
    setMsg('Tagged out');
    // Keep toast visible for at least 2s before route change
    setTimeout(() => nav('/Home'), 2000);
  }

  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        setIsAdmin(!!session?.is_admin);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api('/api/shifts/dates-with-data');
        const arr = (res?.dates || []) as string[];
        if (!cancelled) {
          setDatesWithData(new Set(arr));
        }
      } catch (e) {
        console.error('Failed to load dates-with-data for start shift', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirmShift() {
    // If the selected date already has data, confirm intent first.
    if (datesWithData.has(date)) {
      try {
        const existing: any = await api(`/api/shifts/by-date?date=${encodeURIComponent(date)}`);
        setDupeInfo(existing);
      } catch {
        setDupeInfo({ ok: false });
      }
      setDupeOpen(true);
      return;
    }

    // Save to localStorage (for legacy) and to IndexedDB
    localStorage.setItem('spectatore-shift', JSON.stringify({ date, dn }));
    const db = await getDB();
    await db.put('shift', { date, dn }, 'current');
    setMsg('Entering portal');
    setOpen(false);
    // Keep toast visible for at least 2s before route change
    setTimeout(() => nav('/Shift'), 2000);
  }

  async function startFreshReplace() {
    const db = await getDB();
    const all = (await db.getAll('activities')) as any[];
    // Drop any local cached activities that match this shift (date+dn)
    const toDel = (all || []).filter((a) => a?.shiftDate === date && a?.dn === dn && typeof a?.id === 'number');
    for (const it of toDel) await db.delete('activities', it.id);
    localStorage.setItem('spectatore-shift', JSON.stringify({ date, dn }));
    await db.put('shift', { date, dn }, 'current');
    setMsg('Starting fresh');
    setDupeOpen(false);
    setOpen(false);
    setTimeout(() => nav('/Shift'), 600);
  }

  async function loadExistingAndAdd() {
    try {
      const details: any = await api(`/api/shifts/details?date=${encodeURIComponent(date)}&dn=${encodeURIComponent(dn)}`);
      const db = await getDB();

      // Clear local cache for this shift
      const all = (await db.getAll('activities')) as any[];
      const toDel = (all || []).filter((a) => a?.shiftDate === date && a?.dn === dn && typeof a?.id === 'number');
      for (const it of toDel) await db.delete('activities', it.id);

      // Set current shift and seed activities
      localStorage.setItem('spectatore-shift', JSON.stringify({ date, dn }));
      await db.put('shift', { date, dn }, 'current');

      const acts = Array.isArray(details?.activities) ? details.activities : [];
      for (const a of acts) {
        const payload = a?.payload_json || a?.payload || {};
        await db.add('activities', {
          payload,
          shiftDate: date,
          dn,
          ts: Date.now(),
        });
      }
      setMsg('Loaded existing shift');
    } catch (e) {
      console.error('Failed to load existing shift', e);
      setMsg('Could not load existing shift');
    }

    setDupeOpen(false);
    setOpen(false);
    setTimeout(() => nav('/Shift'), 700);
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-4 max-w-5xl mx-auto space-y-5">
        <div className="card">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Home</div>
          <div className="text-3xl md:text-4xl font-extrabold tracking-tight">Shift Portal</div>
          <div className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Start a new shift, review validation, or manage your account.
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Continue Working</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>Tap a tile</div>
          </div>

          <div className="tv-row">
            <button
              type="button"
              className="tv-tile min-w-[260px] w-[260px] md:w-[320px] text-left transition-transform"
              onClick={() => setOpen(true)}
            >
              <div className="relative flex items-center justify-center h-full">
                <span
                  className="absolute top-3 left-3 text-[11px] font-bold tracking-wide uppercase opacity-80"
                  style={{ color: 'var(--muted)' }}
                >
                  Start shift
                </span>
                <img
                  src={`${import.meta.env.BASE_URL}start-shift.png`}
                  alt=""
                  className="h-[200px] md:h-[240px] w-full object-contain select-none pointer-events-none"
                  draggable={false}
                />
              </div>

            </button>

            <button
              type="button"
              className="tv-tile min-w-[260px] w-[260px] md:w-[320px] text-left transition-transform"
              onClick={tagOut}
            >
              <div className="relative flex items-center justify-center h-full">
                <span
                  className="absolute top-3 left-3 text-[11px] font-bold tracking-wide uppercase opacity-80"
                  style={{ color: 'var(--muted)' }}
                >
                  Tag out
                </span>
                <img
                  src={`${import.meta.env.BASE_URL}tag-out.png`}
                  alt=""
                  className="h-[200px] md:h-[240px] w-full object-contain select-none pointer-events-none"
                  draggable={false}
                />
              </div>

            </button>

            <button
              type="button"
              className="tv-tile min-w-[260px] w-[260px] md:w-[320px] text-left transition-transform"
              onClick={() => nav('/Feedback')}
            >
              <div className="relative flex items-center justify-center h-full">
                <span
                  className="absolute top-3 left-3 text-[11px] font-bold tracking-wide uppercase opacity-80"
                  style={{ color: 'var(--muted)' }}
                >
                  Feedback
                </span>
                <img
                  src={`${import.meta.env.BASE_URL}feedback.png`}
                  alt=""
                  className="h-[200px] md:h-[240px] w-full object-contain select-none pointer-events-none"
                  draggable={false}
                />
              </div>
            </button>

<button
  type="button"
  className="tv-tile min-w-[260px] w-[260px] md:w-[320px] text-left transition-transform"
  onClick={() => nav('/Community')}
>
  <div className="relative flex items-center justify-center h-full">
    <span
      className="absolute top-3 left-3 text-[11px] font-bold tracking-wide uppercase opacity-80"
      style={{ color: 'var(--muted)' }}
    >
      Community
    </span>
    <div className="flex items-center justify-center w-full">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-[160px] md:h-[190px] w-full object-contain select-none pointer-events-none opacity-90"
        style={{ color: 'var(--text)' }}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3c3.5 3 3.5 15 0 18" />
        <path d="M12 3c-3.5 3-3.5 15 0 18" />
      </svg>
    </div>
  </div>
</button>

          </div>
        </div>

        {isAdmin ? (
          <div className="card flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Admin</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>Manage users and run seed tools.</div>
            </div>
            <button type="button" onClick={() => nav('/AdminUsers')} className="btn-secondary px-4 py-3 rounded-2xl font-semibold">
              Users
            </button>
          </div>
        ) : null}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-3">Start Shift</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">Date</label>
                <ShiftDateCalendar
                  value={date}
                  onChange={setDate}
                  datesWithData={datesWithData}
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Shift</label>
                <select className="input" value={dn} onChange={(e) => setDn(e.target.value as any)}>
                  <option value="DS">DS</option>
                  <option value="NS">NS</option>
                </select>
              </div>
              <div className="flex gap-2 pt-2">
                <button className="btn flex-1" onClick={confirmShift}>
                  Confirm
                </button>
                <button className="btn flex-1" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>

              <button
                type="button"
                className="text-[12px] underline text-center w-full mt-3 opacity-80 hover:opacity-100"
                style={{ color: '#b00020' }}
                onClick={() => {
                  setOpen(false);
                  nav('/ClearShifts');
                }}
              >
                Click here to clear shifts
              </button>
            </div>
          </div>
        </div>
      )}

      {dupeOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-2">Existing shift found</h3>
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              You already have uploaded data for <b style={{ color: 'var(--text)' }}>{date}</b>. Choose what to do.
            </div>

            {Array.isArray(dupeInfo?.shifts) ? (
              <div className="mt-3 space-y-2">
                <div className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>On this date:</div>
                <div className="space-y-2">
                  {dupeInfo.shifts.map((s: any) => (
                    <div key={String(s?.id)} className="tv-surface-soft tv-border border rounded-2xl p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">{String(s?.dn || '')}</div>
                        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{s?.finalized_at ? 'Finalized' : 'Draft'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              <button type="button" className="btn w-full" onClick={startFreshReplace}>
                Replace all data (start fresh)
              </button>
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={loadExistingAndAdd}
                disabled={!Array.isArray(dupeInfo?.shifts) || !dupeInfo.shifts.some((s: any) => String(s?.dn || '') === String(dn))}
                title={!Array.isArray(dupeInfo?.shifts) || !dupeInfo.shifts.some((s: any) => String(s?.dn || '') === String(dn)) ? 'No existing shift for the selected DS/NS' : ''}
              >
                Add to existing (load & continue)
              </button>
              <button type="button" className="btn-secondary w-full" onClick={() => setDupeOpen(false)}>
                Cancel
              </button>
              <div className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
                Re-finalizing a shift overwrites what is stored for that date/shift on the server.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShiftDateCalendar({
  value,
  onChange,
  datesWithData,
}: {
  value: string;
  onChange: (v: string) => void;
  datesWithData: Set<string>;
}) {
  const [open, setOpen] = useState(false);

  const baseDate = value ? parseYmd(value) : new Date();
  const [month, setMonth] = useState(baseDate.getMonth());
  const [year, setYear] = useState(baseDate.getFullYear());

  useEffect(() => {
    if (value) {
      const d = parseYmd(value);
      setMonth(d.getMonth());
      setYear(d.getFullYear());
    }
  }, [value]);

  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const weeks: (Date | null)[][] = [];
  let currentWeek: (Date | null)[] = [];

  for (let i = 0; i < startDay; i++) {
    currentWeek.push(null);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push(new Date(year, month, day));
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  function handleSelect(d: Date) {
    const ymd = formatYmd(d);
    onChange(ymd);
    setOpen(false);
  }

  function prevMonth() {
    const d = new Date(year, month - 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  function nextMonth() {
    const d = new Date(year, month + 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  const labelText = value || 'Select date';

  return (
    <div className="relative inline-block w-full">
      <button
        type="button"
        className="input flex items-center justify-between w-full"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{labelText}</span>
        <span className="ml-2 text-slate-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-2 right-0 w-72 tv-surface-soft tv-border border rounded-2xl shadow-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              className="btn-secondary px-3 py-2"
              onClick={prevMonth}
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="text-sm font-medium">
              {new Intl.DateTimeFormat(undefined, {
                month: 'short',
                year: 'numeric',
              }).format(new Date(year, month, 1))}
            </div>
            <button
              type="button"
              className="btn-secondary px-3 py-2"
              onClick={nextMonth}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] mb-2 tv-muted font-semibold">
            <div>S</div>
            <div>M</div>
            <div>T</div>
            <div>W</div>
            <div>T</div>
            <div>F</div>
            <div>S</div>
          </div>

          <div className="grid grid-cols-7 text-center gap-1">
            {weeks.map((week, wi) =>
              week.map((d, di) => {
                if (!d) {
                  return (
                    <div
                      key={`${wi}-${di}`}
                      className="w-10 h-10 inline-flex items-center justify-center"
                    />
                  );
                }
                const ymd = formatYmd(d);
                const isSelected = value === ymd;
                const hasData = datesWithData.has(ymd);

                const base = 'w-10 h-10 inline-flex items-center justify-center rounded-xl text-sm border font-semibold tv-hoverable';
                const style: any = isSelected
                  ? { background: 'var(--accent-2)', borderColor: 'var(--accent-2)', color: 'white' }
                  : hasData
                    ? { background: 'rgba(48,209,88,0.18)', borderColor: 'var(--ok)', color: 'var(--text)' }
                    : { background: 'var(--input)', borderColor: 'var(--hairline)', color: 'var(--text)' };

                return (
                  <button
                    key={`${wi}-${di}`}
                    type="button"
                    className={base}
                    style={style}
                    onClick={() => handleSelect(d)}
                  >
                    {d.getDate()}
                  </button>
                );
              }),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

