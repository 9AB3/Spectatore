import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { getDB } from '../lib/idb';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { useNavigate } from 'react-router-dom';

/**
 * Build per-activity / per-sub-activity totals
 * This is the AUTHORITATIVE aggregation logic for Performance Review
 */
function buildSubgroupTotals(items: any[]) {
  const totals: any = {};

  for (const it of items) {
    const p = it.payload || {};
    const activity = p.activity || '(No Activity)';

    // -----------------------------
    // NORMALISE SUB-ACTIVITY
    // -----------------------------
    let subActivity = p.sub;

    // Loading MUST always resolve to Development or Production
    if (activity === 'Loading') {
      subActivity = subActivity || 'Development';
    }

    // Fallback safety (non-loading only)
    subActivity = subActivity || '(No Sub Activity)';

    totals[activity] ||= {};
    totals[activity][subActivity] ||= {};
    const sums = totals[activity][subActivity];

    // -----------------------------
    // 1) Sum all numeric raw inputs
    // -----------------------------
    for (const [k, v] of Object.entries(p.values || {})) {
      const num = parseFloat(String(v).replace(/[^\d.\-]/g, '')) || 0;
      if (!isNaN(num)) {
        sums[k] = Number(sums[k] || 0) + num;
      }
    }

    // Helpers
    const get = (k: string) => {
      const key = Object.keys(sums).find((x) => x.toLowerCase() === k.toLowerCase());
      return key ? Number(sums[key] || 0) : 0;
    };
    const nz = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

    // -----------------------------
    // 2) DERIVED METRICS
    // -----------------------------

    // GS Drillm = No. of Bolts × Bolt Length
    if (activity === 'Development' && (subActivity === 'Ground Support' || subActivity === 'Rehab')) {
      const vals = p.values || {};

      const boltsRaw = vals['No. of Bolts'] ?? vals['No of Bolts'] ?? vals['No of bolts'] ?? 0;
      const bolts = parseFloat(String(boltsRaw)) || 0;

      const blRaw = String(vals['Bolt Length'] ?? '').replace(/m/i, '');
      const boltLen = parseFloat(blRaw) || 0;

      const gsDrillm = nz(bolts) && nz(boltLen) ? bolts * boltLen : 0;
      if (gsDrillm) {
        sums['GS Drillm'] = Number(sums['GS Drillm'] || 0) + gsDrillm;
      }
    }

    // Dev Drillm = No of Holes × Cut Length
    if (activity === 'Development' && subActivity === 'Face Drilling') {
      const vals = p.values || {};

      const holesRaw = vals['No of Holes'] ?? vals['No of holes'] ?? 0;
      const holes = parseFloat(String(holesRaw)) || 0;

      const clRaw = String(vals['Cut Length'] ?? '').replace(/m/i, '');
      const cutLen = parseFloat(clRaw) || 0;

      const devDrillm = nz(holes) && nz(cutLen) ? holes * cutLen : 0;
      if (devDrillm) {
        sums['Dev Drillm'] = Number(sums['Dev Drillm'] || 0) + devDrillm;
      }
    }

    // -----------------------------
    // Loading roll-ups
    // -----------------------------
    if (activity === 'Loading') {
      const subL = String(subActivity || '').toLowerCase();
      const isProd =
        subL.includes('prod') || subL.includes('production') || subL.includes('stope');

      // DEV subgroup only
      if (!isProd) {
        const headingToTruck = get('Heading to Truck');
        const headingToSP = get('Heading to SP');

        // Dev rehandle must read Dev-prefixed keys (fallback to old keys for older shifts)
        const devSpToTruck = get('Dev SP to Truck') || get('SP to Truck');
        const devSpToSP = get('Dev SP to SP') || get('SP to SP');

        const primaryDev = headingToTruck + headingToSP;
        const rehandleDev = devSpToTruck + devSpToSP;

        if (primaryDev) {
          sums['Primary Dev Buckets'] = Number(sums['Primary Dev Buckets'] || 0) + primaryDev;
        }
        if (rehandleDev) {
          sums['Rehandle Dev Buckets'] = Number(sums['Rehandle Dev Buckets'] || 0) + rehandleDev;
        }
      }

      // PRODUCTION / STOPE subgroup only
      if (isProd) {
        const stopeToTruck = get('Stope to Truck');
        const stopeToSP = get('Stope to SP');

        // Stope rehandle must read Stope-prefixed keys (fallback to old keys for older shifts)
        const stopeSpToTruck = get('Stope SP to Truck') || get('SP to Truck');
        const stopeSpToSP = get('Stope SP to SP') || get('SP to SP');

        const primaryStope = stopeToTruck + stopeToSP;
        const rehandleStope = stopeSpToTruck + stopeSpToSP;

        if (primaryStope) {
          sums['Primary stope buckets'] =
            Number(sums['Primary stope buckets'] || 0) + primaryStope;
        }
        if (rehandleStope) {
          sums['Rehandle stope buckets'] =
            Number(sums['Rehandle stope buckets'] || 0) + rehandleStope;
        }
      }
    }

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
      setActivities(await db.getAll('activities'));
      setShift(await db.get('shift', 'current'));
    })();
  }, []);

  const totals = useMemo(() => buildSubgroupTotals(activities), [activities]);

  async function finalize() {
    if (!shift) {
      setMsg('No active shift to finalize');
      return;
    }

    setBusy(true);
    try {
      const payload = {
        date: shift.date,
        dn: shift.dn,
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
