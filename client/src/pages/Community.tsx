import React, { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import { api } from '../lib/api';

type CountryRow = { country_code: string; users: number };

function cx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(' ');
}

function fmtInt(n: number) {
  const x = Number(n || 0);
  return x.toLocaleString();
}

function flagEmoji(cc: string) {
  const c = (cc || '').toUpperCase();
  if (c.length !== 2 || c === 'UK' || c === 'UNK') return '🌐';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const first = A + (c.charCodeAt(0) - base);
  const second = A + (c.charCodeAt(1) - base);
  return String.fromCodePoint(first, second);
}

export default function Community() {
  const [range, setRange] = useState<'today' | '7d' | '30d'>('today');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    live_now: number;
    today: number;
    top_countries: CountryRow[];
    map: CountryRow[];
    delay_minutes: number;
    live_window_minutes: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const r = await api(`/api/community/public-stats?range=${range}`);
        if (!alive) return;
        setData(r);
      } catch {
        if (!alive) return;
        setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range]);

  const top = data?.top_countries || [];
  const map = data?.map || [];

  const maxUsers = useMemo(() => {
    return Math.max(1, ...map.map((r) => Number(r.users || 0)));
  }, [map]);

  return (
    <div>
      <Header />

      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-2xl font-extrabold tracking-tight">Community</div>
            <div className="text-sm opacity-70 mt-1">
              Live app usage, shown at country level. Stats are aggregated and delayed.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cx('btn-secondary px-3 py-2 rounded-xl text-sm font-semibold', range === 'today' && 'ring-2')}
              onClick={() => setRange('today')}
              style={{ ringColor: 'var(--accent)' } as any}
            >
              Today
            </button>
            <button
              type="button"
              className={cx('btn-secondary px-3 py-2 rounded-xl text-sm font-semibold', range === '7d' && 'ring-2')}
              onClick={() => setRange('7d')}
              style={{ ringColor: 'var(--accent)' } as any}
            >
              7 days
            </button>
            <button
              type="button"
              className={cx('btn-secondary px-3 py-2 rounded-xl text-sm font-semibold', range === '30d' && 'ring-2')}
              onClick={() => setRange('30d')}
              style={{ ringColor: 'var(--accent)' } as any}
            >
              30 days
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mt-6">
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wide opacity-70">Live now</div>
            <div className="text-4xl font-extrabold mt-2">{loading ? '—' : fmtInt(data?.live_now || 0)}</div>
            <div className="text-xs opacity-60 mt-2">
              Active in the last ~{data?.live_window_minutes || 15} minutes (delayed ~{data?.delay_minutes || 10}m)
            </div>
          </div>

          <div className="card p-5">
            <div className="text-xs uppercase tracking-wide opacity-70">Today</div>
            <div className="text-4xl font-extrabold mt-2">{loading ? '—' : fmtInt(data?.today || 0)}</div>
            <div className="text-xs opacity-60 mt-2">Unique active users in the last 24 hours</div>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-4 mt-4">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div className="font-semibold">Top countries</div>
              <div className="text-xs opacity-60">{range === 'today' ? '24h' : range}</div>
            </div>

            <div className="mt-4 space-y-3">
              {loading ? (
                <div className="text-sm opacity-60">Loading…</div>
              ) : top.length ? (
                top.map((r) => {
                  const pct = Math.min(100, Math.round((Number(r.users || 0) / maxUsers) * 100));
                  return (
                    <div key={r.country_code} className="flex items-center gap-3">
                      <div className="w-8 text-lg">{flagEmoji(r.country_code)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">{r.country_code === 'UNK' ? 'Other/Unknown' : r.country_code}</div>
                          <div className="text-sm font-bold">{fmtInt(r.users)}</div>
                        </div>
                        <div className="h-2 rounded-full mt-1" style={{ background: 'rgba(255,255,255,0.08)' }}>
                          <div
                            className="h-2 rounded-full"
                            style={{
                              width: `${pct}%`,
                              background: 'var(--accent)',
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-sm opacity-60">Not enough data yet.</div>
              )}
            </div>

            <div className="text-[11px] opacity-60 mt-4">
              Countries with very small counts are hidden for privacy.
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div className="font-semibold">World map (country heat)</div>
              <div className="text-xs opacity-60">{range === 'today' ? '24h' : range}</div>
            </div>

            <div className="mt-4">
              {loading ? (
                <div className="text-sm opacity-60">Loading…</div>
              ) : map.length ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {map.slice(0, 36).map((r) => {
                    const intensity = Math.max(0.15, Math.min(1, Number(r.users || 0) / maxUsers));
                    return (
                      <div
                        key={r.country_code}
                        className="rounded-xl p-3 flex items-center justify-between gap-2"
                        style={{
                          background: `rgba(255,255,255,${0.06 + intensity * 0.18})`,
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                        title={`${r.country_code}: ${fmtInt(r.users)}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="text-lg">{flagEmoji(r.country_code)}</div>
                          <div className="text-sm font-semibold truncate">{r.country_code}</div>
                        </div>
                        <div className="text-sm font-bold">{fmtInt(r.users)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-sm opacity-60">Not enough data yet.</div>
              )}
            </div>

            <div className="text-[11px] opacity-60 mt-4">
              This is a country heat list to keep it fast + privacy-safe. We can upgrade to a true choropleth map later.
            </div>
          </div>
        </div>

        <div className="card p-4 mt-4">
          <div className="text-sm font-semibold">How this works</div>
          <div className="text-xs opacity-70 mt-1">
            When Spectatore is open, the app sends a lightweight heartbeat. We aggregate counts (no names shown) and display
            countries only.
          </div>
        </div>
      </div>
    </div>
  );
}
