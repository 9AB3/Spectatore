import Header from '../components/Header';
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDB } from '../lib/idb';

export default function ViewActivities() {
  const nav = useNavigate();
  async function handleDelete(id: number) {
    const db = await getDB();
    await db.delete('activities', id);
    const list = await db.getAll('activities');
    // refresh view
    setItems(list || []);
  }

  function handleEdit(id: number) {
    nav('/Activity', {
      state: {
        editActivityId: id,
        returnTo: '/ViewActivities',
      },
    });
  }

  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const list = await db.getAll('activities');
      setItems(list || []);
    })();
  }, []);

  const grouped = useMemo(() => {
    const g: Record<string, Record<string, any[]>> = {};
    for (const it of items) {
      const p = it.payload || {};
      const act = p.activity || '(No Activity)';
      const sub = p.sub || '(No Sub Activity)';
      if (!g[act]) g[act] = {};
      if (!g[act][sub]) g[act][sub] = [];
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
      if (!totals[activity]) totals[activity] = {};
      if (!totals[activity][subActivity]) totals[activity][subActivity] = {};
      // sum numeric fields
      for (const [k, v] of Object.entries(p.values || {})) {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (!isNaN(n)) {
          totals[activity][subActivity][k] = (totals[activity][subActivity][k] || 0) + n;
        }
      }
      // Derived metrics
      if (activity === 'Development' && subActivity === 'Face Drilling') {
        const holes = parseFloat((p.values || {})['No of Holes'] ?? (0 as any));
        const cut = parseFloat((p.values || {})['Cut Length'] ?? (0 as any));
        const devDrillm = isNaN(holes) || isNaN(cut) ? 0 : holes * cut;
        totals[activity][subActivity]['Dev Drillm'] =
          (totals[activity][subActivity]['Dev Drillm'] || 0) + devDrillm;
      }
      if (
        activity === 'Development' &&
        (subActivity === 'Ground Support' || subActivity === 'Rehab')
      ) {
        const bolts = parseFloat((p.values || {})['No. of Bolts'] ?? (0 as any));
        const blRaw = String((p.values || {})['Bolt Length'] ?? '').replace('m', '');
        const bl = parseFloat(blRaw) || 0;
        const gsDrillm = isNaN(bolts) || isNaN(bl) ? 0 : bolts * bl;
        totals[activity][subActivity]['GS Drillm'] =
          (totals[activity][subActivity]['GS Drillm'] || 0) + gsDrillm;
      }
      if (
        activity === 'Hauling' &&
        (subActivity === 'Production' || subActivity === 'Development')
      ) {
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

  return (
    <div>
      <Header />
      <div className="p-6 max-w-3xl mx-auto">
        <div className="tv-tile">
          <h2 className="text-xl font-semibold mb-3">Shift Activities</h2>
          {items.length === 0 ? (
            <div className="tv-muted text-sm">No activities yet</div>
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
                              className="tv-surface-soft tv-border border rounded-2xl p-3 flex items-start gap-3 cursor-pointer hover:shadow-sm transition"
                              onClick={() => handleEdit(it.id)}
                            >
                              <div className="text-xs tv-muted flex-1">
                                {Object.entries(p.values || {}).map(([k, v], i) => (
                                  <span key={i} className="mr-2">
                                    {k}: <b className="text-[color:var(--text)]">{String(v)}</b>
                                  </span>
                                ))}

                                {act === 'Hauling' && Array.isArray((p as any).loads) && (p as any).loads.length ? (
                                  <div className="mt-1 text-[11px] tv-muted">
                                    Truck weights: {(p as any).loads
                                      .map((l: any, ii: number) => {
                                        const w = Number(String(l?.weight ?? l?.Weight ?? '').replace(/[^0-9.]/g, ''));
                                        const ts = l?.time_s ?? l?.time ?? l?.Time;
                                        const s = typeof ts === 'number' ? ts : parseFloat(String(ts));
                                        const t = Number.isFinite(s) ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}` : '';
                                        return `${ii + 1}:${Number.isFinite(w) ? w : 0}${t ? `(${t})` : ''}`;
                                      })
                                      .join(', ')}
                                  </div>
                                ) : null}
                  </div>
                              <div className="mt-1">
                                <button
                                  aria-label="Delete"
                                  title="Delete"
                                  className="ml-auto tv-muted hover:text-red-400 text-lg leading-none px-2"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDelete(it.id);
                                  }}
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
                        
{act === 'Hauling' ? (
  (() => {
    const tasks = (grouped[act]?.[sub] || []);
    let totalTrucks = 0;
    let totalWeight = 0;
    let totalDistance = 0;
    let totalTKMs = 0;

    for (const it of tasks) {
      const p: any = it.payload || {};
      const v: any = p.values || {};

      const loads = Array.isArray(p.loads) ? p.loads : null;

      const trucks = loads
        ? loads.length
        : parseFloat(String(v['Trucks'] ?? v['No of trucks'] ?? v['No of Trucks'] ?? 0)) || 0;

      // Total tonnes hauled (prefer per-load weights, then explicit total, then legacy trucks×weight)
      const tonnes = loads
        ? loads.reduce((acc: number, l: any) => acc + (parseFloat(String(l?.weight ?? l?.Weight ?? 0)) || 0), 0)
        : (parseFloat(String(v['Tonnes Hauled'] ?? 0)) || 0) ||
          (trucks * (parseFloat(String(v['Weight'] ?? 0)) || 0));

      const distance = parseFloat(String(v['Distance'] ?? 0)) || 0;

      totalTrucks += trucks;
      totalWeight += tonnes;
      totalDistance += trucks * distance; // sum of distance per load
      totalTKMs += tonnes * distance;
    }

    return (
      <tbody>
        <tr><td className="py-1 pr-4 tv-muted">Total Trucks</td><td className="py-1 font-semibold">{totalTrucks.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 tv-muted">Total Weight</td><td className="py-1 font-semibold">{totalWeight.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 tv-muted">Total Distance</td><td className="py-1 font-semibold">{totalDistance.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 tv-muted">Total TKMs</td><td className="py-1 font-semibold">{totalTKMs.toLocaleString()}</td></tr>
      </tbody>
    );
  })()
) : (
  <tbody>
    {Object.entries(sums).map(([k, v]) => (
      <tr key={k}>
        <td className="py-1 pr-4 tv-muted">{k}</td>
        <td className="py-1 font-semibold">{Number(v as number).toLocaleString()}</td>
      </tr>
    ))}
  </tbody>
)}

                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <button className="btn flex-1 text-center" onClick={() => nav('/Shift')}>BACK</button>
          </div>
        </div>
      </div>
    </div>
  );
}
