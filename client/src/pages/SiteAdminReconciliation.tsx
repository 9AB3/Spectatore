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
                className="w-full p-2 rounded-xl border bg-white"
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
                className="w-full p-2 rounded-xl border bg-white"
                value={monthYm}
                onChange={(e) => setMonthYm(e.target.value)}
              />
            </div>

            <div className="sm:col-span-2">
              <div className="text-xs font-semibold mb-1">Metric</div>
              <select
                className="w-full p-2 rounded-xl border bg-white"
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
                className="w-full p-2 rounded-xl border bg-white"
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
                className="w-full p-2 rounded-xl border bg-white"
                value={reconciledTotal}
                onChange={(e) => setReconciledTotal(e.target.value)}
                placeholder="e.g. 300"
                disabled={isLocked}
              />
            </div>
          </div>

          <div className="mt-4 p-3 rounded-xl border bg-white" style={{ borderColor: '#f0e4d4' }}>
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
              className={`px-4 py-2 rounded-xl border bg-white ${!summary?.reconciliation || isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={recalc}
              disabled={loading || !summary?.reconciliation || isLocked}
            >
              Recalculate
            </button>
            {summary?.reconciliation && (
              <button
                className="px-4 py-2 rounded-xl border bg-white"
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
    </div>
  );
}
