import { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

type ReconMetric = { key: string; label: string; unit: string };

function fmt(n: any, dp = 2) {
  const x = typeof n === 'string' ? parseFloat(n) : Number(n);
  if (!Number.isFinite(x)) return '-';
  return x.toFixed(dp);
}

function ymToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export default function SiteAdminReconciliation() {
  const { setMsg, Toast } = useToast();

  const [siteRows, setSiteRows] = useState<Array<{ id: number; name: string }>>([]);
  const [site, setSite] = useState<string>('');
  const [metrics, setMetrics] = useState<ReconMetric[]>([]);
  const [metricKey, setMetricKey] = useState<string>('firing|development|cut_length');
  const [basis] = useState<'validated_only' | 'captured_all'>('validated_only');
  const [method, setMethod] = useState<'spread_daily' | 'month_end'>('spread_daily');
  const [monthYm, setMonthYm] = useState<string>(ymToday());
  const [reconciledTotal, setReconciledTotal] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<any>(null);

  // Bucket factors modal
  const [showBuckets, setShowBuckets] = useState(false);
  const [bucketLoading, setBucketLoading] = useState(false);
  const [bucketData, setBucketData] = useState<any>(null);
  const [bucketAssignments, setBucketAssignments] = useState<Record<string, string>>({});
  const [bucketConfigs, setBucketConfigs] = useState<Record<string, { estimate: string; min: string; max: string; lock?: boolean }>>({});

  // Truck factors modal (mirrors bucket factors)
  const [showTrucks, setShowTrucks] = useState(false);
  const [truckLoading, setTruckLoading] = useState(false);
  const [truckData, setTruckData] = useState<any>(null);
  const [truckAssignments, setTruckAssignments] = useState<Record<string, string>>({});
  const [truckConfigs, setTruckConfigs] = useState<Record<string, { estimate: string; min: string; max: string; lock?: boolean }>>({});

  const selectedMetric = useMemo(() => metrics.find((m) => m.key === metricKey), [metrics, metricKey]);

  // Load scope + metrics
  useEffect(() => {
    (async () => {
      try {
        const me: any = await api('/api/site-admin/me');
        const rows = (me?.site_rows || []) as Array<{ id: number; name: string }>;
        setSiteRows(rows);
        if (!site) setSite(rows?.[0]?.name || '');
      } catch {
        setSiteRows([]);
      }

      try {
        const r: any = await api('/api/site-admin/reconciliation/metrics');
        setMetrics(r?.metrics || []);
      } catch {
        setMetrics([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load summary when inputs change
  useEffect(() => {
    if (!site || !monthYm || !metricKey) return;
    (async () => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ site, month_ym: monthYm, metric_key: metricKey, basis });
        const r: any = await api(`/api/site-admin/reconciliation/month-summary?${q.toString()}`);
        setSummary(r);
        if (r?.reconciliation?.reconciled_total != null) {
          setReconciledTotal(String(r.reconciliation.reconciled_total));
        } else {
          setReconciledTotal('');
        }
      } catch (e: any) {
        setSummary(null);
        setMsg(e?.message || 'Failed to load reconciliation summary');
      } finally {
        setLoading(false);
      }
    })();
  }, [site, monthYm, metricKey, basis]);

  async function save() {
    if (!site) return setMsg('Select a site');
    if (!/^[0-9]{4}-[0-9]{2}$/.test(monthYm)) return setMsg('Invalid month');
    const val = parseFloat(reconciledTotal);
    if (!Number.isFinite(val)) return setMsg('Enter a reconciled total');

    setLoading(true);
    try {
      const r: any = await api('/api/site-admin/reconciliation/upsert', {
        method: 'POST',
        body: {
          site,
          month_ym: monthYm,
          metric_key: metricKey,
          basis,
          method,
          reconciled_total: val,
        },
      });
      setMsg('Saved reconciliation');
      // refresh summary
      const q = new URLSearchParams({ site, month_ym: monthYm, metric_key: metricKey, basis });
      const s: any = await api(`/api/site-admin/reconciliation/month-summary?${q.toString()}`);
      setSummary(s);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to save');
    } finally {
      setLoading(false);
    }
  }

  async function recalc() {
    if (!summary?.reconciliation) return setMsg('Nothing to recalculate yet');
    setLoading(true);
    try {
      await api('/api/site-admin/reconciliation/recalculate', {
        method: 'POST',
        body: { site, month_ym: monthYm, metric_key: metricKey },
      });
      setMsg('Recalculated');
      const q = new URLSearchParams({ site, month_ym: monthYm, metric_key: metricKey, basis });
      const s: any = await api(`/api/site-admin/reconciliation/month-summary?${q.toString()}`);
      setSummary(s);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to recalculate');
    } finally {
      setLoading(false);
    }
  }

  async function setLock(lock: boolean) {
    if (!summary?.reconciliation) return;
    setLoading(true);
    try {
      await api(`/api/site-admin/reconciliation/${lock ? 'lock' : 'unlock'}`, {
        method: 'POST',
        body: { site, month_ym: monthYm, metric_key: metricKey },
      });
      setMsg(lock ? 'Locked' : 'Unlocked');
      const q = new URLSearchParams({ site, month_ym: monthYm, metric_key: metricKey, basis });
      const s: any = await api(`/api/site-admin/reconciliation/month-summary?${q.toString()}`);
      setSummary(s);
    } catch (e: any) {
      setMsg(e?.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }

  async function openBucketFactors() {
    if (!site) return setMsg('Select a site');
    if (!/^[0-9]{4}-[0-9]{2}$/.test(monthYm)) return setMsg('Invalid month');
    setShowBuckets(true);
    setBucketLoading(true);
    try {
      const q = new URLSearchParams({ site, month_ym: monthYm });
      const r: any = await api(`/api/site-admin/bucket-factors/month?${q.toString()}`);
      setBucketData(r);
      // seed assignments + config inputs
      const assign: Record<string, string> = {};
      for (const row of (r?.loaders || [])) {
        const lid = String(row.loader_id || '').trim();
        if (!lid) continue;
        assign[lid] = String(row.config_code || lid);
      }
      // server may also return explicit assignment map
      for (const [k, v] of Object.entries((r?.assignment || {}) as Record<string, any>)) {
        const lid = String(k || '').trim();
        if (!lid) continue;
        assign[lid] = String(v || lid);
      }
      setBucketAssignments(assign);

      const cfg: Record<string, { estimate: string; min: string; max: string; lock?: boolean }> = {};

      // bring in saved config defs
      for (const row of (r?.configs || [])) {
        const code = String((row as any)?.config_code || '').trim();
        if (!code) continue;
        cfg[code] = {
          estimate: (row as any)?.estimate_factor == null ? '' : String((row as any).estimate_factor),
          min: (row as any)?.min_factor == null ? '' : String((row as any).min_factor),
          max: (row as any)?.max_factor == null ? '' : String((row as any).max_factor),
          lock: false,
        };
      }

      // ensure any configs currently used exist (seed from loader row if present)
      for (const row of (r?.loaders || [])) {
        const code = String((row as any)?.config_code || '').trim();
        if (!code) continue;
        if (!cfg[code]) {
          cfg[code] = {
            estimate: (row as any)?.estimate_factor == null ? '' : String((row as any).estimate_factor),
            min: (row as any)?.min_factor == null ? '' : String((row as any).min_factor),
            max: (row as any)?.max_factor == null ? '' : String((row as any).max_factor),
            lock: false,
          };
        }
      }

      setBucketConfigs(cfg);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load bucket factors');
    } finally {
      setBucketLoading(false);
    }
  }

  async function openTruckFactors() {
    if (!site) return setMsg('Select a site');
    if (!/^[0-9]{4}-[0-9]{2}$/.test(monthYm)) return setMsg('Invalid month');
    setShowTrucks(true);
    setTruckLoading(true);
    try {
      const q = new URLSearchParams({ site, month_ym: monthYm });
      const r: any = await api(`/api/site-admin/truck-factors/month?${q.toString()}`);
      setTruckData(r);

      const assign: Record<string, string> = {};
      for (const row of (r?.trucks || [])) {
        const tid = String(row.truck_id || '').trim();
        if (!tid) continue;
        assign[tid] = String(row.config_code || tid);
      }
      for (const [k, v] of Object.entries((r?.assignment || {}) as Record<string, any>)) {
        const tid = String(k || '').trim();
        if (!tid) continue;
        assign[tid] = String(v || tid);
      }
      setTruckAssignments(assign);

      const cfg: Record<string, { estimate: string; min: string; max: string; lock?: boolean }> = {};
      for (const row of (r?.configs || [])) {
        const code = String((row as any)?.config_code || '').trim();
        if (!code) continue;
        cfg[code] = {
          estimate: (row as any)?.estimate_factor == null ? '' : String((row as any).estimate_factor),
          min: (row as any)?.min_factor == null ? '' : String((row as any).min_factor),
          max: (row as any)?.max_factor == null ? '' : String((row as any).max_factor),
          lock: false,
        };
      }
      for (const row of (r?.trucks || [])) {
        const code = String((row as any)?.config_code || '').trim();
        if (!code) continue;
        if (!cfg[code]) {
          cfg[code] = {
            estimate: (row as any)?.estimate_factor == null ? '' : String((row as any).estimate_factor),
            min: (row as any)?.min_factor == null ? '' : String((row as any).min_factor),
            max: (row as any)?.max_factor == null ? '' : String((row as any).max_factor),
            lock: false,
          };
        }
      }

      setTruckConfigs(cfg);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to load truck factors');
    } finally {
      setTruckLoading(false);
    }
  }

  async function solveBucketFactors(save: boolean) {
    if (!site) return setMsg('Select a site');
    if (!/^[0-9]{4}-[0-9]{2}$/.test(monthYm)) return setMsg('Invalid month');
    setBucketLoading(true);
    try {
      const assignments: Record<string, string> = {};
      for (const [lid, code] of Object.entries(bucketAssignments || {})) {
        const k = String(lid || '').trim();
        if (!k) continue;
        const v = String(code || '').trim();
        assignments[k] = v || k;
      }

      const configs: Record<string, { estimate?: number; min?: number; max?: number; lock?: boolean }> = {};
      for (const [code, v] of Object.entries(bucketConfigs || {})) {
        const c = String(code || '').trim();
        if (!c) continue;
        const est = v.estimate?.trim?.() === '' ? undefined : Number(v.estimate);
        const min = v.min?.trim?.() === '' ? undefined : Number(v.min);
        const max = v.max?.trim?.() === '' ? undefined : Number(v.max);
        configs[c] = {
          ...(Number.isFinite(est as any) ? { estimate: est } : {}),
          ...(Number.isFinite(min as any) ? { min } : {}),
          ...(Number.isFinite(max as any) ? { max } : {}),
          ...(v.lock ? { lock: true } : {}),
        };
      }

      const r: any = await api('/api/site-admin/bucket-factors/solve', {
        method: 'POST',
        body: { site, month_ym: monthYm, assignments, configs, save },
      });

      // merge result into bucketData
      setBucketData((prev: any) => ({ ...(prev || {}), solved: r }));
      if (save) setMsg('Bucket factors saved');
    } catch (e: any) {
      setMsg(e?.message || 'Failed to solve bucket factors');
    } finally {
      setBucketLoading(false);
    }
  }

  async function solveTruckFactors(save: boolean) {
    if (!site) return setMsg('Select a site');
    if (!/^[0-9]{4}-[0-9]{2}$/.test(monthYm)) return setMsg('Invalid month');
    setTruckLoading(true);
    try {
      const cfgOut: any = {};
      for (const [code, v] of Object.entries(truckConfigs || {})) {
        const est = v.estimate === '' ? null : parseFloat(v.estimate);
        const min = v.min === '' ? null : parseFloat(v.min);
        const max = v.max === '' ? null : parseFloat(v.max);
        cfgOut[code] = {
          estimate: Number.isFinite(est as any) ? est : null,
          min: Number.isFinite(min as any) ? min : null,
          max: Number.isFinite(max as any) ? max : null,
          lock: !!v.lock,
        };
      }

      const r: any = await api('/api/site-admin/truck-factors/solve', {
        method: 'POST',
        body: {
          site,
          month_ym: monthYm,
          save,
          assignments: truckAssignments,
          configs: cfgOut,
        },
      });
      setTruckData(r);
      if (save) setMsg('Truck factors saved');
    } catch (e: any) {
      setMsg(e?.message || 'Failed to solve truck factors');
    } finally {
      setTruckLoading(false);
    }
  }

  const actual = Number(summary?.actual_total ?? 0);
  const recon = summary?.reconciliation?.reconciled_total;
  const delta = recon == null ? null : Number(recon) - actual;
  const isLocked = !!summary?.reconciliation?.is_locked;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <Header title="Reconciliation" showSync={false} showBell={false} />
      <Toast />
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-[var(--card)] rounded-2xl shadow-sm p-4 border" style={{ borderColor: '#e9d9c3' }}>
          <div className="text-sm opacity-70 mb-3">
            Month-end adjustments (Option A). This does not change validated shifts — it creates a separate daily allocation dataset for reporting.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold mb-1">Site</div>
              <select
                className="w-full p-2 rounded-xl border bg-[color:var(--card)]"
                value={site}
                onChange={(e) => setSite(e.target.value)}
              >
                {siteRows.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold mb-1">Month</div>
              <input
                type="month"
                className="w-full p-2 rounded-xl border bg-[color:var(--card)]"
                value={monthYm}
                onChange={(e) => setMonthYm(e.target.value)}
              />
            </div>

            <div className="sm:col-span-2">
              <div className="text-xs font-semibold mb-1">Metric</div>
              <select
                className="w-full p-2 rounded-xl border bg-[color:var(--card)]"
                value={metricKey}
                onChange={(e) => setMetricKey(e.target.value)}
              >
                {(metrics.length ? metrics : [{ key: metricKey, label: 'Firing → Development → Cut Length', unit: 'm' }]).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold mb-1">Method</div>
              <select
                className="w-full p-2 rounded-xl border bg-[color:var(--card)]"
                value={method}
                onChange={(e) => setMethod(e.target.value as any)}
                disabled={isLocked}
              >
                <option value="spread_daily">Spread daily</option>
                <option value="month_end">Month end</option>
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold mb-1">Reconciled total ({selectedMetric?.unit || 'm'})</div>
              <input
                className="w-full p-2 rounded-xl border bg-[color:var(--card)]"
                value={reconciledTotal}
                onChange={(e) => setReconciledTotal(e.target.value)}
                placeholder="e.g. 300"
                disabled={isLocked}
              />
            </div>
          </div>

          <div className="mt-4 p-3 rounded-xl border bg-[color:var(--card)]" style={{ borderColor: '#f0e4d4' }}>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <div className="text-xs opacity-70">Actual (month)</div>
                <div className="font-semibold">{fmt(actual, 2)} {selectedMetric?.unit || ''}</div>
              </div>
              <div>
                <div className="text-xs opacity-70">Reconciled</div>
                <div className="font-semibold">{recon == null ? '-' : `${fmt(recon, 2)} ${selectedMetric?.unit || ''}`}</div>
              </div>
              <div>
                <div className="text-xs opacity-70">Delta</div>
                <div className={`font-semibold ${delta != null && delta < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {delta == null ? '-' : `${fmt(delta, 2)} ${selectedMetric?.unit || ''}`}
                </div>
              </div>
            </div>
            {summary?.allocations?.length ? (
              <div className="mt-3 text-xs opacity-70">
                Allocations created: {summary.allocations.length} day(s). Example: {summary.allocations[0].date} → {fmt(summary.allocations[0].allocated_value, 4)}
              </div>
            ) : summary?.reconciliation?.id ? (
              <div className="mt-3 text-xs opacity-70">Saved reconciliation found. Day allocations loaded: {(summary.allocations || []).length}.</div>
            ) : (
              <div className="mt-3 text-xs opacity-70">No reconciliation saved for this month/metric yet.</div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={`px-4 py-2 rounded-xl text-white ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              style={{ background: 'var(--brand)' }}
              onClick={save}
              disabled={loading || isLocked}
            >
              Save
            </button>
            <button
              className={`px-4 py-2 rounded-xl border bg-[color:var(--card)] ${!summary?.reconciliation || isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={recalc}
              disabled={loading || !summary?.reconciliation || isLocked}
            >
              Recalculate
            </button>
            {summary?.reconciliation && (
              <button
                className="px-4 py-2 rounded-xl border bg-[color:var(--card)]"
                onClick={() => setLock(!isLocked)}
                disabled={loading}
              >
                {isLocked ? 'Unlock' : 'Lock'}
              </button>
            )}
            {loading && <div className="text-sm opacity-70 self-center">Working…</div>}

          </div>
        </div>
      </div>

      {/* Factors tools */}
      <div className="mt-4 rounded-2xl border bg-[color:var(--card)]" style={{ borderColor: '#e9d9c3' }}>
        <div className="p-4 border-b" style={{ borderColor: '#f0e4d4' }}>
          <div className="text-lg font-semibold">Factors</div>
          <div className="text-xs opacity-70">
            Use reconciled ore tonnes (Prod + Dev) to solve unit factors for the month.
          </div>
        </div>
        <div className="p-4 flex flex-wrap gap-2">
          <button
            className="px-4 py-2 rounded-xl border bg-[color:var(--card)]"
            onClick={openBucketFactors}
            disabled={loading || !site || site === '*'}
            title="Solve bucket factors (t/bkt) for loaders from reconciled ore tonnes and loading primary buckets"
          >
            Bucket factors…
          </button>
          <button
            className="px-4 py-2 rounded-xl border bg-[color:var(--card)]"
            onClick={openTruckFactors}
            disabled={loading || !site || site === '*'}
            title="Solve truck factors (t/truck) for trucks from reconciled ore tonnes and hauling truck counts"
          >
            Truck factors…
          </button>
        </div>
      </div>

      {showBuckets && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}>
          <div className="w-full max-w-3xl bg-[var(--card)] rounded-2xl shadow-xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="p-4 border-b" style={{ borderColor: '#f0e4d4' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">Bucket factors</div>
                  <div className="text-xs opacity-70">
                    Model 1 (shared factor per bucket config). Uses reconciled ore tonnes hauled (Prod + Dev) and loading primary buckets grouped by config.
                  </div>
                </div>
                <button className="px-3 py-1.5 rounded-xl border bg-[color:var(--card)]" onClick={() => setShowBuckets(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="p-4">
              {bucketLoading ? (
                <div className="text-sm opacity-70">Working…</div>
              ) : (
                <>
                  <div className="p-3 rounded-xl border bg-[color:var(--card)]" style={{ borderColor: '#f0e4d4' }}>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                      <div>
                        <div className="text-xs opacity-70">Month</div>
                        <div className="font-semibold">{monthYm}</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Site</div>
                        <div className="font-semibold">{site}</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Reconciled Prod tonnes</div>
                        <div className="font-semibold">{bucketData?.reconciled?.prod == null ? '-' : fmt(bucketData.reconciled.prod, 2)} t</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Reconciled Dev tonnes</div>
                        <div className="font-semibold">{bucketData?.reconciled?.dev == null ? '-' : fmt(bucketData.reconciled.dev, 2)} t</div>
                      </div>
                    </div>
                    {bucketData?.solved?.notes?.warning && (
                      <div className="mt-2 text-xs text-amber-700">{bucketData.solved.notes.warning}</div>
                    )}
                  </div>

                  <div className="mt-3 overflow-auto border rounded-xl" style={{ borderColor: '#f0e4d4' }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs opacity-70 border-b" style={{ borderColor: '#f0e4d4' }}>
                          <th className="text-left p-2">Loader</th>
                          <th className="text-left p-2">Config</th>
                          <th className="text-right p-2">Est (t/bkt)</th>
                          <th className="text-center p-2">Lock</th>
                          <th className="text-right p-2">Prod buckets</th>
                          <th className="text-right p-2">Dev buckets</th>
                          <th className="text-right p-2">Min (t/bkt)</th>
                          <th className="text-right p-2">Max (t/bkt)</th>
                          <th className="text-right p-2">Factor (t/bkt)</th>
                          <th className="text-right p-2">Prod t (calc)</th>
                          <th className="text-right p-2">Dev t (calc)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          Array.isArray(bucketData?.solved?.loaders)
                            ? bucketData.solved.loaders
                            : Array.isArray(bucketData?.loaders)
                              ? bucketData.loaders
                              : Array.isArray(bucketData?.saved)
                                ? bucketData.saved
                                : []
                        ).map((r: any) => {
                          const id = String(r.loader_id || '').trim();
                          const cfgCode = (bucketAssignments[id] || String(r.config_code || '').trim() || id).trim() || id;
                          const cfg = bucketConfigs[cfgCode] || { estimate: '', min: '', max: '', lock: false };
                          const factor = r.factor != null ? Number(r.factor) : (r.config_factor != null ? Number(r.config_factor) : null);
                          return (
                            <tr key={id} className="border-b" style={{ borderColor: '#f0e4d4' }}>
                              <td className="p-2 font-semibold">{id}</td>

                              <td className="p-2">
                                <input
                                  className="w-28 p-1 rounded-lg border bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfgCode}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setBucketAssignments((prev: any) => ({ ...(prev || {}), [id]: v }));
                                    setBucketConfigs((prev: any) => {
                                      const next = { ...(prev || {}) };
                                      const key = String(v || '').trim();
                                      if (key && !next[key]) next[key] = { estimate: '', min: '', max: '', lock: false };
                                      return next;
                                    });
                                  }}
                                />
                              </td>

                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.estimate}
                                  onChange={(e) =>
                                    setBucketConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), estimate: e.target.value },
                                    }))
                                  }
                                  placeholder=""
                                />
                              </td>

                              <td className="p-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={!!cfg.lock}
                                  onChange={(e) =>
                                    setBucketConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), lock: e.target.checked },
                                    }))
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">{fmt(r.prod_buckets ?? 0, 0)}</td>
                              <td className="p-2 text-right">{fmt(r.dev_buckets ?? 0, 0)}</td>

                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.min}
                                  onChange={(e) =>
                                    setBucketConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), min: e.target.value },
                                    }))
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.max}
                                  onChange={(e) =>
                                    setBucketConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), max: e.target.value },
                                    }))
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">{factor == null ? '' : fmt(factor, 4)}</td>
                              <td className="p-2 text-right">{fmt(r.prod_tonnes_pred ?? r.prod_tonnes ?? 0, 2)}</td>
                              <td className="p-2 text-right">{fmt(r.dev_tonnes_pred ?? r.dev_tonnes ?? 0, 2)}</td>
                            </tr>
                          );
                        })}                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 p-3 rounded-xl border bg-[color:var(--card)]" style={{ borderColor: '#f0e4d4' }}>
                    <div className="text-xs opacity-70 mb-1">How it’s calculated</div>
                    <div className="text-sm">
                      We assign each loader to a <span className="font-semibold">bucket config</span>. All loaders in the same config share one factor <span className="font-semibold">f₍config₎</span> (t/bucket).
                      We solve the system:
                      <div className="mt-1 text-xs opacity-80">
                        Σ(prodBuckets₍config₎ × f₍config₎) = reconciled production ore tonnes &nbsp; and &nbsp; Σ(devBuckets₍config₎ × f₍config₎) = reconciled development ore tonnes.
                      </div>
                      <div className="mt-1 text-xs opacity-80">Constraints: f ≥ 0, optional per-config bounds, and optional lock-to-estimate. and optional per-loader bounds you enter above.</div>
                    </div>
                    {bucketData?.solved?.totals && bucketData?.solved?.reconciled && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <div className="text-xs opacity-70">Prod predicted vs reconciled</div>
                          <div className="font-semibold">
                            {fmt(bucketData.solved.totals?.prod_pred ?? 0, 2)} t / {fmt(bucketData.solved.reconciled.prod ?? 0, 2)} t
                          </div>
                          <div className="text-xs opacity-80">
                            Residual: {fmt(bucketData.solved.residuals?.prod ?? 0, 2)} t
                            {bucketData.solved.reconciled.prod ? ` (${fmt(((bucketData.solved.residuals?.prod ?? 0) / bucketData.solved.reconciled.prod) * 100, 2)}%)` : ''}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs opacity-70">Dev predicted vs reconciled</div>
                          <div className="font-semibold">
                            {fmt(bucketData.solved.totals?.dev_pred ?? 0, 2)} t / {fmt(bucketData.solved.reconciled.dev ?? 0, 2)} t
                          </div>
                          <div className="text-xs opacity-80">
                            Residual: {fmt(bucketData.solved.residuals?.dev ?? 0, 2)} t
                            {bucketData.solved.reconciled.dev ? ` (${fmt(((bucketData.solved.residuals?.dev ?? 0) / bucketData.solved.reconciled.dev) * 100, 2)}%)` : ''}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      className="px-4 py-2 rounded-xl text-white"
                      style={{ background: 'var(--brand)' }}
                      onClick={() => solveBucketFactors(false)}
                      disabled={bucketLoading}
                    >
                      Recalculate
                    </button>
                    <button
                      className="px-4 py-2 rounded-xl border bg-[color:var(--card)]"
                      onClick={() => solveBucketFactors(true)}
                      disabled={bucketLoading}
                      title="Saves bounds + factors to the database for this month"
                    >
                      Save factors
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showTrucks && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }}>
          <div className="w-full max-w-3xl bg-[var(--card)] rounded-2xl shadow-xl border" style={{ borderColor: '#e9d9c3' }}>
            <div className="p-4 border-b" style={{ borderColor: '#f0e4d4' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">Truck factors</div>
                  <div className="text-xs opacity-70">
                    Model 1 (shared factor per truck config). Uses reconciled ore tonnes hauled (Prod + Dev) and hauling truck counts grouped by config.
                  </div>
                </div>
                <button className="px-3 py-1.5 rounded-xl border bg-[color:var(--card)]" onClick={() => setShowTrucks(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="p-4">
              {truckLoading ? (
                <div className="text-sm opacity-70">Working…</div>
              ) : (
                <>
                  <div className="p-3 rounded-xl border bg-[color:var(--card)]" style={{ borderColor: '#f0e4d4' }}>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                      <div>
                        <div className="text-xs opacity-70">Month</div>
                        <div className="font-semibold">{monthYm}</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Site</div>
                        <div className="font-semibold">{site}</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Reconciled Prod tonnes</div>
                        <div className="font-semibold">{truckData?.reconciled?.prod == null ? '-' : fmt(truckData.reconciled.prod, 2)} t</div>
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Reconciled Dev tonnes</div>
                        <div className="font-semibold">{truckData?.reconciled?.dev == null ? '-' : fmt(truckData.reconciled.dev, 2)} t</div>
                      </div>
                    </div>
                    {truckData?.solved?.notes?.warning && <div className="mt-2 text-xs text-amber-700">{truckData.solved.notes.warning}</div>}
                  </div>

                  <div className="mt-3 overflow-auto border rounded-xl" style={{ borderColor: '#f0e4d4' }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs opacity-70 border-b" style={{ borderColor: '#f0e4d4' }}>
                          <th className="text-left p-2">Truck</th>
                          <th className="text-left p-2">Config</th>
                          <th className="text-right p-2">Est (t/trk)</th>
                          <th className="text-center p-2">Lock</th>
                          <th className="text-right p-2">Prod trucks</th>
                          <th className="text-right p-2">Dev ore trucks</th>
                          <th className="text-right p-2">Min (t/trk)</th>
                          <th className="text-right p-2">Max (t/trk)</th>
                          <th className="text-right p-2">Factor (t/trk)</th>
                          <th className="text-right p-2">Prod t (calc)</th>
                          <th className="text-right p-2">Dev t (calc)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          Array.isArray(truckData?.solved?.trucks)
                            ? truckData.solved.trucks
                            : Array.isArray(truckData?.trucks)
                              ? truckData.trucks
                              : Array.isArray(truckData?.saved)
                                ? truckData.saved
                                : []
                        ).map((r: any) => {
                          const id = String(r.truck_id || '').trim();
                          const cfgCode = (truckAssignments[id] || String(r.config_code || '').trim() || id).trim() || id;
                          const cfg = truckConfigs[cfgCode] || { estimate: '', min: '', max: '', lock: false };
                          const factor = r.factor != null ? Number(r.factor) : (r.config_factor != null ? Number(r.config_factor) : null);
                          const prodTrk = Number(r.prod_trucks ?? r.prod_trk ?? r.prod ?? 0);
                          const devTrk = Number(r.dev_trucks ?? r.dev_trk ?? r.dev ?? 0);
                          return (
                            <tr key={id} className="border-b" style={{ borderColor: '#f0e4d4' }}>
                              <td className="p-2 font-semibold">{id}</td>
                              <td className="p-2">
                                <input
                                  className="w-28 p-1 rounded-lg border bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfgCode}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setTruckAssignments((prev: any) => ({ ...(prev || {}), [id]: v }));
                                    setTruckConfigs((prev: any) => {
                                      const next = { ...(prev || {}) };
                                      const key = String(v || '').trim();
                                      if (key && !next[key]) next[key] = { estimate: '', min: '', max: '', lock: false };
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.estimate}
                                  onChange={(e) =>
                                    setTruckConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), estimate: e.target.value },
                                    }))
                                  }
                                />
                              </td>
                              <td className="p-2 text-center">
                                <input
                                  type="checkbox"
                                  checked={!!cfg.lock}
                                  onChange={(e) =>
                                    setTruckConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), lock: e.target.checked },
                                    }))
                                  }
                                />
                              </td>
                              <td className="p-2 text-right">{fmt(prodTrk, 2)}</td>
                              <td className="p-2 text-right">{fmt(devTrk, 2)}</td>
                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.min}
                                  onChange={(e) =>
                                    setTruckConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), min: e.target.value },
                                    }))
                                  }
                                />
                              </td>
                              <td className="p-2 text-right">
                                <input
                                  className="w-24 p-1 rounded-lg border text-right bg-[color:var(--card)]"
                                  style={{ borderColor: '#f0e4d4' }}
                                  value={cfg.max}
                                  onChange={(e) =>
                                    setTruckConfigs((prev: any) => ({
                                      ...(prev || {}),
                                      [cfgCode]: { ...(prev?.[cfgCode] || cfg), max: e.target.value },
                                    }))
                                  }
                                />
                              </td>
                              <td className="p-2 text-right font-semibold">{factor == null ? '-' : fmt(factor, 4)}</td>
                              <td className="p-2 text-right">{factor == null ? '-' : fmt(prodTrk * factor, 2)}</td>
                              <td className="p-2 text-right">{factor == null ? '-' : fmt(devTrk * factor, 2)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 p-3 rounded-xl border bg-[color:var(--card)] text-xs" style={{ borderColor: '#f0e4d4' }}>
                    <div className="opacity-80">
                      We assign each truck to a <span className="font-semibold">truck config</span>. All trucks in the same config share one factor <span className="font-semibold">f₍config₎</span> (t/truck).
                      We solve the system:
                      <div className="mt-1 text-xs opacity-80">
                        Σ(prodTrucks₍config₎ × f₍config₎) = reconciled production ore tonnes &nbsp; and &nbsp; Σ(devOreTrucks₍config₎ × f₍config₎) = reconciled development ore tonnes.
                      </div>
                      <div className="mt-1 text-xs opacity-80">Constraints: f ≥ 0, optional per-config bounds, and optional lock-to-estimate.</div>
                    </div>
                    {truckData?.solved?.totals && truckData?.solved?.reconciled && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <div className="text-xs opacity-70">Prod predicted vs reconciled</div>
                          <div className="font-semibold">
                            {fmt(truckData.solved.totals?.prod_pred ?? 0, 2)} t / {fmt(truckData.solved.reconciled.prod ?? 0, 2)} t
                          </div>
                          <div className="text-xs opacity-80">
                            Residual: {fmt(truckData.solved.residuals?.prod ?? 0, 2)} t
                            {truckData.solved.reconciled.prod ? ` (${fmt(((truckData.solved.residuals?.prod ?? 0) / truckData.solved.reconciled.prod) * 100, 2)}%)` : ''}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs opacity-70">Dev predicted vs reconciled</div>
                          <div className="font-semibold">
                            {fmt(truckData.solved.totals?.dev_pred ?? 0, 2)} t / {fmt(truckData.solved.reconciled.dev ?? 0, 2)} t
                          </div>
                          <div className="text-xs opacity-80">
                            Residual: {fmt(truckData.solved.residuals?.dev ?? 0, 2)} t
                            {truckData.solved.reconciled.dev ? ` (${fmt(((truckData.solved.residuals?.dev ?? 0) / truckData.solved.reconciled.dev) * 100, 2)}%)` : ''}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      className="px-4 py-2 rounded-xl text-white"
                      style={{ background: 'var(--brand)' }}
                      onClick={() => solveTruckFactors(false)}
                      disabled={truckLoading}
                    >
                      Recalculate
                    </button>
                    <button
                      className="px-4 py-2 rounded-xl border bg-[color:var(--card)]"
                      onClick={() => solveTruckFactors(true)}
                      disabled={truckLoading}
                      title="Saves bounds + factors to the database for this month"
                    >
                      Save factors
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
