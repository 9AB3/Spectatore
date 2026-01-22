import React, { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import { api } from '../lib/api';

type CountryRow = { country_code: string; users: number };

type StateRow = { state: string; users: number };

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


type MapDatum = { country_code: string; users: number };

function intensityFor(users: number, maxUsers: number) {
  const u = Number(users || 0);
  const m = Math.max(1, Number(maxUsers || 1));
  return Math.max(0.12, Math.min(1, u / m));
}

function WorldChoroplethSvg({ data, maxUsers }: { data: MapDatum[]; maxUsers: number }) {
  const byCC = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data || []) m.set((r.country_code || 'UNK').toUpperCase(), Number(r.users || 0));
    return m;
  }, [data]);

  // Very lightweight centroid hints (coarse, but gives a recognisable "users on the map" feel)
  const CENTROIDS: Record<string, { x: number; y: number }> = {
    CA: { x: 205, y: 150 },
    US: { x: 220, y: 215 },
    MX: { x: 235, y: 265 },
    BR: { x: 330, y: 365 },
    AR: { x: 340, y: 425 },
    CL: { x: 305, y: 420 },

    GB: { x: 485, y: 175 },
    IE: { x: 470, y: 180 },
    FR: { x: 505, y: 200 },
    DE: { x: 525, y: 185 },
    ES: { x: 495, y: 225 },
    IT: { x: 530, y: 230 },
    NL: { x: 520, y: 175 },
    SE: { x: 540, y: 150 },
    NO: { x: 525, y: 145 },
    PL: { x: 555, y: 190 },
    RU: { x: 700, y: 140 },

    EG: { x: 560, y: 265 },
    NG: { x: 520, y: 330 },
    ZA: { x: 560, y: 430 },

    TR: { x: 585, y: 230 },
    SA: { x: 610, y: 300 },
    AE: { x: 635, y: 290 },

    IN: { x: 670, y: 285 },
    PK: { x: 645, y: 275 },
    BD: { x: 700, y: 295 },
    TH: { x: 735, y: 315 },
    VN: { x: 760, y: 320 },
    MY: { x: 760, y: 345 },
    SG: { x: 772, y: 352 },
    ID: { x: 800, y: 375 },
    PH: { x: 820, y: 310 },

    CN: { x: 770, y: 245 },
    KR: { x: 835, y: 235 },
    JP: { x: 875, y: 235 },

    AU: { x: 835, y: 405 },
    NZ: { x: 915, y: 440 },
  };

  const entries = useMemo(() => {
    const out: Array<{ cc: string; users: number; x: number; y: number }> = [];
    for (const [cc, users] of byCC.entries()) {
      const c = CENTROIDS[cc];
      if (!c) continue;
      out.push({ cc, users, x: c.x, y: c.y });
    }
    // Prefer showing the most active countries if many exist
    out.sort((a, b) => b.users - a.users);
    return out.slice(0, 18);
  }, [byCC]);

  const rFor = (users: number) => {
    const u = Math.max(0, Number(users || 0));
    // No glow: just slightly larger icon for more users
    return Math.min(16, 8 + u * 1.6);
  };

  const ringFor = (users: number) => {
    // subtle ring, not a glow
    const k = intensityFor(Number(users || 0), maxUsers);
    return `rgba(176,132,44,${0.25 + k * 0.35})`;
  };

  const markerFill = 'rgba(176,132,44,0.95)';

  return (
    <div className="w-full overflow-hidden rounded-2xl" style={{ border: '1px solid rgba(0,0,0,0.08)' }}>
      <svg viewBox="0 0 1000 500" className="w-full h-auto block" role="img" aria-label="World usage map">
        <rect x="0" y="0" width="1000" height="500" fill="rgba(0,0,0,0.02)" />

        {/* World silhouette (simple + recognisable, works well in light UI cards) */}
        <g className="text-black/70 dark:text-white/20">
          {/* North America */}
          <path
            d="M140,130 L210,105 L295,120 L330,155 L310,190 L275,205 L240,200 L215,215 L175,200 L150,175 Z"
            fill="currentColor"
            opacity="0.55"
          />
          {/* Greenland */}
          <path d="M310,95 L350,85 L385,95 L370,120 L335,120 Z" fill="currentColor" opacity="0.35" />
          {/* South America */}
          <path
            d="M300,250 L340,255 L365,285 L360,320 L350,360 L330,415 L305,420 L295,385 L305,340 L295,300 Z"
            fill="currentColor"
            opacity="0.55"
          />
          {/* Europe */}
          <path
            d="M470,160 L510,150 L540,160 L545,185 L520,200 L485,195 L465,180 Z"
            fill="currentColor"
            opacity="0.55"
          />
          {/* Africa */}
          <path
            d="M520,230 L565,240 L590,275 L585,320 L565,365 L535,410 L505,395 L490,350 L495,295 Z"
            fill="currentColor"
            opacity="0.55"
          />
          {/* Asia */}
          <path
            d="M545,155 L620,140 L710,150 L800,185 L860,225 L845,265 L780,265 L735,245 L695,265 L645,255 L610,275 L580,255 L560,220 Z"
            fill="currentColor"
            opacity="0.55"
          />
          {/* SE Asia islands (hint) */}
          <path d="M770,305 L810,315 L825,335 L790,345 L760,330 Z" fill="currentColor" opacity="0.45" />
          {/* Australia */}
          <path d="M800,360 L860,360 L900,395 L890,435 L835,450 L795,420 Z" fill="currentColor" opacity="0.55" />
          {/* New Zealand */}
          <path d="M920,445 L940,455 L935,475 L915,470 Z" fill="currentColor" opacity="0.45" />
        </g>

        {/* User markers */}
        {entries.map(({ cc, users, x, y }) => {
          const r = rFor(users);
          return (
            <g key={cc} transform={`translate(${x},${y})`}>
              <title>{cc} • {users} user{users === 1 ? '' : 's'}</title>
              <circle r={r + 2} fill={ringFor(users)} />
              <circle r={r} fill={markerFill} />
              {/* simple "user" icon */}
              <g fill="rgba(255,255,255,0.98)">
                <circle cx="0" cy={-r * 0.25} r={Math.max(2.8, r * 0.28)} />
                <path
                  d={`
                    M ${-r * 0.55} ${r * 0.70}
                    C ${-r * 0.55} ${r * 0.25}, ${-r * 0.22} ${r * 0.05}, 0 ${r * 0.05}
                    C ${r * 0.22} ${r * 0.05}, ${r * 0.55} ${r * 0.25}, ${r * 0.55} ${r * 0.70}
                    Z
                  `}
                />
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function Community() {
  const [range, setRange] = useState<'today' | '7d' | '30d'>('today');
  const [mapMode, setMapMode] = useState<'world' | 'aus'>('world');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    live_now: number;
    today: number;
    top_countries: CountryRow[];
    map: CountryRow[];
    au_states: StateRow[];
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
  const auStates = (data as any)?.au_states || [] as StateRow[];

  const maxUsers = useMemo(() => {
    return Math.max(1, ...map.map((r) => Number(r.users || 0)));
  }, [map]);

  const maxAuUsers = useMemo(() => {
    return Math.max(1, ...auStates.map((r: any) => Number(r.users || 0)));
  }, [auStates]);

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
                          <div className="text-sm font-bold">{fmtInt(r.users)}
            </div>
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
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="font-semibold">{mapMode === 'aus' ? 'Australia map (state heat)' : 'World map (country heat)'}</div>
              <div className="flex items-center gap-2">
                <button
                  className={cx('px-3 py-1 rounded-full text-xs border', mapMode === 'world' ? 'bg-white/10 border-white/15' : 'border-white/10 opacity-80')}
                  onClick={() => setMapMode('world')}
                  type="button"
                >
                  World
                </button>
                <button
                  className={cx('px-3 py-1 rounded-full text-xs border', mapMode === 'aus' ? 'bg-white/10 border-white/15' : 'border-white/10 opacity-80')}
                  onClick={() => setMapMode('aus')}
                  type="button"
                >
                  Australia
                </button>
                <div className="text-xs opacity-60 ml-1">{range === 'today' ? '24h' : range}</div>
              </div>
            </div>

            <div className="mt-4">
              {loading ? (
                <div className="text-sm opacity-60">Loading…</div>
              ) : mapMode === 'world' ? (
                map.length ? (
                  <div>
                    <WorldChoroplethSvg data={map} maxUsers={maxUsers} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
                      {map.slice(0, 12).map((r) => {
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
                            <div className="text-sm font-semibold">{fmtInt(r.users)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="text-xs opacity-60 mt-3">
                      Map highlights key countries (starting with AU). The list shows the top countries in this range.
                    </div>
                  </div>
                ) : (
                  <div className="text-sm opacity-60">No data yet.</div>
                )
              ) : (
                auStates.length ? (
                  <div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {auStates.map((r: any) => {
                        const intensity = Math.max(0.15, Math.min(1, Number(r.users || 0) / maxAuUsers));
                        return (
                          <div
                            key={r.state}
                            className="rounded-xl p-3 flex items-center justify-between gap-2"
                            style={{
                              background: `rgba(255,255,255,${0.06 + intensity * 0.18})`,
                              border: '1px solid rgba(255,255,255,0.08)',
                            }}
                            title={`${r.state}: ${fmtInt(r.users)}`}
                          >
                            <div className="text-sm font-semibold">{r.state}</div>
                            <div className="text-sm font-semibold">{fmtInt(r.users)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="text-xs opacity-60 mt-3">
                      State heat uses automatic Vercel geo headers when available; otherwise it falls back to your optional State setting.
                    </div>
                  </div>
                ) : (
                  <div className="text-sm opacity-60">Not enough Australia data yet.</div>
                )
	              )}
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
