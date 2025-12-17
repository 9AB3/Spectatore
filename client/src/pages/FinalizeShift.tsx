import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { useNavigate } from 'react-router-dom';

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

function ShiftDateCalendar({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
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

  function handleSelect(d: Date) {
    onChange(formatYmd(d));
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

  return (
    <div className="relative inline-block w-full">
      <button
        type="button"
        className="input flex items-center justify-between w-full"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{value || 'Select date'}</span>
        <span className="ml-2 text-slate-400">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 bg-white border border-slate-300 rounded shadow-lg p-2 w-64 right-0">
          <div className="flex items-center justify-between mb-2">
            <button type="button" className="px-2 text-sm text-slate-600" onClick={prevMonth}>
              ‹
            </button>
            <div className="text-sm font-medium">
              {new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(
                new Date(year, month, 1),
              )}
            </div>
            <button type="button" className="px-2 text-sm text-slate-600" onClick={nextMonth}>
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500 mb-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {weeks.flat().map((d, idx) => {
              if (!d) return <div key={idx} />;
              const ymd = formatYmd(d);
              const selected = ymd === value;
              return (
                <button
                  key={idx}
                  type="button"
                  className={`text-xs rounded p-1 ${selected ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => handleSelect(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FinalizeShift() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [shift, setShift] = useState<{ date?: string; dn?: 'DS' | 'NS' } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [tmpDate, setTmpDate] = useState('');
  const [tmpDn, setTmpDn] = useState<'DS' | 'NS'>('DS');

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const list = await db.getAll('activities');
      setItems(list || []);
      const s = await db.get('shift', 'current');
      setShift(s || null);
      if (s?.date) setTmpDate(s.date);
      if (s?.dn) setTmpDn(s.dn);
    })();
  }, []);

  async function handleDelete(id: number) {
    const db = await getDB();
    await db.delete('activities', id);
    const list = await db.getAll('activities');
    setItems(list || []);
  }

  const grouped = useMemo(() => {
    const g: Record<string, Record<string, any[]>> = {};
    for (const it of items) {
      const p = it.payload || {};
      const act = p.activity || '(No Activity)';
      const sub = p.sub || '(No Sub Activity)';
      g[act] ||= {};
      g[act][sub] ||= [];
      g[act][sub].push(it);
    }
    return g;
  }, [items]);

  const totalsBySub = useMemo(() => {
    const totals: Record<string, Record<string, Record<string, number>>> = {};
    for (const it of items) {
      const p: any = it.payload || {};
      const activity = p.activity || '(No Activity)';
      const subActivity = p.sub || '(No Sub Activity)';
      totals[activity] ||= {};
      totals[activity][subActivity] ||= {};

      for (const [k, v] of Object.entries(p.values || {})) {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (!isNaN(n)) totals[activity][subActivity][k] = (totals[activity][subActivity][k] || 0) + n;
      }

      // Derived metrics (kept consistent with ViewActivities)
      if (activity === 'Development' && subActivity === 'Face Drilling') {
        const holes = parseFloat((p.values || {})['No of Holes'] ?? (0 as any));
        const cut = parseFloat((p.values || {})['Cut Length'] ?? (0 as any));
        const devDrillm = isNaN(holes) || isNaN(cut) ? 0 : holes * cut;
        totals[activity][subActivity]['Dev Drillm'] = (totals[activity][subActivity]['Dev Drillm'] || 0) + devDrillm;
      }
      if (activity === 'Development' && (subActivity === 'Ground Support' || subActivity === 'Rehab')) {
        const bolts = parseFloat((p.values || {})['No. of Bolts'] ?? (0 as any));
        const blRaw = String((p.values || {})['Bolt Length'] ?? '').replace('m', '');
        const bl = parseFloat(blRaw) || 0;
        const gsDrillm = isNaN(bolts) || isNaN(bl) ? 0 : bolts * bl;
        totals[activity][subActivity]['GS Drillm'] = (totals[activity][subActivity]['GS Drillm'] || 0) + gsDrillm;
      }
      if (activity === 'Hauling' && (subActivity === 'Production' || subActivity === 'Development')) {
        const wt = parseFloat((p.values || {})['Weight'] ?? (0 as any));
        const dist = parseFloat((p.values || {})['Distance'] ?? (0 as any));
        const trucks = parseFloat((p.values || {})['Trucks'] ?? (0 as any));
        const tkms = isNaN(wt) || isNaN(dist) || isNaN(trucks) ? 0 : wt * dist * trucks;
        totals[activity][subActivity]['TKMs'] = (totals[activity][subActivity]['TKMs'] || 0) + tkms;
      }
    }
    return totals;
  }, [items]);

  const activityKeys = Object.keys(grouped);

  function fmtShift() {
    if (!shift?.date || !shift?.dn) return '';
    const d = parseYmd(shift.date);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}, ${shift.dn}`;
  }

  async function applyShiftChange() {
    const db = await getDB();
    const next = { date: tmpDate, dn: tmpDn };
    await db.put('shift', next, 'current');
    localStorage.setItem('spectatore-shift', JSON.stringify(next));
    setShift(next);
    // Notify Header (and any other listeners) to refresh the shift display immediately.
    window.dispatchEvent(new Event('spectatore:shift'));
    setChangeOpen(false);
    setMsg('Shift updated');
    setTimeout(() => setMsg(''), 1500);
  }

  async function finalize() {
    if (!shift?.date || !shift?.dn) {
      setMsg('No active shift to finalize');
      setConfirmOpen(false);
      return;
    }
    setBusy(true);
    try {
      const payload = {
        date: shift.date,
        dn: shift.dn,
        totals: totalsBySub,
        activities: items,
      };
      await api('/api/shifts/finalize', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const db = await getDB();
      await db.clear('activities');
      await db.delete('shift', 'current');

      setMsg('Shift synced successfully');
      setTimeout(() => nav('/Main'), 800);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to sync');
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-2xl mx-auto">
        <div className="card">
          <h2 className="text-xl font-semibold mb-3">Finalize Shift</h2>
          {items.length === 0 ? (
            <div className="text-slate-500 text-sm">No activities yet</div>
          ) : (
            <div className="space-y-6">
              {activityKeys.map((act) => (
                <div key={act}>
                  <div className="text-base font-bold mb-2">{act}</div>
                  {Object.keys(grouped[act]).map((sub) => (
                    <div key={sub} className="ml-3">
                      <div className="text-sm font-semibold mb-1">{sub}</div>
                      <ul className="space-y-2">
                        {grouped[act][sub].map((it, idx) => {
                          const p = it.payload || {};
                          return (
                            <li
                              key={idx}
                              className="border-b pb-1 last:border-b-0 flex items-start gap-2"
                            >
                              <div className="text-xs text-slate-600">
                                {Object.entries(p.values || {}).map(([k, v], i) => (
                                  <span key={i} className="mr-2">
                                    {k}: <b>{String(v)}</b>
                                  </span>
                                ))}
                              </div>
                              <div className="mt-1">
                                <button
                                  aria-label="Delete"
                                  title="Delete"
                                  className="ml-auto text-slate-400 hover:text-red-600 text-lg leading-none px-2"
                                  onClick={() => handleDelete(it.id)}
                                >
                                  ×
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Subgroup Totals */}
          <div className="mt-6">
            <h3 className="text-lg font-semibold mb-2">Subgroup Totals</h3>
            {Object.entries(totalsBySub).map(([act, subs]) => (
              <div key={act} className="mb-4">
                <div className="font-semibold">{act}</div>
                {Object.entries(subs).map(([sub, sums]) => (
                  <div key={sub} className="ml-4 mt-2">
                    <div className="font-medium">{sub}</div>
                    <table className="w-full text-sm mt-2">
                      <tbody>
                        {Object.entries(sums).map(([k, v]) => (
                          <tr key={k}>
                            <td className="py-1 pr-4 text-slate-600">{k}</td>
                            <td className="py-1 font-semibold">{Number(v as number).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <button type="button" className="btn flex-1" onClick={() => nav('/Shift')}>
              BACK
            </button>
            <button
              type="button"
              className="btn flex-1"
              disabled={busy || items.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? 'SYNCING…' : 'FINALIZE SHIFT'}
            </button>
          </div>
        </div>
      </div>

      {/* Confirm Finalize Modal */}
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-3">Finalize shift for {fmtShift()}</h3>
            <div className="flex gap-2 pt-2">
              <button className="btn flex-1" onClick={finalize} disabled={busy}>
                Yes
              </button>
              <button className="btn flex-1" onClick={() => setConfirmOpen(false)} disabled={busy}>
                No
              </button>
            </div>
            <button
              type="button"
              className="text-[12px] underline text-center w-full mt-3 opacity-80 hover:opacity-100"
              onClick={() => {
                setConfirmOpen(false);
                setChangeOpen(true);
              }}
            >
              change date / shifts
            </button>
          </div>
        </div>
      )}

      {/* Change Date / Shift Modal */}
      {changeOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center">
          <div className="card w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-3">Change date / shift</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">Date</label>
                <ShiftDateCalendar value={tmpDate} onChange={setTmpDate} />
              </div>
              <div>
                <label className="block text-sm mb-1">Shift</label>
                <select className="input" value={tmpDn} onChange={(e) => setTmpDn(e.target.value as any)}>
                  <option value="DS">DS</option>
                  <option value="NS">NS</option>
                </select>
              </div>
              <div className="flex gap-2 pt-2">
                <button className="btn flex-1" onClick={applyShiftChange}>
                  Save
                </button>
                <button className="btn flex-1" onClick={() => setChangeOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
