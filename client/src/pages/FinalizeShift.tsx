import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { useNavigate } from 'react-router-dom';

function buildSubgroupTotals(items: any[]) {
  const totals: any = {};
  for (const it of items) {
    const p = it.payload || {};
    const activity = p.activity || '(No Activity)';
    const subActivity = p.sub || '(No Sub Activity)';
    totals[activity] ||= {};
    totals[activity][subActivity] ||= {};
    const sums = totals[activity][subActivity];
    // normalize hauling key variants to consistent display names
    const add = (key: string, val: number) => {
      if (!isNaN(val)) sums[key] = Number(sums[key] || 0) + val;
    };

    // 1) Add up all numeric fields from the raw values
    for (const [k, v] of Object.entries(p.values || {})) {
      const num = parseFloat(String(v).replace(/[^\d.\-]/g, '')) || 0;
      sums[k] = (sums[k] || 0) + num;
    }

    // Helpers
    const get = (k: string) => {
      const key = Object.keys(sums).find((x) => x.toLowerCase() === k.toLowerCase());
      return key ? Number(sums[key] || 0) : 0;
    };
    const nz = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

       // 2) Derived metrics requested

    // GS Drillm = sum(No. of Bolts × Bolt Length) per activity record
    // (matches ViewActivities behaviour and handles multi-bolt forms correctly)
    if (
      activity === 'Development' &&
      (subActivity === 'Ground Support' || subActivity === 'Rehab')
    ) {
      const vals = p.values || {};

      const boltsRaw =
        vals['No. of Bolts'] ??
        vals['No of Bolts'] ??
        vals['No of bolts'] ??
        0;
      const bolts = parseFloat(String(boltsRaw)) || 0;

      const blRaw = String(vals['Bolt Length'] ?? '').replace(/m/i, '');
      const boltLen = parseFloat(blRaw) || 0;

      const gsDrillm = nz(bolts) && nz(boltLen) ? bolts * boltLen : 0;
      if (gsDrillm) {
        sums['GS Drillm'] = Number(sums['GS Drillm'] || 0) + gsDrillm;
      }
    }


    // Dev Drillm = sum(No of Holes × Cut Length) per activity record
    // Needed for Face Drilling tasks
    if (activity === 'Development' && subActivity === 'Face Drilling') {
      const vals = p.values || {};

      const holesRaw =
        vals['No of Holes'] ??
        vals['No of holes'] ??
        0;
      const holes = parseFloat(String(holesRaw)) || 0;

      const clRaw = String(vals['Cut Length'] ?? '').replace(/m/i, '');
      const cutLen = parseFloat(clRaw) || 0;

      const devDrillm = nz(holes) && nz(cutLen) ? holes * cutLen : 0;
      if (devDrillm) {
        sums['Dev Drillm'] = Number(sums['Dev Drillm'] || 0) + devDrillm;
      }
    }


    // Loading buckets rollups
    // Development Loading
    const headingToTruck = get('Heading to Truck');
    const headingToSP = get('Heading to SP');
    const spToTruck = get('SP to Truck');
    const spToSP = get('SP to SP');
    const primaryDev = headingToTruck + headingToSP;
    const rehandleDev = spToTruck + spToSP;
    if (primaryDev)
      sums['Primary Dev Buckets'] = Number(sums['Primary Dev Buckets'] || 0) + primaryDev;
    if (rehandleDev)
      sums['Rehandle Dev Buckets'] = Number(sums['Rehandle Dev Buckets'] || 0) + rehandleDev;

    // Production Loading
    const stopeToTruck = get('Stope to Truck');
    const stopeToSP = get('Stope to SP');
    const primaryStope = stopeToTruck + stopeToSP;
    const rehandleStope = spToTruck + spToSP;
    if (primaryStope)
      sums['Primary stope buckets'] = Number(sums['Primary stope buckets'] || 0) + primaryStope;
    if (rehandleStope)
      sums['Rehandle stope buckets'] = Number(sums['Rehandle stope buckets'] || 0) + rehandleStope;

    totals[activity][subActivity] = sums;
  }
  return totals;
}
export default function FinalizeShift() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [activities, setActivities] = useState<any[]>([]);
  const [shift, setShift] = useState<any | null>(null);

  useEffect(() => {
    (async () => {
      const db = await getDB();
      const acts = await db.getAll('activities');
      setActivities(acts);
      const sh = await db.get('shift', 'current');
      setShift(sh);
    })();
  }, []);

  const totals = useMemo(() => buildSubgroupTotals(activities), [activities]);

  async function finalize() {
    if (!shift) return setMsg('No active shift to finalize');
    setBusy(true);
    try {
      const payload = {
        date: shift?.date,
        dn: shift?.dn,
        totals,
        activities,
      };
      await api('/api/shifts/finalize', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const db = await getDB();
      await db.clear('activities');
      await db.delete('shift', 'current');
      setMsg('Shift synced successfully');
      setTimeout(() => nav('/Main'), 600);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to sync');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 max-w-2xl mx-auto">
        <div className="card">
          <h2 className="text-xl font-semibold mb-3">Finalize Shift</h2>
          <p className="text-sm text-slate-600 mb-4">
            Activities ready to sync: <strong>{activities.length}</strong>
          </p>
          <button
            className="btn btn-primary"
            onClick={finalize}
            disabled={busy || activities.length === 0}
          >
            {busy ? 'Syncing…' : 'FINALIZE SHIFT'}
          </button>
        </div>
      </div>
    </div>
  );
}
