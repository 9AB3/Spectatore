import { useEffect, useMemo, useState, useRef } from 'react';
import { api } from '../lib/api';
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

export default function Landing() {
  const appUrl = useMemo(() => getAppUrl(), []);


const introVideoRef = useRef<HTMLVideoElement | null>(null);
const [introPhase, setIntroPhase] = useState<"show" | "leaving" | "hidden">("show");
const [contentVisible, setContentVisible] = useState(false);

const endIntro = () => {
  setIntroPhase("leaving");
  window.setTimeout(() => {
    setIntroPhase("hidden");
    setContentVisible(true);
  }, 650);
};

useEffect(() => {
  const v = introVideoRef.current;
  if (!v) {
    setIntroPhase("hidden");
    setContentVisible(true);
    return;
  }

  let fallbackTimer: number | undefined;

  const armFallback = () => {
    const ms = Number.isFinite(v.duration) && v.duration > 0 ? Math.ceil(v.duration * 1000) : 3500;
    fallbackTimer = window.setTimeout(() => endIntro(), ms + 80);
  };

  const onEnded = () => endIntro();

  v.addEventListener("ended", onEnded);
  v.addEventListener("loadedmetadata", armFallback);

  if (v.readyState >= 1) armFallback();

  return () => {
    v.removeEventListener("ended", onEnded);
    v.removeEventListener("loadedmetadata", armFallback);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);


  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [site, setSite] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  type DemoCard = 'you' | 'network' | 'crew';
  const [demoCard, setDemoCard] = useState<DemoCard>('you');

  type LandingTab = 'operators' | 'sites';
  const [activeTab, setActiveTab] = useState<LandingTab>('operators');

  useEffect(() => {
    const order: DemoCard[] = ['you', 'network', 'crew'];
    const ms = 4500;
    const t = window.setInterval(() => {
      setDemoCard((cur) => {
        const i = order.indexOf(cur);
        return order[(i + 1) % order.length];
      });
    }, ms);
    return () => window.clearInterval(t);
  }, []);

  async function submitContact(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    setSending(true);
    try {
      await api('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify({ name, email, company, site, message }),
      });
      setSent("Thanks — we received your message. We'll be in touch soon.");
      setName('');
      setEmail('');
      setCompany('');
      setSite('');
      setMessage('');
    } catch (err: any) {
      setError(err?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  return (
<div className="landing-root">
  <style>{` 
    .landing-root { position: relative; }
    .landing-content {
      opacity: 0;
      transition: opacity 700ms ease-out;
    }
    .landing-content.visible { opacity: 1; }

    .landing-intro {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: black;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 450ms ease-out;
    }
    .landing-intro.in { opacity: 1; }
    .landing-intro.out {
      opacity: 0;
      transition: opacity 650ms ease-out;
    }
    .landing-intro .frame {
      width: min(920px, 92vw);
      height: min(520px, 52vh);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    @media (max-width: 767px) {
      .landing-intro .frame { width: 92vw; height: 42vh; }
    }
    .landing-intro video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
  `}</style>

  {introPhase !== "hidden" && (
    <div className={"landing-intro " + (introPhase === "leaving" ? "out" : "in")}>
      <div className="frame">
        <video
          ref={introVideoRef}
          src="/landing-drill.mp4"
          autoPlay
          muted
          playsInline
        />
      </div>
    </div>
  )}

  <div className={"landing-content " + (contentVisible ? "visible" : "")} style={{ pointerEvents: contentVisible ? "auto" : "none" }}>
<div className="min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
  {/* Top bar */}
  <div className="sticky top-0 z-20 border-b tv-divider backdrop-blur" style={{ background: "var(--bg-elev)" }}>
    <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-amber-200/60 to-amber-100/40 flex items-center justify-center overflow-hidden border border-amber-200/40">
          <img src="/logo.png" alt="Spectatore" className="h-8 w-8 object-contain" />
        </div>
        <div>
          <div className="text-lg font-extrabold tracking-tight">Spectatore</div>
          <div className="text-xs tv-muted">Your metres. Your metrics.</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <a className="tv-pill" href="/how-to" onClick={(e) => { e.preventDefault(); track.clickNavigate('landing_howto', '/how-to'); }}>How-to</a>
        <a
          className="tv-pill"
          href={`${appUrl}/Register`}
          onClick={(e) => { e.preventDefault(); track.signupStartNavigate('landing_cta', `${appUrl}/Register`); }}
        >
          Create account
        </a>
        <a className="btn" href={appUrl} onClick={(e) => { e.preventDefault(); track.clickNavigate('landing_open_app', appUrl); }}>
          Open app
        </a>
      </div>
    </div>
  </div>

  {/* Hero */}
  <div className="mx-auto max-w-6xl px-4 pt-14 pb-10">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">



        <div className="mt-8 flex flex-col items-center lg:items-start text-center lg:text-left">
          <img src="/logo.png" alt="Spectatore" className="h-20 w-20 md:h-28 md:w-28 object-contain" />
          <div className="mt-3 text-2xl md:text-3xl font-extrabold tracking-tight">Spectatore</div>
          <div className="mt-1 text-lg md:text-xl font-semibold tv-muted">Your metres. Your metrics.</div>


        <h1 className="mt-6 text-4xl md:text-5xl font-black tracking-tight">
          Operator-owned performance data — <span style={{ color: "var(--accent)" }}>back yourself with numbers</span>.
        </h1>

        <div className="mt-4 text-base md:text-lg tv-muted leading-relaxed space-y-3">
          <p>
            Track your shift performance with <strong>Spectatore</strong> — a web app that captures your shift data on your device.
          </p>
          <p>Chase your best shift, compare your progress and compete with your crew.</p>
          <p className="font-semibold">
            <span style={{ color: "var(--accent)" }}>Get inducted now</span> and become a certified meter eater!
          </p>
          <p className="tv-muted">
            Speak to us today if you want to learn more about our <strong>clean integration</strong> for site data management (Power BI-ready).
            With Spectatore, the focus is on the key mining physicals and getting them right with a simple validation process.
          </p>
          <p className="tv-muted">
            Operator timelines, pre-starts, Take 5&apos;s and shift planning — that&apos;s better handled elsewhere.
          </p>
        </div>
      </div>

      {/* Visual card */}

      <div className="relative max-w-md mx-auto md:max-w-none">
        {/* iPhone-style frame on mobile */}
        <div className="md:hidden absolute -inset-3 rounded-[44px] border tv-border" style={{ background: 'rgba(255,255,255,0.04)' }} />
        <div className="md:hidden absolute -inset-2 rounded-[40px] border tv-border" style={{ background: 'rgba(0,0,0,0.10)' }} />
        <div className="absolute -inset-4 bg-amber-300/10 blur-3xl rounded-full" />
        <div className="relative card">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center rounded-2xl border tv-border p-1" style={{ background: "var(--bg-elev)" }}>
              <button
                type="button"
                onClick={() => setActiveTab('operators')}
                className={
                  'px-3 py-2 rounded-xl text-sm font-semibold transition ' +
                  (activeTab === 'operators'
                    ? 'bg-slate-900 text-white'
                    : 'tv-muted hover:tv-surface')
                }
              >
                For Operators
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('sites')}
                className={
                  'px-3 py-2 rounded-xl text-sm font-semibold transition ' +
                  (activeTab === 'sites' ? 'bg-slate-900 text-white' : 'tv-muted hover:tv-surface')
                }
              >
                For Sites
              </button>
            </div>

            <div className="text-xs tv-muted">Daily • MTD • YTD</div>
          </div>

          <div className="mt-4">
            {activeTab === 'operators' ? (
              <>
                <div className="rounded-2xl border tv-border tv-surface-soft p-4">
                  {demoCard === 'you' ? (
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">You vs You</div>
                        <div className="text-xs tv-muted">Personal trends</div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">GS Drillm</div>
                          <div className="mt-1 text-lg font-black">184</div>
                          <div className="text-xs text-emerald-700">+12% MTD</div>
                        </div>
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Tonnes Hauled</div>
                          <div className="mt-1 text-lg font-black">1,240</div>
                          <div className="text-xs tv-muted">Rolling 30d</div>
                        </div>
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">TKMs</div>
                          <div className="mt-1 text-lg font-black">96</div>
                          <div className="text-xs tv-muted">Daily / MTD / YTD</div>
                        </div>
                      </div>

                      <div className="mt-3 rounded-xl border tv-border tv-surface p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold ">Trend preview</div>
                          <div className="text-[11px] tv-muted">Tap metric → chart</div>
                        </div>

                        <div className="mt-2 grid grid-cols-10 gap-1 items-end h-14">
                          {[18, 26, 22, 30, 28, 40, 38, 46, 42, 52].map((h, i) => (
                            <div
                              key={i}
                              className="w-full rounded-md bg-amber-300/35 border border-amber-300/30"
                              style={{ height: `${h}%` }}
                            />
                          ))}
                        </div>

                        <div className="mt-2 text-[11px] tv-muted">
                          PBs, rolling averages, date filters, and per-metric drilldowns.
                        </div>
                      </div>
                    </div>
                  ) : demoCard === 'network' ? (
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">You vs Crew</div>
                        <div className="text-xs tv-muted">Optional sharing</div>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Rank</div>
                          <div className="mt-1 text-lg font-black">#3</div>
                          <div className="text-xs tv-muted">of 18</div>
                        </div>
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Best metric</div>
                          <div className="mt-1 text-lg font-black">GS</div>
                          <div className="text-xs text-emerald-700">Top 10%</div>
                        </div>
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Delta</div>
                          <div className="mt-1 text-lg font-black">+8%</div>
                          <div className="text-xs tv-muted">vs avg</div>
                        </div>
                      </div>

                      <div className="mt-3 rounded-xl border tv-border tv-surface p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold ">Leaderboard snapshot</div>
                          <div className="text-[11px] tv-muted">Private by default</div>
                        </div>

                        <div className="mt-2 space-y-2">
                          {[
                            ['1', 'M. Smith', '204 GS'],
                            ['2', 'J. Brown', '196 GS'],
                            ['3', 'You', '184 GS'],
                            ['4', 'A. Lee', '179 GS'],
                          ].map(([rank, who, val]) => (
                            <div key={rank} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-2">
        
                                <div className="w-5 tv-muted">{rank}</div>
                                <div className={who === 'You' ? 'font-semibold text-slate-900' : 'tv-muted'}>{who}</div>
                              </div>
                              <div className={who === 'You' ? 'font-semibold text-amber-700' : 'tv-muted'}>{val}</div>
                            </div>
                          ))}
                        </div>

                        <div className="mt-2 text-[11px] tv-muted">Compare by role, site, or your selected network.</div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">You vs Crew member</div>
                        <div className="text-xs tv-muted">1:1 comparison</div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Metric</div>
                          <div className="mt-1 text-sm font-semibold text-slate-900">Tonnes hauled</div>
                          <div className="mt-3 space-y-2 text-xs">
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">You</div>
                              <div className="font-semibold text-amber-700">1,240</div>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">Crew mate</div>
                              <div className="font-semibold tv-muted">1,110</div>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">Delta</div>
                              <div className="font-semibold text-emerald-700">+12%</div>
                            </div>
                          </div>
                          <div className="mt-2 text-[11px] tv-muted">Swap metrics instantly.</div>
                        </div>

                        <div className="rounded-xl border tv-border tv-surface p-3">
                          <div className="text-xs tv-muted">Timeframe</div>
                          <div className="mt-1 text-sm font-semibold text-slate-900">Last 30 days</div>
                          <div className="mt-3 space-y-2 text-xs">
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">Best day</div>
                              <div className="font-semibold text-slate-900">Fri</div>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">Consistency</div>
                              <div className="font-semibold text-emerald-700">High</div>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="tv-muted">PB flags</div>
                              <div className="font-semibold text-slate-900">On</div>
                            </div>
                          </div>
                          <div className="mt-2 text-[11px] tv-muted">Change crew mate with one tap.</div>
                        </div>
                      </div>

                      <div className="mt-3 text-[11px] tv-muted">Sharing is optional — you control what’s visible and to who.</div>
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
        
                      {[
                        ['you', 'You vs You'],
                        ['network', 'You vs Crew'],
                        ['crew', 'You vs Crew member'],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setDemoCard(key as any)}
                          className={
                            'px-2 py-1 rounded-full text-[11px] border ' +
                            (demoCard === (key as any)
                              ? 'border-amber-300/50 bg-amber-300/20 text-slate-900'
                              : 'tv-border tv-surface tv-muted hover:tv-surface-soft')
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="text-[11px] tv-muted">Auto-rotates</div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between text-xs tv-muted">
                  <div>Fast entry • Clean totals • Consistent metrics</div>
                  <div className="px-2 py-1 rounded-full border tv-border">PWA</div>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border tv-border tv-surface-soft p-4">
                  <div className="text-sm font-semibold text-slate-900">Data process flow</div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-sm">
                    <div className="rounded-xl border tv-border tv-surface px-3 py-3 text-center font-semibold">Operator form input</div>
                    <div className="tv-muted text-center">→</div>
                    <div className="rounded-xl border tv-border tv-surface px-3 py-3 text-center font-semibold">Daily site validation process</div>
                    <div className="tv-muted text-center">→</div>
                    <div className="rounded-xl border tv-border tv-surface px-3 py-3 text-center font-semibold">End of month reconciliation</div>
                  </div>
                  <div className="mt-3 text-[11px] tv-muted">Clean inputs → simple validation → Power BI-ready reporting.</div>
                </div>

                <div className="rounded-2xl border tv-border tv-surface p-3">
                  <div className="text-xs font-semibold ">Power BI examples (month view)</div>
                  <div className="mt-3 grid grid-cols-1 gap-3">
                    <img
                      src="/oremtd.png"
                      alt="Power BI monthly chart example"
                      className="w-full rounded-xl border tv-border"
                      loading="lazy"
                    />
                    <img
                      src="/devmtd.png"
                      alt="Power BI monthly chart example (alternate)"
                      className="w-full rounded-xl border tv-border"
                      loading="lazy"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs tv-muted">
                  <div>Validated daily → reconciled monthly</div>
                  <div className="px-2 py-1 rounded-full border tv-border">Power BI-ready</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  </div>

  {/* Book a demo / Contact */}
  <div className="mx-auto max-w-6xl px-4 pb-16">
    <div className="rounded-3xl border tv-border tv-surface overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-2">
        <div className="p-8">

          <div className="mt-3 text-3xl font-black tracking-tight">Contact Us</div>
          <div className="mt-3 text-sm tv-muted leading-relaxed">

          </div>

          <div className="mt-6 text-xs tv-muted">
            Prefer email? Contact us at <span className="text-amber-700">support@spectatore.com</span>
          </div>
        </div>

        <div className="p-8 border-t lg:border-t-0 lg:border-l tv-border tv-surface">
          <form onSubmit={submitContact} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <div className="text-xs tv-muted mb-1">Name</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border tv-border tv-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                  placeholder="Full Name"
                />
              </label>
              <label className="block">
                <div className="text-xs tv-muted mb-1">Email</div>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border tv-border tv-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                  placeholder="Email Address"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <div className="text-xs tv-muted mb-1">Company</div>
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full rounded-xl border tv-border tv-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                  placeholder="Company"
                />
              </label>
              <label className="block">
                <div className="text-xs tv-muted mb-1">Site</div>
                <input
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  className="w-full rounded-xl border tv-border tv-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                  placeholder="Mine site"
                />
              </label>
            </div>

            <label className="block">
              <div className="text-xs tv-muted mb-1">Message</div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full min-h-[110px] rounded-xl border tv-border tv-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                placeholder="What do you want to know?"
              />
            </label>

            {error && <div className="text-sm text-red-600">{error}</div>}
            {sent && <div className="text-sm text-emerald-700">{sent}</div>}

            <button
              disabled={sending}
              className="w-full sm:w-auto px-4 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-sm font-semibold disabled:opacity-60"
              type="submit"
            >
              {sending ? 'Sending…' : 'Submit'}
            </button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <div className="mx-auto max-w-6xl px-4 py-8 text-xs tv-muted">
    © {new Date().getFullYear()} Spectatore
  </div>
</div>
  </div>
</div>
  );
}


