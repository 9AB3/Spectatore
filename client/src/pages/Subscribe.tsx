import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import { track } from '../lib/analytics';

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
      // GA: begin checkout + remember what the user picked so we can send purchase after Stripe redirects back.
      const picked = interval === 'year' ? prices?.yearly : prices?.monthly;
      const price_id = String(picked?.id || '');
      const currency = String((picked?.currency || 'AUD')).toUpperCase();
      const unit_amount = typeof picked?.unit_amount === 'number' ? picked!.unit_amount : null; // cents
      const value = typeof unit_amount === 'number' ? unit_amount / 100 : undefined;

      if (price_id) track.beginCheckout(price_id);

      try {
        sessionStorage.setItem(
          'spectatore_last_checkout',
          JSON.stringify({ price_id, interval, currency, value, ts: Date.now() }),
        );
        sessionStorage.removeItem('spectatore_purchase_sent');
      } catch {
        // ignore
      }
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
          // GA: purchase (fire once after Stripe success)
          try {
            const already = sessionStorage.getItem('spectatore_purchase_sent') === '1';
            const raw = sessionStorage.getItem('spectatore_last_checkout');
            const last = raw ? JSON.parse(raw) : null;
            const fresh = last?.ts && Date.now() - Number(last.ts) < 1000 * 60 * 60; // 1h
            if (!already && fresh) {
              track.purchase(last.price_id, typeof last.value === 'number' ? last.value : undefined, last.currency || 'AUD');
              sessionStorage.setItem('spectatore_purchase_sent', '1');
            }
          } catch {
            // ignore
          }
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

  const periodEndLabel = useMemo(() => {
    if (!st?.current_period_end) return '';
    try {
      return new Date(st.current_period_end).toLocaleString();
    } catch {
      return String(st.current_period_end);
    }
  }, [st?.current_period_end]);

  if (loading) {
    return (
      <div className="w-full flex items-center justify-center p-4" style={{ minHeight: '100dvh' }}>
        <div className="w-full max-w-3xl">
          <div className="card">
            <div className="flex items-center justify-between gap-3">
              <div className="text-2xl font-semibold">Subscription</div>
              <span className="tv-pill">Status: {statusLabel}</span>
            </div>
            <div className="mt-2 text-sm tv-muted">Checking your subscription…</div>
            <div className="mt-5 flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[color:var(--hairline)] border-t-[color:var(--text)]" />
              <div className="text-sm tv-muted">One moment.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If user just paid, show unlocking state (even if still not active yet).
  if (cameFromSuccess && st?.enforced && !st?.allowed) {
    return (
      <div className="w-full flex items-center justify-center p-4" style={{ minHeight: '100dvh' }}>
        <div className="w-full max-w-3xl">
          <div className="card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-2xl font-semibold">Unlocking your account</div>
                <div className="mt-2 text-sm tv-muted">
                  We’re waiting for Stripe to confirm your subscription. This usually takes only a few seconds.
                </div>
              </div>
              <span className="tv-pill">Status: {statusLabel}</span>
            </div>

            {periodEndLabel ? (
              <div className="mt-4 text-xs tv-muted">
                Paid until: <span className="font-semibold" style={{ color: 'var(--text)' }}>{periodEndLabel}</span>
              </div>
            ) : null}

            <div className="mt-5 flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[color:var(--hairline)] border-t-[color:var(--text)]" />
              <div className="text-sm tv-muted">Checking…</div>
            </div>

            {err ? <div className="mt-4 text-sm" style={{ color: 'var(--bad)' }}>{err}</div> : null}

            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <button disabled={busy} onClick={openPortal} className="btn">
                Manage subscription
              </button>
              <button disabled={busy} onClick={logout} className="btn" style={{ background: 'var(--bg-elev)', color: 'var(--text)', border: '1px solid var(--hairline)' }}>
                Log out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Default paywall state
  return (
    <div className="w-full flex items-center justify-center p-4" style={{ minHeight: '100dvh' }}>
      <div className="w-full max-w-3xl">
        <div className="card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-2xl font-semibold">Subscription</div>
              <div className="mt-2 text-sm tv-muted">
                This account needs an active subscription before you can access Spectatore.
              </div>
            </div>
            <span className="tv-pill">Status: {statusLabel}</span>
          </div>

          {periodEndLabel ? (
            <div className="mt-3 text-xs tv-muted">
              Paid until: <span className="font-semibold" style={{ color: 'var(--text)' }}>{periodEndLabel}</span>
            </div>
          ) : null}

          {prices?.error ? (
            <div className="mt-3 text-sm" style={{ color: 'var(--warn)' }}>{prices.error}</div>
          ) : null}

          {err ? <div className="mt-4 text-sm" style={{ color: 'var(--bad)' }}>{err}</div> : null}

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="tv-tile tv-hoverable">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">Monthly</div>
                  <div className="mt-1 text-sm tv-muted">
                    {typeof monthlyMajor === 'number' ? `${moneyFmt.fmt(monthlyMajor)} / month` : 'Loading price…'}
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <button disabled={busy} onClick={() => startCheckout('month')} className="btn w-full">
                  Choose Monthly
                </button>
              </div>
            </div>

            <div className="tv-tile tv-hoverable" style={{ borderColor: 'rgba(184, 135, 47, 0.35)' }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-lg font-semibold">Yearly</div>
                    <span className="tv-pill" style={{ background: 'rgba(184, 135, 47, 0.18)', borderColor: 'rgba(184, 135, 47, 0.35)' }}>
                      Recommended
                    </span>
                  </div>
                  <div className="mt-1 text-sm tv-muted">
                    {typeof yearlyMajor === 'number' ? `${moneyFmt.fmt(yearlyMajor)} / year` : 'Loading price…'}
                  </div>
                  {typeof yearlyPerMonth === 'number' ? (
                    <div className="mt-1 text-xs tv-muted">
                      ≈ {moneyFmt.fmt(yearlyPerMonth)} / month{typeof savingsPct === 'number' && savingsPct > 0 ? ` • Save ~${savingsPct}%` : ''}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="mt-4">
                <button disabled={busy} onClick={() => startCheckout('year')} className="btn btn-secondary w-full">
                  Choose Yearly
                </button>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <button disabled={busy} onClick={openPortal} className="btn" style={{ background: 'var(--bg-elev)', color: 'var(--text)', border: '1px solid var(--hairline)' }}>
              Manage subscription
            </button>
            <button disabled={busy} onClick={logout} className="btn" style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--hairline)' }}>
              Log out
            </button>
          </div>

          <div className="mt-4 text-xs tv-muted">
            Pricing is pulled live from Stripe (the Price IDs set in your environment).
          </div>
        </div>
      </div>
    </div>
  );
}