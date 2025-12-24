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
      <div className="p-6 max-w-2xl mx-auto">
        <div className="card">
          <h2 className="text-xl font-semibold mb-3">Shift Activities</h2>
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
                        
{act === 'Hauling' ? (
  (() => {
    const tasks = (grouped[act]?.[sub] || []);
    let totalTrucks = 0;
    let totalWeight = 0;
    let totalDistance = 0;
    let totalTKMs = 0;

    for (const it of tasks) {
      const p = it.payload || {};
      const v = p.values || {};
      const trucks = parseFloat(String(v['Trucks'] ?? v['No of trucks'] ?? v['No of Trucks'] ?? 0)) || 0;
      const weight = parseFloat(String(v['Weight'] ?? 0)) || 0;
      const distance = parseFloat(String(v['Distance'] ?? 0)) || 0;
      totalTrucks += trucks;
      totalWeight += trucks * weight;
      totalDistance += trucks * distance; // per request
      totalTKMs += trucks * weight * distance;
    }

    return (
      <tbody>
        <tr><td className="py-1 pr-4 text-slate-600">Total Trucks</td><td className="py-1 font-semibold">{totalTrucks.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 text-slate-600">Total Weight</td><td className="py-1 font-semibold">{totalWeight.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 text-slate-600">Total Distance</td><td className="py-1 font-semibold">{totalDistance.toLocaleString()}</td></tr>
        <tr><td className="py-1 pr-4 text-slate-600">Total TKMs</td><td className="py-1 font-semibold">{totalTKMs.toLocaleString()}</td></tr>
      </tbody>
    );
  })()
) : (
  <tbody>
    {Object.entries(sums).map(([k, v]) => (
      <tr key={k}>
        <td className="py-1 pr-4 text-slate-600">{k}</td>
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
