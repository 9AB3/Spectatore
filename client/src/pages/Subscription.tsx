import Header from '../components/Header';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type BillingStatus = {
  ok?: boolean;
  enforced?: boolean;
  allowed?: boolean;
  subscription_status?: string | null;
  subscription_interval?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  scheduled_change?: {
    type?: 'plan_change' | 'cancel' | string | null;
    current_interval?: string | null;
    target_interval?: string | null;
    effective_at?: string | null;
    schedule_id?: string | null;
    source?: string | null;
  } | null;
  billing_exempt?: boolean;
  is_admin?: boolean;
  dev_bypass?: boolean;
};

function fmtDate(iso?: string | null) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  } catch {
    return String(iso);
  }
}

export default function Subscription() {
  const nav = useNavigate();
  const [st, setSt] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [planMsg, setPlanMsg] = useState('');

  const planLabel = useMemo(() => {
    const interval = (st?.subscription_interval || '').toLowerCase();
    if (interval === 'month') return 'Monthly';
    if (interval === 'year') return 'Yearly';
    return interval ? interval : '—';
  }, [st?.subscription_interval]);


const upcomingLabel = useMemo(() => {
  const sc: any = (st as any)?.scheduled_change;
  if (!sc || !sc.type) return 'None';
  const eff = fmtDate(sc.effective_at);
  if (sc.type === 'plan_change') {
    const tgt = String(sc.target_interval || '').toLowerCase();
    const tgtLabel = tgt === 'month' ? 'Monthly' : tgt === 'year' ? 'Yearly' : (sc.target_interval || '');
    return `Switching to ${tgtLabel}${eff ? ` on ${eff}` : ''}`;
  }
  if (sc.type === 'cancel') {
    return `Cancels${eff ? ` on ${eff}` : ''}`;
  }
  return eff ? `${sc.type} on ${eff}` : String(sc.type);
}, [st]);

const hasScheduledPlanChange = useMemo(() => {
  const sc: any = (st as any)?.scheduled_change;
  return !!sc && sc.type === 'plan_change';
}, [st]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r: any = await api('/api/billing/status');
        if (cancelled) return;
        setSt(r || null);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || 'Could not load subscription');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openPortal() {
    setErr('');
    setBusy(true);
    try {
      const r: any = await api('/api/billing/create-portal-session', { method: 'POST' });
      if (r?.url) window.location.href = r.url;
      else setErr(r?.error || 'Could not open billing portal');
    } catch {
      setErr('Could not open billing portal');
    } finally {
      setBusy(false);
    }
  }

  async function changePlan(interval: 'month' | 'year') {
    setErr('');
    setPlanMsg('');
    setPlanBusy(true);
    try {
      const r: any = await api('/api/billing/change-plan', {
        method: 'POST',
        body: JSON.stringify({ interval }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (r?.ok) {
        // For upgrades we redirect into Stripe's confirmation flow.
        if (r?.redirect && r?.url) {
          window.location.href = r.url;
          return;
        }

        setPlanMsg(r?.message || 'Plan update scheduled');
        const s: any = await api('/api/billing/status');
        setSt(s || null);
      } else {
        setErr(r?.error || 'Could not update plan');
      }
    } catch (e: any) {
      setErr(e?.message || 'Could not update plan');
    } finally {
      setPlanBusy(false);
    }
  }

  return (
    <div className="app">
      <Header title="My Subscription" />
      <div className="p-4 max-w-2xl mx-auto">
        <div className="card">
          <div className="text-xs tracking-wider uppercase opacity-70">Billing</div>
          <div className="text-lg font-semibold mt-1">Subscription details</div>

          {loading ? (
            <div className="text-sm opacity-70 mt-3">Loading…</div>
          ) : (
            <>
              {err ? <div className="text-sm text-red-400 mt-3">{err}</div> : null}

              <div className="grid gap-2 mt-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="opacity-70">Status</div>
                  <div className="font-medium">{st?.subscription_status || 'none'}</div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="opacity-70">Plan</div>
                  <div className="font-medium">{planLabel}</div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="opacity-70">Renews</div>
                  <div className="font-medium">{fmtDate(st?.current_period_end) || '—'}</div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="opacity-70">Cancel at period end</div>
                  <div className="font-medium">{st?.cancel_at_period_end ? 'Yes' : 'No'}</div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="opacity-70">Upcoming changes</div>
                  <div className="font-medium">{upcomingLabel}</div>
                </div>
              </div>

            <div className="mt-4 pt-4 border-t border-zinc-200/10">
              <div className="text-sm font-semibold mb-2">Change plan</div>
              <div className="text-xs opacity-70 mb-3">
                Yearly → Monthly changes are scheduled to start at your next renewal so you aren’t charged again immediately.
                Monthly → Yearly upgrades open Stripe for confirmation and will charge immediately.
              </div>

              <div className="flex flex-wrap gap-2">
                {hasScheduledPlanChange ? (
                  <div className="text-xs opacity-70 w-full">A plan change is already scheduled. You can manage or cancel it in the billing portal.</div>
                ) : null}
                {st?.subscription_interval === 'year' ? (
                  <button type="button" className="btn" disabled={planBusy || hasScheduledPlanChange} onClick={() => changePlan('month')}>
                    {planBusy ? 'Updating…' : 'Switch to Monthly'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={planBusy || hasScheduledPlanChange}
                    onClick={() => {
                      const ok = window.confirm(
                        'Upgrading to Yearly will charge your payment method immediately. Continue to Stripe to confirm?'
                      );
                      if (!ok) return;
                      changePlan('year');
                    }}
                  >
                    {planBusy ? 'Updating…' : 'Switch to Yearly'}
                  </button>
                )}
              </div>

              {planMsg ? <div className="text-xs opacity-80 mt-2">{planMsg}</div> : null}
            </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="btn" onClick={openPortal} disabled={busy}>
                  {busy ? 'Opening…' : 'Manage subscription'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => nav('/Settings')}>
                  Back to Settings
                </button>
              </div>

              {st?.enforced === false ? (
                <div className="text-xs opacity-60 mt-3">
                  Note: billing enforcement is currently disabled on this environment.
                </div>
              ) : null}
              {st?.billing_exempt ? (
                <div className="text-xs opacity-60 mt-1">This account is billing-exempt.</div>
              ) : null}
              {st?.dev_bypass ? (
                <div className="text-xs opacity-60 mt-1">Dev bypass is enabled for this account.</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
