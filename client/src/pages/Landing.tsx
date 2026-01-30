import { useMemo, useRef, useState } from 'react';
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

function scrollToEl(el: HTMLElement | null) {
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    el.scrollIntoView();
  }
}

export default function Landing() {
  const appUrl = useMemo(() => getAppUrl(), []);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const featuresRef = useRef<HTMLDivElement | null>(null);
  const contactRef = useRef<HTMLDivElement | null>(null);

  // Contact form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [site, setSite] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="min-h-screen bg-white text-zinc-900">
      {/* Top nav */}
      <div className="sticky top-0 z-20 border-b border-black/10 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/logo.png" alt="Spectatore" className="h-9 w-9 rounded-xl border border-black/10 bg-white p-1" />
            <div className="min-w-0">
              <div className="font-extrabold tracking-tight leading-tight">Spectatore</div>
              <div className="text-xs text-zinc-500 leading-tight">Your metres. Your metrics.</div>
            </div>
          </div>

          {/* Desktop nav */}
          <div className="hidden sm:flex items-center gap-2 justify-end">
            <button
              type="button"
              className="px-3 py-2 rounded-xl text-sm hover:bg-black/5 transition"
              onClick={() => {
                track.click('landing_nav_features');
                scrollToEl(featuresRef.current);
              }}
            >
              Features
            </button>

            <a
              href="/how-to"
              className="px-3 py-2 rounded-xl text-sm hover:bg-black/5 transition"
              onClick={() => track.click('landing_nav_tutorials')}
            >
              Tutorials
            </a>

            <button
              type="button"
              className="px-3 py-2 rounded-xl text-sm hover:bg-black/5 transition"
              onClick={() => {
                track.click('landing_nav_contact');
                scrollToEl(contactRef.current);
              }}
            >
              Contact
            </button>

            <a
              className="px-3 py-2 rounded-xl text-sm border border-black/10 hover:bg-black/5 transition"
              href={`${appUrl}/Register`}
              onClick={(e) => {
                e.preventDefault();
                track.signupStartNavigate('landing_create_account', `${appUrl}/Register`);
              }}
            >
              Create account
            </a>

            <a
              className="px-3 py-2 rounded-xl text-sm bg-black text-white hover:opacity-90 transition"
              href={appUrl}
              onClick={(e) => {
                e.preventDefault();
                track.clickNavigate('landing_open_app', appUrl);
              }}
            >
              Open app
            </a>
          </div>

          {/* Mobile nav toggle */}
          <button
            type="button"
            className="sm:hidden inline-flex items-center justify-center h-10 w-10 rounded-xl border border-black/10 hover:bg-black/5 transition"
            aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileNavOpen((v) => !v)}
          >
            <span className="text-xl leading-none">{mobileNavOpen ? '×' : '≡'}</span>
          </button>
        </div>

        {/* Mobile dropdown */}
        {mobileNavOpen && (
          <div className="sm:hidden border-t border-black/10 bg-white">
            <div className="mx-auto max-w-6xl px-4 py-3 grid gap-2">
              <button
                type="button"
                className="w-full text-left px-3 py-3 rounded-xl text-sm hover:bg-black/5 transition"
                onClick={() => {
                  setMobileNavOpen(false);
                  track.click('landing_nav_features');
                  scrollToEl(featuresRef.current);
                }}
              >
                Features
              </button>

              <a
                href="/how-to"
                className="w-full px-3 py-3 rounded-xl text-sm hover:bg-black/5 transition"
                onClick={() => {
                  setMobileNavOpen(false);
                  track.click('landing_nav_tutorials');
                }}
              >
                Tutorials
              </a>

              <button
                type="button"
                className="w-full text-left px-3 py-3 rounded-xl text-sm hover:bg-black/5 transition"
                onClick={() => {
                  setMobileNavOpen(false);
                  track.click('landing_nav_contact');
                  scrollToEl(contactRef.current);
                }}
              >
                Contact
              </button>

              <a
                className="w-full px-3 py-3 rounded-xl text-sm border border-black/10 hover:bg-black/5 transition"
                href={`${appUrl}/Register`}
                onClick={(e) => {
                  e.preventDefault();
                  setMobileNavOpen(false);
                  track.signupStartNavigate('landing_create_account', `${appUrl}/Register`);
                }}
              >
                Create account
              </a>

              <a
                className="w-full px-3 py-3 rounded-xl text-sm bg-black text-white hover:opacity-90 transition"
                href={appUrl}
                onClick={(e) => {
                  e.preventDefault();
                  setMobileNavOpen(false);
                  track.clickNavigate('landing_open_app', appUrl);
                }}
              >
                Open app
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Hero */}
      <div className="bg-gradient-to-b from-zinc-50 to-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-6">
            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.05]">
              Operator-owned performance data.
            </h1>
            <p className="mt-4 text-lg text-zinc-600 max-w-xl">
              Track every shift, prove your output, and improve week to week with clear personal and crew comparisons.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <a
                className="px-5 py-3 rounded-2xl bg-black text-white font-semibold hover:opacity-90 transition"
                href={appUrl}
                onClick={(e) => {
                  e.preventDefault();
                  track.clickNavigate('landing_hero_open_app', appUrl);
                }}
              >
                Open app
              </a>

              <a
                className="px-5 py-3 rounded-2xl border border-black/10 font-semibold hover:bg-black/5 transition"
                href={`${appUrl}/Register`}
                onClick={(e) => {
                  e.preventDefault();
                  track.signupStartNavigate('landing_hero_create_account', `${appUrl}/Register`);
                }}
              >
                Create account
              </a>

              <a
                className="px-5 py-3 rounded-2xl text-zinc-700 hover:bg-black/5 transition"
                href="/how-to"
                onClick={() => track.click('landing_hero_tutorials')}
              >
                View tutorials →
              </a>
            </div>

            {/* Trust strip */}
            <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm text-zinc-600">
              <div className="rounded-2xl border border-black/10 bg-white p-3">Operator-owned metrics</div>
              <div className="rounded-2xl border border-black/10 bg-white p-3">Offline-first syncing</div>
              <div className="rounded-2xl border border-black/10 bg-white p-3">Built for site reality</div>
              <div className="rounded-2xl border border-black/10 bg-white p-3">Power BI ready</div>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="rounded-[28px] border border-black/10 bg-white shadow-[0_18px_40px_rgba(0,0,0,0.12)] overflow-hidden">
              <img
                src="/landing/shift-portal.png"
                alt="Spectatore Shift Portal"
                className="w-full block object-contain max-h-[70vh] sm:max-h-none"
                loading="eager"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Features anchor */}
      <div ref={featuresRef} />

      {/* You vs You */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Improve your own performance</h2>
          <p className="mt-3 text-zinc-600">See trends, consistency and personal benchmarks at a glance.</p>
        </div>

        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
            <img
              src="/landing/you-vs-you-trend-cards.png"
              alt="You vs You trend cards"
              className="w-full block object-contain max-h-[70vh] sm:max-h-none"
              loading="lazy"
            />
            <figcaption className="px-5 py-4 text-sm text-zinc-600">Rolling averages and recent shifts</figcaption>
          </figure>

          <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
            <img
              src="/landing/you-vs-you-heatmap.png"
              alt="You vs You heatmap"
              className="w-full block object-contain max-h-[70vh] sm:max-h-none"
              loading="lazy"
            />
            <figcaption className="px-5 py-4 text-sm text-zinc-600">Daily output heatmap and benchmarks</figcaption>
          </figure>
        </div>
      </section>

      {/* You vs Crew */}
      <section className="bg-zinc-50 border-y border-black/5">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Compete with your crew</h2>
            <p className="mt-3 text-zinc-600">Know your rank and exactly how far ahead or behind you are.</p>
          </div>

          <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
              <img
                src="/landing/you-vs-crew-graph.png"
                alt="You vs Crew comparison"
                className="w-full block object-contain max-h-[70vh] sm:max-h-none"
                loading="lazy"
              />
              <figcaption className="px-5 py-4 text-sm text-zinc-600">Side-by-side period comparison</figcaption>
            </figure>

            <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
              <img
                src="/landing/you-vs-crew-comparison.png"
                alt="Crew rank"
                className="w-full block object-contain max-h-[70vh] sm:max-h-none"
                loading="lazy"
              />
              <figcaption className="px-5 py-4 text-sm text-zinc-600">Crew rank and totals</figcaption>
            </figure>
          </div>

          <div className="mt-10 flex flex-wrap gap-3">
            <a
              href="/how-to"
              className="px-5 py-3 rounded-2xl border border-black/10 bg-white hover:bg-black/5 transition font-semibold"
              onClick={() => track.click('landing_section_tutorials')}
            >
              Go to tutorials
            </a>
            <a
              href={appUrl}
              className="px-5 py-3 rounded-2xl bg-black text-white hover:opacity-90 transition font-semibold"
              onClick={(e) => {
                e.preventDefault();
                track.clickNavigate('landing_section_open_app', appUrl);
              }}
            >
              Open app
            </a>
          </div>
        </div>
      </section>

      {/* Site data management + Power BI */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
        <div className="max-w-3xl">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Site data management subscriptions</h2>
          <p className="mt-3 text-zinc-600">
            For sites, Spectatore can be implemented as a managed data workflow: operator form input → site validation → end of month
            reconciliation. Outputs can feed directly into Power BI for reporting.
          </p>
        </div>

        {/* Process flow */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
            <div className="font-semibold">1) User form input</div>
            <div className="mt-2 text-zinc-600">Operators capture shift activities in the PWA (offline-friendly).</div>
          </div>
          <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
            <div className="font-semibold">2) Site validation</div>
            <div className="mt-2 text-zinc-600">Site admins validate and reconcile exceptions before it hits reporting.</div>
          </div>
          <div className="rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
            <div className="font-semibold">3) End of month reconciliation</div>
            <div className="mt-2 text-zinc-600">Lock totals and export clean month-end numbers for finance / planning.</div>
          </div>
        </div>

        {/* Examples */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
            <img
              src="/landing/site-dev-mtd.png"
              alt="Power BI development MTD example"
              className="w-full block object-contain max-h-[70vh] sm:max-h-none"
              loading="lazy"
            />
            <figcaption className="px-5 py-4 text-sm text-zinc-600">Example: development month-to-date dashboard</figcaption>
          </figure>

          <figure className="rounded-3xl border border-black/10 bg-white shadow-sm overflow-hidden">
            <img
              src="/landing/site-ore-mtd1.png"
              alt="Power BI ore tonnes MTD example"
              className="w-full block object-contain max-h-[70vh] sm:max-h-none"
              loading="lazy"
            />
            <figcaption className="px-5 py-4 text-sm text-zinc-600">Example: ore tonnes hauled month-to-date dashboard</figcaption>
          </figure>
        </div>

      </section>

      {/* Contact */}
      <section ref={contactRef} className="mx-auto max-w-6xl px-4 py-16 sm:py-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          <div className="lg:col-span-5">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Contact</h2>
            <p className="mt-3 text-zinc-600">
              Want a demo, or to roll this out at site? Send a note and we’ll get back to you.
            </p>

            <div className="mt-6 rounded-3xl border border-black/10 bg-zinc-50 p-5 text-sm text-zinc-700">
              Prefer email? Contact us at <span className="font-semibold">support@spectatore.com</span>
            </div>
          </div>

          <div className="lg:col-span-7">
            <form
              onSubmit={(e) => {
                track.click('landing_contact_submit_attempt');
                submitContact(e);
              }}
              className="rounded-3xl border border-black/10 bg-white p-6 shadow-sm"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <div className="text-sm font-semibold">Name</div>
                  <input
                    className="mt-2 w-full rounded-2xl border border-black/10 px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                    required
                  />
                </label>

                <label className="block">
                  <div className="text-sm font-semibold">Email</div>
                  <input
                    className="mt-2 w-full rounded-2xl border border-black/10 px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email address"
                    type="email"
                    required
                  />
                </label>

                <label className="block">
                  <div className="text-sm font-semibold">Company</div>
                  <input
                    className="mt-2 w-full rounded-2xl border border-black/10 px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Company"
                  />
                </label>

                <label className="block">
                  <div className="text-sm font-semibold">Site</div>
                  <input
                    className="mt-2 w-full rounded-2xl border border-black/10 px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    value={site}
                    onChange={(e) => setSite(e.target.value)}
                    placeholder="Mine site"
                  />
                </label>

                <label className="block sm:col-span-2">
                  <div className="text-sm font-semibold">Message</div>
                  <textarea
                    className="mt-2 w-full min-h-[140px] rounded-2xl border border-black/10 px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="What do you want to know?"
                  />
                </label>
              </div>

              {error && <div className="mt-4 text-sm text-red-600">{error}</div>}
              {sent && <div className="mt-4 text-sm text-green-700">{sent}</div>}

              <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
                <button
                  type="submit"
                  disabled={sending}
                  className="px-5 py-3 rounded-2xl bg-black text-white font-semibold hover:opacity-90 transition disabled:opacity-60"
                >
                  {sending ? 'Sending…' : 'Submit'}
                </button>

                <div className="text-sm text-zinc-500">We’ll only use your details to respond.</div>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-black/10 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-10 flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-zinc-500">© {new Date().getFullYear()} Spectatore</div>
          <div className="flex items-center gap-3 text-sm">
            <a href="/how-to" className="text-zinc-600 hover:text-zinc-900" onClick={() => track.click('landing_footer_tutorials')}>
              Tutorials
            </a>
            <a href="/" className="text-zinc-600 hover:text-zinc-900" onClick={() => track.click('landing_footer_home')}>
              Home
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}