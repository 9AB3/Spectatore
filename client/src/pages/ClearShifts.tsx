import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

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

export default function ClearShifts() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [datesWithFinalized, setDatesWithFinalized] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api('/api/shifts/dates-with-finalized');
        const arr = (res?.dates || []) as string[];
        if (!cancelled) setDatesWithFinalized(new Set(arr));
      } catch (e) {
        console.error('Failed to load finalized dates', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedList = useMemo(() => Array.from(selected).sort(), [selected]);

  async function doDelete() {
    try {
      await api('/api/shifts/delete-finalized', {
        method: 'POST',
        body: JSON.stringify({ dates: selectedList }),
      });
      setMsg('Shift data deleted');
      // Update local state so the calendar reflects removals immediately
      const next = new Set(datesWithFinalized);
      for (const d of selectedList) next.delete(d);
      setDatesWithFinalized(next);
      setSelected(new Set());
    } catch (e: any) {
      setMsg(e?.message || 'Delete failed');
    } finally {
      setConfirmOpen(false);
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-xl mx-auto space-y-4">
        <div className="card">
          <h2 className="text-xl font-semibold mb-3">Clear Shifts</h2>

          <div className="text-sm tv-muted mb-3">
            Select dates, then delete finalized shift data for those dates.
          </div>

          <MultiSelectCalendar
            datesWithData={datesWithFinalized}
            selected={selected}
            onToggle={(ymd) => {
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(ymd)) next.delete(ymd);
                else next.add(ymd);
                return next;
              });
            }}
          />

          {selectedList.length > 0 && (
            <div className="mt-3 text-xs tv-muted">
              Selected: {selectedList.join(', ')}
            </div>
          )}
        </div>

        <button
          className="btn w-full"
          disabled={selectedList.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          Delete Data
        </button>
        <button className="btn w-full" onClick={() => nav('/Main')}>
          BACK
        </button>
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-[1000] overflow-auto pt-6 pb-24">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-2">Delete shift data</h3>
            <div className="text-sm text-slate-700 mb-4">Delete shift data? (Y/N)</div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={doDelete}>
                Yes
              </button>
              <button className="btn flex-1" onClick={() => setConfirmOpen(false)}>
                No
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MultiSelectCalendar({
  datesWithData,
  selected,
  onToggle,
}: {
  datesWithData: Set<string>;
  selected: Set<string>;
  onToggle: (ymd: string) => void;
}) {
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth());
  const [year, setYear] = useState(today.getFullYear());

  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const weeks: (Date | null)[][] = [];
  let currentWeek: (Date | null)[] = [];
  for (let i = 0; i < startDay; i++) currentWeek.push(null);
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

  const monthLabel = new Date(year, month, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="tv-surface-soft tv-border border rounded-2xl p-3">
      <div className="flex items-center justify-between mb-2">
        <button className="btn-secondary px-3 py-2" type="button" onClick={prevMonth} aria-label="Previous month">
          ‹
        </button>
        <div className="text-sm font-semibold">{monthLabel}</div>
        <button className="btn-secondary px-3 py-2" type="button" onClick={nextMonth} aria-label="Next month">
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-xs tv-muted mb-2">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => (
          <div key={d} className="text-center font-semibold">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weeks.flat().map((d, idx) => {
          if (!d) return <div key={idx} className="h-10" />;
          const ymd = formatYmd(d);
          const has = datesWithData.has(ymd);
          const isSel = selected.has(ymd);

          // Style rules:
          // - green background for dates that have finalized data
          // - strong border/contrast for selected dates
          const base = 'h-10 rounded-xl flex items-center justify-center text-sm border font-semibold tv-hoverable';
          const cls = `${base}`;
          const style: any = isSel
            ? { background: 'var(--accent-2)', borderColor: 'var(--accent-2)', color: 'white' }
            : has
              ? { background: 'rgba(48,209,88,0.18)', borderColor: 'var(--ok)', color: 'var(--text)' }
              : { background: 'var(--input)', borderColor: 'var(--hairline)', color: 'var(--text)' };

          return (
            <button
              key={idx}
              type="button"
              className={cls}
              style={style}
              onClick={() => onToggle(ymd)}
              title={ymd}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
