import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
import { getDB } from '../lib/idb';

type ShiftRow = { id: number; date: string; dn: string; totals_json: any };
type CrewMember = { id: number; name: string };

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((v) => parseInt(v, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function lc(s: any) {
  return String(s || '').trim().toLowerCase();
}

// Prefer new keys but keep backward compatibility
function getAny(metricMap: Record<string, number>, ...keys: string[]) {
  for (const k of keys) {
    if (!k) continue;
    const direct = metricMap[k];
    if (direct !== undefined) return n(direct);

    const k2 = lc(k);
    for (const [kk, vv] of Object.entries(metricMap)) {
      if (lc(kk) === k2) return n(vv);
    }
  }
  return 0;
}

// Determines which prefix ("Dev" / "Stope") to use for rehandle metrics for Loading activity rows.
// This matches the logic used elsewhere in the app where "SP to Truck" and "SP to SP" are renamed.
function pickLoadingPrefix(subGroup: string) {
  const s = lc(subGroup);
  if (s.includes('stope') || s.includes('prod') || s.includes('production')) return 'Stope';
  return 'Dev';
}

export default function FinalizeShift() {
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const navigate = useNavigate();

  const shift_id = Number(searchParams.get('shift_id') || 0);

  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get(`/api/shifts/${shift_id}`);
        setShift(s?.shift || s);

        const cm = await api.get('/api/crew');
        setCrew(cm?.crew || cm || []);
      } catch (e: any) {
        toast.error(e?.message || 'Failed to load shift');
      }
    })();
  }, [shift_id]);

  // --------- MAIN FIX AREA: build totals correctly for Dev/Stope rehandle -----------
  // We rebuild/normalize totals_json before calling finalize so Performance Review has the right values.
  const normalizedTotals = useMemo(() => {
    const t = shift?.totals_json || {};
    // We expect totals_json to be something like:
    // { activity: { subGroup: { metricName: number } } }
    // But we’ll be defensive.
    const out: any = JSON.parse(JSON.stringify(t || {}));

    // Helper to ensure nesting exists
    function ensure(activity: string, sub: string) {
      out[activity] = out[activity] || {};
      out[activity][sub] = out[activity][sub] || {};
      return out[activity][sub] as Record<string, number>;
    }

    // Rollups we want to guarantee exist:
    // Loading:
    //   Primary Dev Buckets, Rehandle Dev Buckets
    //   Primary Stope Buckets, Rehandle Stope Buckets
    //
    // Note: "Primary" buckets might come from a "Buckets" or similar field used on Loading forms.
    // Rehandle comes from SP to Truck + SP to SP (renamed to Dev/Stope ...).
    // We compute those rollups across Loading subgroups.
    const loadActivity = out['Loading'] || out['loading'];
    if (loadActivity && typeof loadActivity === 'object') {
      let primaryDev = 0;
      let rehandleDev = 0;
      let primaryStope = 0;
      let rehandleStope = 0;

      for (const [sub, metricsAny] of Object.entries(loadActivity)) {
        if (!metricsAny || typeof metricsAny !== 'object') continue;
        const metrics = metricsAny as Record<string, number>;

        // Primary buckets: try common keys (case-insensitive)
        const primary = getAny(metrics, 'Buckets', 'Primary Buckets', 'Primary', 'Total Buckets');
        // Rehandle: use new keys first, but also fallback to old keys
        const prefix = pickLoadingPrefix(sub);

        const spToTruck = getAny(
          metrics,
          `${prefix} SP to Truck`,
          `${prefix} SP toTruck`,
          `${prefix} SPtoTruck`,
          `${prefix} SP to truck`,
          'SP to Truck',
          'SPtoTruck',
          'SP toTruck'
        );
        const spToSP = getAny(
          metrics,
          `${prefix} SP to SP`,
          `${prefix} SPtoSP`,
          `${prefix} SP to sp`,
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

      // Store these rollups under a canonical "All" subgroup for Loading,
      // so Performance Review can reliably show them.
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
      // Update the shift totals_json first (local + server) so the finalize uses corrected totals.
      // Save to server
      await api.post(`/api/shifts/${shift_id}/totals`, { totals_json: normalizedTotals });

      // Also update local idb cache if present
      try {
        const db = await getDB();
        await db.put('shifts', { ...(shift as any), totals_json: normalizedTotals });
      } catch {
        // ignore cache errors
      }

      await api.post(`/api/shifts/${shift_id}/finalize`, {});
      toast.success('Shift finalized');
      navigate('/performance-review');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to finalize shift');
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
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="text-sm opacity-80">Shift Date</div>
                <div className="font-semibold">{shift.date}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm opacity-80">Shift</div>
                <div className="font-semibold">{shift.dn}</div>
              </div>

              <div className="mt-4 p-3 bg-black/20 rounded-lg border border-white/10">
                <div className="text-sm opacity-80 mb-2">Preview rollups (Loading → All)</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="opacity-80">Primary Dev Buckets</div>
                  <div className="text-right">
                    {n(
                      normalizedTotals?.Loading?.All?.['Primary Dev Buckets'] ??
                        normalizedTotals?.loading?.All?.['Primary Dev Buckets']
                    )}
                  </div>
                  <div className="opacity-80">Rehandle Dev Buckets</div>
                  <div className="text-right">
                    {n(
                      normalizedTotals?.Loading?.All?.['Rehandle Dev Buckets'] ??
                        normalizedTotals?.loading?.All?.['Rehandle Dev Buckets']
                    )}
                  </div>
                  <div className="opacity-80">Primary Stope Buckets</div>
                  <div className="text-right">
                    {n(
                      normalizedTotals?.Loading?.All?.['Primary Stope Buckets'] ??
                        normalizedTotals?.loading?.All?.['Primary Stope Buckets']
                    )}
                  </div>
                  <div className="opacity-80">Rehandle Stope Buckets</div>
                  <div className="text-right">
                    {n(
                      normalizedTotals?.Loading?.All?.['Rehandle Stope Buckets'] ??
                        normalizedTotals?.loading?.All?.['Rehandle Stope Buckets']
                    )}
                  </div>
                </div>
              </div>

              <button
                onClick={onFinalize}
                disabled={loading}
                className="mt-4 w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 font-semibold"
              >
                {loading ? 'Finalizing…' : 'Finalize Shift'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
