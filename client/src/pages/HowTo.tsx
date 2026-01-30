import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { track } from '../lib/analytics';

function getAppUrl() {
  // Prefer explicit env so you can preview locally
  const env = (import.meta as any).env || {};
  const v = String(env.VITE_APP_URL || '').trim();
  if (v) return v;

  // Default to app subdomain for production
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (host === 'localhost' || host.includes('127.0.0.1')) return 'http://localhost:5173';
  const base = host.startsWith('www.') ? host.slice(4) : host;
  return `https://app.${base}`;
}

export default function HowTo() {
  const appUrl = useMemo(() => getAppUrl(), []);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-6xl px-4 py-8">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-black/90 text-white flex items-center justify-center font-bold">
              S
            </div>
            <div>
              <div className="text-lg font-semibold leading-tight">Spectatore</div>
              <div className="text-xs text-[var(--muted)]">How-to tutorials</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition"
              onClick={() => track.click('howto_back_to_landing')}
            >
              Home
            </Link>
            <a
              href={`${appUrl}/Register`}
              className="px-3 py-2 rounded-xl bg-black text-white hover:opacity-90 transition"
              onClick={() => track.signupStart('howto_cta')}
            >
              Create account
            </a>
            <a
              href={appUrl}
              className="px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition"
              onClick={() => track.click('howto_open_app')}
            >
              Open app
            </a>
          </div>
        </div>

        {/* Intro */}
        <div className="mt-10">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Start in minutes</h1>
          <p className="mt-3 text-[var(--muted)] max-w-2xl">
            Two quick videos: installing Spectatore as a PWA on mobile, and a full example shift workflow.
          </p>
        </div>

        {/* Cards */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Install PWA */}
          <div className="rounded-2xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Install the PWA on mobile</h2>
              <span className="text-xs px-2 py-1 rounded-full border border-black/10 dark:border-white/10 text-[var(--muted)]">
                Tutorial
              </span>
            </div>

            <p className="mt-2 text-sm text-[var(--muted)]">
              Add Spectatore to your Home Screen for an app-like experience (offline-friendly, full-screen, quick access).
            </p>

            <div className="mt-4 overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-black">
              <video
                className="w-full h-auto"
                controls
                playsInline
                preload="metadata"
                onPlay={() => track.videoPlay('howto_install_pwa')}
              >
                <source src="/tutorials/install-pwa.mp4" type="video/mp4" />
              </video>
            </div>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 bg-black/0">
                <div className="font-semibold">iPhone / iPad</div>
                <ol className="mt-1 list-decimal ml-5 text-[var(--muted)] space-y-1">
                  <li>Open in Safari</li>
                  <li>Tap Share</li>
                  <li>Add to Home Screen</li>
                </ol>
              </div>
              <div className="rounded-xl border border-black/10 dark:border-white/10 p-3">
                <div className="font-semibold">Android</div>
                <ol className="mt-1 list-decimal ml-5 text-[var(--muted)] space-y-1">
                  <li>Open in Chrome</li>
                  <li>Menu (⋮)</li>
                  <li>Install app / Add to Home screen</li>
                </ol>
              </div>
            </div>
          </div>

          {/* Example shift */}
          <div className="rounded-2xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Example shift workflow</h2>
              <span className="text-xs px-2 py-1 rounded-full border border-black/10 dark:border-white/10 text-[var(--muted)]">
                Tutorial
              </span>
            </div>

            <p className="mt-2 text-sm text-[var(--muted)]">
              A quick walkthrough: start shift → log activities → finalize → view your totals.
            </p>

            <div className="mt-4 overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-black">
              <video
                className="w-full h-auto"
                controls
                playsInline
                preload="metadata"
                onPlay={() => track.videoPlay('howto_example_shift')}
              >
                <source src="/tutorials/example-shift.mp4" type="video/mp4" />
              </video>
            </div>

            <div className="mt-4 rounded-xl border border-black/10 dark:border-white/10 p-3 text-sm">
              <div className="font-semibold">Workflow checklist</div>
              <ul className="mt-1 list-disc ml-5 text-[var(--muted)] space-y-1">
                <li>
                  Tap <span className="font-medium">Start Shift</span> and confirm the date
                </li>
                <li>Log activities as you go (haul, load, develop, drill, charge…)</li>
                <li>
                  Use <span className="font-medium">Finalize</span> to lock totals for the day
                </li>
                <li>
                  Review <span className="font-medium">You vs You</span> /{' '}
                  <span className="font-medium">You vs Crew</span> to track progress
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-[var(--muted)]">
          <div>Need help or want a demo? Use the contact form on the landing page.</div>
          <Link to="/" className="underline" onClick={() => track.click('howto_footer_back')}>
            Back
          </Link>
        </div>
      </div>
    </div>
  );
}
