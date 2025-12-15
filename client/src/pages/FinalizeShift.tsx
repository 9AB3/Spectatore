import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { getDB } from '../lib/idb';

type ShiftRow = { id: number; date: string; dn: string; totals_json: any };

function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function lc(s: any) {
  return String(s || '').trim().toLowerCase();
}

// Case-insensitive metric lookup with fallbacks
function getAny(metricMap: Record<string, any>, ...keys: string[]) {
  for (const k of keys) {
    if (!k) continue;

    if (metricMap[k] !== undefined) return n(metricMap[k]);

    const k2 = lc(k);
    for (const [kk, vv] of Object.entries(metricMap)) {
      if (lc(kk) === k2) return n(vv);
    }
  }
  return 0;
}

// Matches the intent of the Loading rename: Dev vs Stope
function pickLoadingPrefix(subGroup: string) {
  const s = lc(subGroup);
  if (s.includes('stope') || s.includes('prod') || s.includes('production')) return 'Stope';
  return 'Dev';
}

export default function FinalizeShift() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const shift_id = Number(searchParams.get('shift_id') || 0);

  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api(`/api/shifts/${shift_id}`);
        // your api helper typically returns either {shift} or the object directly
        setShift((s && s.shift) || s);
      } catch (e: any) {
        toast.setMsg(e?.message || 'Failed to load shift');
      }
    })();
  }, [shift_id]);

  // ---- FIX: normalize Loading rehandle rollups into Loading -> All ----
  const normalizedTotals = useMemo(() => {
    const t = shift?.totals_json || {};
    const out: any = JSON.parse(JSON.stringify(t || {}));

    function ensure(activity: string, sub: string) {
      out[activity] = out[activity] || {};
      out[activity][sub] = out[activity][sub] || {};
      return out[activity][sub] as Record<string, any>;
    }

    // Loading activity might be keyed as "Loading" or "loading"
    const loadActivity = out['Loading'] || out['loading'];
    if (loadActivity && typeof loadActivity === 'object') {
      let primaryDev = 0;
      let rehandleDev = 0;
      let primaryStope = 0;
      let rehandleStope = 0;

      for (const [sub, metricsAny] of Object.entries(loadActivity)) {
        if (!metricsAny || typeof metricsAny !== 'object') continue;
        const metrics = metricsAny as Record<string, any>;

        // Primary buckets: support common key variants
        const primary = getAny(metrics, 'Buckets', 'Primary Buckets', 'Primary', 'Total Buckets');

        const prefix = pickLoadingPrefix(sub);

        // Rehandle = SP to Truck + SP to SP
        // IMPORTANT: forms were renamed to Dev/Stope prefixed versions, so we must read those.
        const spToTruck = getAny(
          metrics,
          `${prefix} SP to Truck`,
          `${prefix} SP toTruck`,
          `${prefix} SPtoTruck`,
          `${prefix} SP to truck`,
          // backward compat
          'SP to Truck',
          'SPtoTruck',
          'SP toTruck'
        );

        const spToSP = getAny(
          metrics,
          `${prefix} SP to SP`,
          `${prefix} SPtoSP`,
          `${prefix} SP to sp`,
          // backward compat
          'SP to SP',
          'SPtoSP'
        );

        const rehandle = spToTruck + spToSP;

        if (prefix === 'Stope') {
          primaryStope += primary;
          rehandleStope += rehandle;
        } else {
          primaryDev += primary;
          rehandleDev += rehandle;
        }
      }

      const all = ensure('Loading', 'All');
      all['Primary Dev Buckets'] = n(primaryDev);
      all['Rehandle Dev Buckets'] = n(rehandleDev);
      all['Primary Stope Buckets'] = n(primaryStope);
      all['Rehandle Stope Buckets'] = n(rehandleStope);
    }

    return out;
  }, [shift]);

  async function onFinalize() {
    if (!shift_id) return;

    setLoading(true);
    try {
      // Persist corrected totals_json before finalizing
      await api(`/api/shifts/${shift_id}/totals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totals_json: normalizedTotals }),
      });

      // Update local IDB cache (best-effort)
      try {
        const db = await getDB();
        if (shift) await db.put('shifts', { ...(shift as any), totals_json: normalizedTotals });
      } catch {
        // ignore cache errors
      }

      await api(`/api/shifts/${shift_id}/finalize`, { method: 'POST' });

      toast.setMsg('Shift finalized');
      navigate('/performance-review');
    } catch (e: any) {
      toast.setMsg(e?.message || 'Failed to finalize shift');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0b1220] text-white">
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Finalize Shift</h1>

        {!shift ? (
          <div className="opacity-80">Loading...</div>
        ) : (
          <div className="bg-[#101a33] rounded-xl p-4 border border-white/10">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="text-sm opacity-80">Shift Date</div>
                <div className="font-semibold">{shift.date}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm opacity-80">Shift</div>
                <div className="font-semibold">{shift.dn}</div>
              </div>

              <button
                onClick={onFinalize}
                disabled={loading}
                className="mt-4 w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 font-semibold"
              >
                {loading ? 'Finalizing…' : 'Finalize Shift'}
              </button>

              {/* Render Toast component if your hook expects it */}
              <div className="mt-3">{toast.Toast ? <toast.Toast /> : null}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
