import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import BottomNav from './BottomNav';
import TermsContent from './TermsContent';
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
  const [termsScrolled, setTermsScrolled] = useState(false);
  const termsBoxRef = useRef<HTMLDivElement | null>(null);
  const [inviteConsent, setInviteConsent] = useState<{ id: number; site: string; role: string } | null>(null);
  const [inviteConsentTick, setInviteConsentTick] = useState(false);
  const [inviteConsentScrolled, setInviteConsentScrolled] = useState(false);
  const inviteConsentBoxRef = useRef<HTMLDivElement | null>(null);

  const [pushPrompt, setPushPrompt] = useState(false);
  const [invites, setInvites] = useState<Array<{ id: number; site: string; role: string }>>([]);
  const [invitesPrompt, setInvitesPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Reset & ensure scroll gating works even when the content doesn't overflow.
  useEffect(() => {
    if (!needsTerms) return;
    setTermsTick(false);
    setTermsScrolled(false);

    // If the terms content fits (no scroll needed), allow proceeding after tick.
    const t = setTimeout(() => {
      const el = termsBoxRef.current;
      if (!el) return;
      const noScrollNeeded = el.scrollHeight <= el.clientHeight + 2;
      if (noScrollNeeded) setTermsScrolled(true);
    }, 0);
    return () => clearTimeout(t);
  }, [needsTerms]);

  // Same logic for site-invite consent: if content doesn't overflow, don't block the button.
  useEffect(() => {
    if (!inviteConsent) return;
    setInviteConsentTick(false);
    setInviteConsentScrolled(false);

    const t = setTimeout(() => {
      const el = inviteConsentBoxRef.current;
      if (!el) return;
      const noScrollNeeded = el.scrollHeight <= el.clientHeight + 2;
      if (noScrollNeeded) setInviteConsentScrolled(true);
    }, 0);
    return () => clearTimeout(t);
  }, [inviteConsent]);

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

  async function respondInvite(membership_id: number, accept: boolean, site_consent_version?: string) {
    setBusy(true);
    setErr('');
    try {
      await api('/api/user/site-invites/respond', {
        method: 'POST',
        body: JSON.stringify({ membership_id, accept, site_consent_version }),
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
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
                      setInviteConsent(inv);
                      setInviteConsentTick(false);
                      setInviteConsentScrolled(false);
                    }}>
                      {busy ? 'Working…' : 'Review & Accept'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}      {/* Terms gate */}
      {needsTerms && (
        <div className="fixed inset-0 z-[9999] bg-black/70">
          <div className="h-full w-full flex flex-col">
            <div className="px-5 pt-6 pb-4 text-white">
              <div className="text-xl font-semibold">Terms &amp; Conditions</div>
              <div className="text-sm opacity-90 mt-1">
                Please scroll to the bottom, then tick the box to enable <b>Accept &amp; Continue</b>.
              </div>
            </div>

            <div className="px-4 pb-4 flex-1 min-h-0 flex flex-col gap-4">
              <div
                ref={termsBoxRef}
                className="bg-white rounded-2xl shadow-xl flex-1 min-h-0 overflow-y-auto p-5"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setTermsScrolled(true);
                }}
              >
                <TermsContent />
              </div>

              <div className="bg-white rounded-2xl shadow-xl p-4">
                <label className="flex gap-3 items-start text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={termsTick}
                    onChange={(e) => setTermsTick(e.target.checked)}
                  />
                  <span>I have read and agree to the Terms &amp; Conditions.</span>
                </label>

                {err && <div className="text-sm text-red-600 mt-2">{err}</div>}

                <button
                  type="button"
                  disabled={busy || !termsTick || !termsScrolled}
                  className="btn btn-primary w-full mt-3"
                  onClick={acceptTerms}
                >
                  {busy ? 'Saving…' : 'Accept & Continue'}
                </button>

                <div className="text-xs text-slate-500 mt-2">Version: v1</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Site data consent (invites) */}
      {!needsTerms && inviteConsent ? (
        <div className="fixed inset-0 z-[9998] flex items-start justify-center bg-black/60 overflow-auto pt-6 pb-24 p-3">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-5">
            <div className="text-lg font-semibold">Site data consent</div>
            <div className="text-sm text-slate-600 mt-1">
              Before joining <b>{inviteConsent.site}</b>, please review how site-linked data is shared.
            </div>

            <div
              ref={inviteConsentBoxRef}
              className="mt-4 border rounded-2xl p-4 bg-slate-50"
              style={{ maxHeight: 320, overflowY: 'auto' }}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 6) setInviteConsentScrolled(true);
              }}
            >
              <div className="space-y-3 text-sm text-slate-800">
                <div className="font-semibold">What changes when you join a site</div>
                <ul className="list-disc pl-5 space-y-2">
                  <li>
                    Your <b>validated</b> shift data for that site may be visible to site admins/validators for reporting, reconciliation,
                    and Power BI dashboards.
                  </li>
                  <li>
                    You should only record/submit information you are authorised to share under employer/site policies.
                  </li>
                  <li>You can leave a site at any time from Settings.</li>
                </ul>
                <div className="text-xs opacity-70 pt-2">Scroll to the bottom to enable consent.</div>
              </div>
            </div>

            <label className="flex gap-3 items-start text-sm mt-4">
              <input
                type="checkbox"
                className="mt-1"
                checked={inviteConsentTick}
                onChange={(e) => setInviteConsentTick(e.target.checked)}
              />
              <span>
                I understand and consent to site-linked data visibility for <b>{inviteConsent.site}</b>.
              </span>
            </label>

            {err && <div className="text-sm text-red-600 mt-2">{err}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn btn-outline" onClick={() => setInviteConsent(null)} disabled={busy}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !inviteConsentTick || !inviteConsentScrolled}
                onClick={async () => {
                  const c = inviteConsent;
                  if (!c) return;
                  setInviteConsent(null);
                  await respondInvite(c.id, true, 'v1');
                }}
              >
                {busy ? 'Working…' : 'I consent & Accept invite'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
