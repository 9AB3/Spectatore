import Header from '../components/Header';
import { useNavigate } from 'react-router-dom';
import useToast from '../hooks/useToast';
import { useEffect, useState } from 'react';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';
import portalIcon from '../assets/portal_icon.png';
import tagoutIcon from '../assets/tagout.png';

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
    // Save to localStorage (for legacy) and to IndexedDB
    localStorage.setItem('spectatore-shift', JSON.stringify({ date, dn }));
    const db = await getDB();
    await db.put('shift', { date, dn }, 'current');
    setMsg('Entering portal');
    setOpen(false);
    // Keep toast visible for at least 2s before route change
    setTimeout(() => nav('/Shift'), 2000);
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 grid gap-4 max-w-xl mx-auto">
        <button
          className="btn"
          onClick={() => setOpen(true)}
          style={{ paddingTop: 22, paddingBottom: 22 }}
        >
          <div className="flex flex-col items-center justify-center gap-2">
            <span>START SHIFT</span>
            <img
              src={portalIcon}
              alt="Portal"
              className="h-24 w-24 button-icon"
            />
          </div>
        </button>
        {isAdmin && (
          <button className="btn" onClick={() => nav('/AdminUsers')}>
            Admin – Users
          </button>
        )}
        <button
          className="btn"
          onClick={tagOut}
          style={{ paddingTop: 22, paddingBottom: 22 }}
        >
          <div className="flex flex-col items-center justify-center gap-2">
            <span>TAG OUT</span>
            <img
              src={tagoutIcon}
              alt="Tag"
              className="h-24 w-24 button-icon"
            />
          </div>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center">
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
        <div className="absolute z-20 mt-1 bg-white border border-slate-300 rounded shadow-lg p-2 w-64 right-0">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              className="px-2 text-sm text-slate-600"
              onClick={prevMonth}
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
              className="px-2 text-sm text-slate-600"
              onClick={nextMonth}
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] mb-1 text-slate-500">
            <div>S</div>
            <div>M</div>
            <div>T</div>
            <div>W</div>
            <div>T</div>
            <div>F</div>
            <div>S</div>
          </div>

          <div className="grid grid-cols-7 text-center gap-y-1">
            {weeks.map((week, wi) =>
              week.map((d, di) => {
                if (!d) {
                  return (
                    <div
                      key={`${wi}-${di}`}
                      className="w-8 h-8 inline-flex items-center justify-center"
                    />
                  );
                }
                const ymd = formatYmd(d);
                const isSelected = value === ymd;
                const hasData = datesWithData.has(ymd);

                let base =
                  'w-8 h-8 inline-flex items-center justify-center rounded-full text-xs cursor-pointer';
                let extra = ' text-slate-700 hover:bg-slate-100';

                if (hasData) {
                  extra =
                    ' bg-green-200 text-green-900 hover:bg-green-300';
                }
                if (isSelected) {
                  extra += ' ring-2 ring-slate-500';
                }

                return (
                  <button
                    key={`${wi}-${di}`}
                    type="button"
                    className={base + extra}
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

