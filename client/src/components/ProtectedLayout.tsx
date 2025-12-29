import React, { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import BottomNav from './BottomNav';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import { enablePush, isPushSupported, getExistingSubscription } from '../lib/push';

/**
 * Wraps all authenticated pages with a persistent bottom navigation bar.
 * Adds bottom padding so page content doesn't sit behind the nav.
 * Also enforces Terms acceptance + prompts for Push on first login.
 */
export default function ProtectedLayout() {
  const nav = useNavigate();
  const location = useLocation();

  const [checked, setChecked] = useState(false);
  const [needsTerms, setNeedsTerms] = useState(false);
  const [termsTick, setTermsTick] = useState(false);
  const [pushPrompt, setPushPrompt] = useState(false);
  const [invites, setInvites] = useState<Array<{ id: number; site: string; role: string }>>([]);
  const [invitesPrompt, setInvitesPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const db = await getDB();
        const session = await db.get('session', 'auth');
        if (!session?.token) return;

        // Terms gate
        const me = await api('/api/user/me');
        const accepted = !!(me as any)?.termsAccepted;
        setNeedsTerms(!accepted);

        // Site invites prompt (only if terms accepted)
        if (accepted) {
          try {
            const inv: any = await api('/api/user/site-invites');
            const list = Array.isArray(inv?.invites) ? inv.invites : [];
            setInvites(list);
            setInvitesPrompt(list.length > 0);
          } catch {
            // ignore
          }
        }

        // Push prompt (only if terms accepted)
        if (accepted) {
          const prompted = localStorage.getItem('spectatore-push-prompted') === '1';
          if (!prompted && (await isPushSupported())) {
            // Only prompt if browser hasn't decided yet
            if (Notification.permission === 'default') {
              const existing = await getExistingSubscription();
              if (!existing) setPushPrompt(true);
            }
          }
        }
      } catch {
        // ignore
      } finally {
        setChecked(true);
      }
    })();
    // Re-check when route changes (helps after accepting terms / enabling push)
  }, [location.key]);

  async function acceptTerms() {
    setErr('');
    if (!termsTick) {
      setErr('Please tick the box to accept.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/user/terms/accept', {
        method: 'POST',
        body: JSON.stringify({ version: 'v1' }),
      });
      setNeedsTerms(false);

      // After accepting terms, we can optionally prompt for push
      const prompted = localStorage.getItem('spectatore-push-prompted') === '1';
      if (!prompted && (await isPushSupported()) && Notification.permission === 'default') {
        const existing = await getExistingSubscription();
        if (!existing) setPushPrompt(true);
      }
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        setErr(msg || 'Failed to accept terms');
      } catch {
        setErr('Failed to accept terms');
      }
    } finally {
      setBusy(false);
    }
  }

  async function enableNotifications() {
    setErr('');
    setBusy(true);
    try {
      const r = await enablePush();
      if ((r as any).ok) {
        setPushPrompt(false);
        localStorage.setItem('spectatore-push-prompted', '1');
      } else {
        setErr((r as any).error || 'Could not enable notifications');
      }
    } finally {
      setBusy(false);
    }
  }

  function dismissPush() {
    setPushPrompt(false);
    localStorage.setItem('spectatore-push-prompted', '1');
  }

  async function respondInvite(membership_id: number, accept: boolean) {
    setBusy(true);
    setErr('');
    try {
      await api('/api/user/site-invites/respond', {
        method: 'POST',
        body: JSON.stringify({ membership_id, accept }),
      });
      const inv: any = await api('/api/user/site-invites');
      const list = Array.isArray(inv?.invites) ? inv.invites : [];
      setInvites(list);
      setInvitesPrompt(list.length > 0);
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        setErr(msg || 'Failed');
      } catch {
        setErr('Failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return null;

  return (
    <div
      className="w-full"
      style={{
        minHeight: '100dvh',
        paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))',
      }}
    >
      <Outlet />
      {!location.pathname.toLowerCase().startsWith('/siteadmin') && <BottomNav />}

      {/* Site invites (2-way consent) */}
      {!needsTerms && invitesPrompt && invites.length > 0 && (
        <div className="fixed inset-0 z-[9997] flex items-end sm:items-center justify-center bg-black/40 p-3">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold">Site invitation</div>
            <div className="text-sm text-slate-600 mt-2">
              A site admin has added you. You need to accept before you become an active member.
            </div>

            {err && <div className="text-sm text-red-600 mt-3">{err}</div>}

            <div className="mt-4 space-y-3">
              {invites.map((inv) => (
                <div key={inv.id} className="border rounded-2xl p-4">
                  <div className="font-semibold text-slate-900">{inv.site || 'Site'}</div>
                  <div className="text-sm text-slate-600">Role: {String(inv.role || 'member')}</div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button type="button" className="btn" disabled={busy} onClick={() => respondInvite(inv.id, false)}>
                      Decline
                    </button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => respondInvite(inv.id, true)}>
                      {busy ? 'Working…' : 'Accept'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Terms gate */}
      {needsTerms && (
        <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center bg-black/50 p-3">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold">Terms &amp; Conditions</div>
            <div className="text-sm text-slate-600 mt-2">
              Before using Spectatore you need to accept the Terms &amp; Conditions.
            </div>

            <div className="mt-4 space-y-3">
              <label className="flex gap-3 items-start text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={termsTick}
                  onChange={(e) => setTermsTick(e.target.checked)}
                />
                <span>
                  I have read and agree to the{' '}
                  <button
                    type="button"
                    className="underline text-blue-700"
                    onClick={() => nav('/Terms')}
                  >
                    Terms &amp; Conditions
                  </button>
                  .
                </span>
              </label>

              {err && <div className="text-sm text-red-600">{err}</div>}

              <button
                type="button"
                disabled={busy}
                className="btn btn-primary w-full"
                onClick={acceptTerms}
              >
                {busy ? 'Saving…' : 'Accept & Continue'}
              </button>

              <div className="text-xs text-slate-500">
                Version: v1
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Push prompt */}
      {!needsTerms && pushPrompt && (
        <div className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40 p-3">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold">Enable notifications?</div>
            <div className="text-sm text-slate-600 mt-2">
              Turn on push notifications to get crew requests and milestone alerts.
            </div>

            {err && <div className="text-sm text-red-600 mt-3">{err}</div>}

            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" className="btn" onClick={dismissPush} disabled={busy}>
                Not now
              </button>
              <button type="button" className="btn btn-primary" onClick={enableNotifications} disabled={busy}>
                {busy ? 'Working…' : 'Enable'}
              </button>
            </div>

            <div className="text-xs text-slate-500 mt-3">
              You can change this anytime in Settings.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}