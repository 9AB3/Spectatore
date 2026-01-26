import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';

type BillingStatus = {
  ok?: boolean;
  enforced?: boolean;
  allowed?: boolean;
  subscription_status?: string | null;
  subscription_interval?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  billing_exempt?: boolean;
  is_admin?: boolean;
  dev_bypass?: boolean;
};

export default function Subscribe() {
  const nav = useNavigate();
  const location = useLocation();
  type StripePrice = {
    id?: string;
    active?: boolean;
    currency?: string;
    unit_amount?: number | null;
    unit_amount_decimal?: string | null;
    recurring?: { interval?: string | null; interval_count?: number | null } | null;
    nickname?: string | null;
    product?: { id?: string; name?: string | null } | null;
  };

  const [prices, setPrices] = useState<{ ok?: boolean; monthly?: StripePrice; yearly?: StripePrice; error?: string } | null>(null);

  const moneyFmt = useMemo(() => {
    const c = (prices?.monthly?.currency || prices?.yearly?.currency || 'aud').toUpperCase();
    return {
      currency: c,
      fmt: (major: number) => {
        try {
          return new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(major);
        } catch {
          // Fallback if an invalid currency code is provided
          return `${c} ${major.toFixed(2)}`;
        }
      },
    };
  }, [prices?.monthly?.currency, prices?.yearly?.currency]);

  const monthlyMajor = useMemo(() => {
    const ua = prices?.monthly?.unit_amount;
    return typeof ua === 'number' ? ua / 100 : null;
  }, [prices?.monthly?.unit_amount]);

  const yearlyMajor = useMemo(() => {
    const ua = prices?.yearly?.unit_amount;
    return typeof ua === 'number' ? ua / 100 : null;
  }, [prices?.yearly?.unit_amount]);

  const yearlyPerMonth = useMemo(() => {
    if (typeof yearlyMajor !== 'number') return null;
    return yearlyMajor / 12;
  }, [yearlyMajor]);

  const savingsPct = useMemo(() => {
    if (typeof monthlyMajor !== 'number' || typeof yearlyPerMonth !== 'number') return 0;
    return Math.max(0, Math.round((1 - yearlyPerMonth / monthlyMajor) * 100));
  }, [monthlyMajor, yearlyPerMonth]);
  const monthlyLabel = useMemo(() => {
    if (typeof monthlyMajor !== 'number') return 'Monthly';
    return `Monthly — ${moneyFmt.fmt(monthlyMajor)}/month`;
  }, [monthlyMajor, moneyFmt]);

  const yearlyLabel = useMemo(() => {
    if (typeof yearlyMajor !== 'number') return 'Yearly';
    let s = `Yearly — ${moneyFmt.fmt(yearlyMajor)}/year`;
    if (typeof yearlyPerMonth === 'number') {
      s += ` (≈ ${moneyFmt.fmt(yearlyPerMonth)}/month`;
      if (savingsPct) s += `, save ${savingsPct}%`;
      s += ')';
    }
    return s;
  }, [yearlyMajor, yearlyPerMonth, savingsPct, moneyFmt]);



  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const result = (query.get('result') || '').toLowerCase(); // success | cancel | ""
  const cameFromSuccess = result === 'success';

  const [st, setSt] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function logout() {
    try {
      const db = await getDB();
      await db.delete('session', 'auth');
    } catch {
      // ignore
    }
    nav('/Home', { replace: true });
  }

  async function fetchPrices() {
    try {
      const r: any = await api('/api/billing/prices');
      setPrices(r || null);
      return r;
    } catch {
      setPrices({ ok: false, error: 'Could not load pricing' });
      return null;
    }
  }

  async function fetchStatus() {
    const r: any = await api('/api/billing/status');
    setSt(r || null);
    return r as BillingStatus;
  }

  async function startCheckout(interval: 'month' | 'year') {
    setErr('');
    setBusy(true);
    try {
      const r: any = await api('/api/billing/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ interval }),
      });
      if (r?.url) window.location.href = r.url;
      else setErr(r?.error || 'Could not start checkout');
    } catch {
      setErr('Could not start checkout');
    } finally {
      setBusy(false);
    }
  }

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

  // Initial fetch + redirect if already allowed.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await fetchPrices();
        const r = await fetchStatus();
        if (!mounted) return;

        // If billing is not enforced, this page is unnecessary.
        if (!r?.enforced) {
          nav('/Main', { replace: true });
          return;
        }

        if (r?.allowed) {
          nav('/Main', { replace: true });
          return;
        }
      } catch {
        // If status fails, don't dead-end the user – send them to the app.
        nav('/Main', { replace: true });
        return;
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [location.key]);

  // Poll after returning from successful checkout until webhook marks the subscription active.
  useEffect(() => {
    if (!cameFromSuccess) return;
    if (!st?.enforced) return;
    if (st?.allowed) return;

    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetchStatus();
        if (stopped) return;
        if (r?.allowed) {
          nav('/Main', { replace: true });
        }
      } catch {
        // ignore transient failures
      }
    };

    // Poll fast initially.
    const i = setInterval(tick, 2000);
    // And do an immediate tick.
    tick();

    return () => {
      stopped = true;
      clearInterval(i);
    };
  }, [cameFromSuccess, st?.enforced, st?.allowed]);

  const statusLabel = String(st?.subscription_status || 'none');

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-xl">
          <div className="text-xl font-semibold">Checking subscription…</div>
          <div className="mt-2 text-sm text-neutral-300">One moment.</div>
        </div>
      </div>
    );
  }

  // If user just paid, show unlocking state (even if still not active yet).
  if (cameFromSuccess && st?.enforced && !st?.allowed) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-xl">
          <div className="text-2xl font-semibold">Unlocking your account…</div>
          <div className="mt-2 text-sm text-neutral-300">
            We’re waiting for Stripe to confirm your subscription. This usually takes only a few seconds.
          </div>

          <div className="mt-4 rounded-xl bg-neutral-950/40 border border-neutral-800 p-3 text-xs text-neutral-300">
            Status: <span className="text-neutral-100">{statusLabel}</span>
            {st?.current_period_end ? (
              <div className="mt-1">
                Paid until: <span className="text-neutral-100">{new Date(st.current_period_end).toLocaleString()}</span>
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-100" />
            <div className="text-sm text-neutral-300">Checking…</div>
          </div>

          {err ? <div className="mt-4 text-sm text-red-400">{err}</div> : null}

          <div className="mt-6 grid grid-cols-1 gap-3">
            <button
              disabled={busy}
              onClick={openPortal}
              className="rounded-xl border border-neutral-700 hover:bg-neutral-800/50 disabled:opacity-60 px-4 py-3 font-semibold"
            >
              Manage subscription
            </button>
            <button
              disabled={busy}
              onClick={logout}
              className="rounded-xl text-neutral-300 hover:text-neutral-100 px-4 py-2"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default paywall state
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-xl">
        <div className="text-2xl font-semibold">Subscription required</div>
        <div className="mt-2 text-sm text-neutral-300">
          This account needs an active subscription before you can access Spectatore.
        </div>

        <div className="mt-4 rounded-xl bg-neutral-950/40 border border-neutral-800 p-3 text-xs text-neutral-300">
          Status: <span className="text-neutral-100">{statusLabel}</span>
          {st?.current_period_end ? (
            <div className="mt-1">
              Paid until: <span className="text-neutral-100">{new Date(st.current_period_end).toLocaleString()}</span>
            </div>
          ) : null}
        </div>

        {err ? <div className="mt-4 text-sm text-red-400">{err}</div> : null}

        <div className="mt-5 grid grid-cols-1 gap-3">
          <button
            disabled={busy}
            onClick={() => startCheckout('month')}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-4 py-3 font-semibold"
          >
            {monthlyLabel}
          </button>
          <button
            disabled={busy}
            onClick={() => startCheckout('year')}
            className="rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-3 font-semibold"
          >
            {yearlyLabel}
          </button>
          <button
            disabled={busy}
            onClick={openPortal}
            className="rounded-xl border border-neutral-700 hover:bg-neutral-800/50 disabled:opacity-60 px-4 py-3 font-semibold"
          >
            Manage subscription
          </button>
          <button
            disabled={busy}
            onClick={logout}
            className="rounded-xl text-neutral-300 hover:text-neutral-100 px-4 py-2"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}