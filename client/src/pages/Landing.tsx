import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

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
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 text-slate-900">
      {/* Top bar */}
      <div className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-amber-200/60 to-amber-100/40 flex items-center justify-center overflow-hidden border border-amber-200/40">
              <img src="/logo.png" alt="Spectatore" className="h-8 w-8 object-contain" />
            </div>
            <div>
              <div className="text-lg font-extrabold tracking-tight">Spectatore</div>
              <div className="text-xs text-slate-600">Your metres. Your metrics.</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              className="px-3 py-2 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-100 text-sm"
              href={`${appUrl}/Register`}
            >
              Create account
            </a>
            <a className="px-3 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-sm font-semibold" href={appUrl}>
              Open app
            </a>
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="mx-auto max-w-6xl px-4 pt-14 pb-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs text-slate-700">
              Built for operators • Integrates to sites
            </div>

            <div className="mt-8 flex flex-col items-center lg:items-start text-center lg:text-left">
              <img src="/logo.png" alt="Spectatore" className="h-20 w-20 md:h-28 md:w-28 object-contain" />
              <div className="mt-3 text-2xl md:text-3xl font-extrabold tracking-tight">Spectatore</div>
              <div className="mt-1 text-lg md:text-xl font-semibold text-slate-700">Your metres. Your metrics.</div>
            </div>

            <h1 className="mt-6 text-4xl md:text-5xl font-black tracking-tight">
              Operator-owned performance data — <span className="text-amber-700">back yourself with numbers</span>.
            </h1>

            <div className="mt-4 text-base md:text-lg text-slate-700 leading-relaxed space-y-3">
              <p>
                Track your shift performance with <strong>Spectatore</strong> — a web app that captures your shift data on your device.
              </p>
              <p>Chase your best shift, compare your progress and compete with your crew.</p>
              <p className="font-semibold text-slate-900">
                <span className="text-amber-700">Get inducted now</span> and become a certified meter eater!
              </p>
              <p className="text-slate-700">
                Speak to us today if you want to learn more about our <strong>clean integration</strong> for site data management (Power BI-ready).
                With Spectatore, the focus is on the key mining physicals and getting them right with a simple validation process.
              </p>
              <p className="text-slate-600">
                Operator timelines, pre-starts, Take 5&apos;s and shift planning — that&apos;s better handled elsewhere.
              </p>
            </div>
          </div>

          {/* Visual card */}
          <div className="relative">
            <div className="absolute -inset-4 bg-amber-300/10 blur-3xl rounded-full" />
            <div className="relative rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between gap-3">
                <div className="inline-flex items-center rounded-2xl border border-slate-200 bg-slate-50 p-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab('operators')}
                    className={
                      'px-3 py-2 rounded-xl text-sm font-semibold transition ' +
                      (activeTab === 'operators'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-white')
                    }
                  >
                    For Operators
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sites')}
                    className={
                      'px-3 py-2 rounded-xl text-sm font-semibold transition ' +
                      (activeTab === 'sites' ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white')
                    }
                  >
                    For Sites
                  </button>
                </div>

                <div className="text-xs text-slate-500">Daily • MTD • YTD</div>
              </div>

              <div className="mt-4">
                {activeTab === 'operators' ? (
                  <>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      {demoCard === 'you' ? (
                        <div>
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold">You vs You</div>
                            <div className="text-xs text-slate-600">Personal trends</div>
                          </div>

                          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">GS Drillm</div>
                              <div className="mt-1 text-lg font-black">184</div>
                              <div className="text-xs text-emerald-700">+12% MTD</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Tonnes Hauled</div>
                              <div className="mt-1 text-lg font-black">1,240</div>
                              <div className="text-xs text-slate-600">Rolling 30d</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">TKMs</div>
                              <div className="mt-1 text-lg font-black">96</div>
                              <div className="text-xs text-slate-600">Daily / MTD / YTD</div>
                            </div>
                          </div>

                          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-slate-800">Trend preview</div>
                              <div className="text-[11px] text-slate-600">Tap metric → chart</div>
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

                            <div className="mt-2 text-[11px] text-slate-600">
                              PBs, rolling averages, date filters, and per-metric drilldowns.
                            </div>
                          </div>
                        </div>
                      ) : demoCard === 'network' ? (
                        <div>
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold">You vs Crew</div>
                            <div className="text-xs text-slate-600">Optional sharing</div>
                          </div>

                          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Rank</div>
                              <div className="mt-1 text-lg font-black">#3</div>
                              <div className="text-xs text-slate-600">of 18</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Best metric</div>
                              <div className="mt-1 text-lg font-black">GS</div>
                              <div className="text-xs text-emerald-700">Top 10%</div>
                            </div>
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Delta</div>
                              <div className="mt-1 text-lg font-black">+8%</div>
                              <div className="text-xs text-slate-600">vs avg</div>
                            </div>
                          </div>

                          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-slate-800">Leaderboard snapshot</div>
                              <div className="text-[11px] text-slate-600">Private by default</div>
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
                                    <div className="w-5 text-slate-600">{rank}</div>
                                    <div className={who === 'You' ? 'font-semibold text-slate-900' : 'text-slate-700'}>{who}</div>
                                  </div>
                                  <div className={who === 'You' ? 'font-semibold text-amber-700' : 'text-slate-600'}>{val}</div>
                                </div>
                              ))}
                            </div>

                            <div className="mt-2 text-[11px] text-slate-600">Compare by role, site, or your selected network.</div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold">You vs Crew member</div>
                            <div className="text-xs text-slate-600">1:1 comparison</div>
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-3">
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Metric</div>
                              <div className="mt-1 text-sm font-semibold text-slate-900">Tonnes hauled</div>
                              <div className="mt-3 space-y-2 text-xs">
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">You</div>
                                  <div className="font-semibold text-amber-700">1,240</div>
                                </div>
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">Crew mate</div>
                                  <div className="font-semibold text-slate-700">1,110</div>
                                </div>
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">Delta</div>
                                  <div className="font-semibold text-emerald-700">+12%</div>
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] text-slate-600">Swap metrics instantly.</div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-xs text-slate-600">Timeframe</div>
                              <div className="mt-1 text-sm font-semibold text-slate-900">Last 30 days</div>
                              <div className="mt-3 space-y-2 text-xs">
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">Best day</div>
                                  <div className="font-semibold text-slate-900">Fri</div>
                                </div>
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">Consistency</div>
                                  <div className="font-semibold text-emerald-700">High</div>
                                </div>
                                <div className="flex items-center justify-between">
                                  <div className="text-slate-700">PB flags</div>
                                  <div className="font-semibold text-slate-900">On</div>
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] text-slate-600">Change crew mate with one tap.</div>
                            </div>
                          </div>

                          <div className="mt-3 text-[11px] text-slate-600">Sharing is optional — you control what’s visible and to who.</div>
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
                                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        <div className="text-[11px] text-slate-600">Auto-rotates</div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
                      <div>Fast entry • Clean totals • Consistent metrics</div>
                      <div className="px-2 py-1 rounded-full border border-slate-200">PWA</div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-sm font-semibold text-slate-900">Data process flow</div>
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-sm">
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center font-semibold">Operator form input</div>
                        <div className="text-slate-500 text-center">→</div>
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center font-semibold">Daily site validation process</div>
                        <div className="text-slate-500 text-center">→</div>
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-center font-semibold">End of month reconciliation</div>
                      </div>
                      <div className="mt-3 text-[11px] text-slate-600">Clean inputs → simple validation → Power BI-ready reporting.</div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-3">
                      <div className="text-xs font-semibold text-slate-800">Power BI examples (month view)</div>
                      <div className="mt-3 grid grid-cols-1 gap-3">
                        <img
                          src="/powerbi-ore-mtd.png"
                          alt="Power BI monthly chart example"
                          className="w-full rounded-xl border border-slate-200"
                          loading="lazy"
                        />
                        <img
                          src="/powerbi-ore-mtd.png"
                          alt="Power BI monthly chart example (alternate)"
                          className="w-full rounded-xl border border-slate-200"
                          loading="lazy"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <div>Validated daily → reconciled monthly</div>
                      <div className="px-2 py-1 rounded-full border border-slate-200">Power BI-ready</div>
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
        <div className="rounded-3xl border border-slate-200 bg-white overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-2">
            <div className="p-8">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs text-slate-700">
                Book a demo
              </div>
              <div className="mt-3 text-3xl font-black tracking-tight">See Spectatore in action</div>
              <div className="mt-3 text-sm text-slate-700 leading-relaxed">
                
              </div>

              <div className="mt-6 text-xs text-slate-600">
                Prefer email? Contact us at <span className="text-amber-700">support@spectatore.com</span>
              </div>
            </div>

            <div className="p-8 border-t lg:border-t-0 lg:border-l border-slate-200 bg-white">
              <form onSubmit={submitContact} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <div className="text-xs text-slate-600 mb-1">Name</div>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                      placeholder="Your name"
                    />
                  </label>
                  <label className="block">
                    <div className="text-xs text-slate-600 mb-1">Email</div>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                      placeholder="you@site.com"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <div className="text-xs text-slate-600 mb-1">Company (optional)</div>
                    <input
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                      placeholder="Company"
                    />
                  </label>
                  <label className="block">
                    <div className="text-xs text-slate-600 mb-1">Site (optional)</div>
                    <input
                      value={site}
                      onChange={(e) => setSite(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                      placeholder="Mine site"
                    />
                  </label>
                </div>

                <label className="block">
                  <div className="text-xs text-slate-600 mb-1">Message</div>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="w-full min-h-[110px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-200"
                    placeholder="What do you want to track? (e.g. drill metres, tonnes, loads, TKMs)"
                  />
                </label>

                {error && <div className="text-sm text-red-600">{error}</div>}
                {sent && <div className="text-sm text-emerald-700">{sent}</div>}

                <button
                  disabled={sending}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-sm font-semibold disabled:opacity-60"
                  type="submit"
                >
                  {sending ? 'Sending…' : 'Request demo'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-8 text-xs text-slate-500">
        © {new Date().getFullYear()} Spectatore
      </div>
    </div>
  );
}
