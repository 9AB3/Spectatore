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

  const fillFor = (cc: string) => {
    const u = byCC.get(cc) || 0;
    const k = intensityFor(u, maxUsers);
    return u > 0 ? `rgba(255,255,255,${0.10 + k * 0.55})` : 'rgba(255,255,255,0.06)';
  };

  const stroke = 'rgba(255,255,255,0.10)';

  return (
    <div className="w-full overflow-hidden rounded-2xl" style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
      <svg viewBox="0 0 1000 500" className="w-full h-auto block" role="img" aria-label="World usage heat map">
        <rect x="0" y="0" width="1000" height="500" fill="rgba(255,255,255,0.03)" />

        {/* Subtle continents backdrop */}
        <g opacity="0.55">
          <path d="M65,165 C95,120 160,95 235,110 C300,120 360,155 380,190 C400,225 380,270 330,285 C285,295 235,300 195,280 C150,260 95,230 65,195 Z" fill="rgba(255,255,255,0.05)" />
          <path d="M370,290 C395,270 435,265 465,285 C495,305 505,345 485,380 C465,415 430,430 400,410 C370,390 355,325 370,290 Z" fill="rgba(255,255,255,0.05)" />
          <path d="M430,140 C480,100 560,85 640,95 C720,105 790,130 860,170 C910,200 930,245 900,280 C870,315 820,315 760,305 C690,293 640,315 585,325 C535,333 485,320 455,290 C420,255 405,180 430,140 Z" fill="rgba(255,255,255,0.05)" />
          <path d="M520,330 C565,310 635,315 700,345 C760,373 785,420 760,450 C735,478 675,480 620,460 C565,440 510,385 520,330 Z" fill="rgba(255,255,255,0.05)" />
          <path d="M760,335 C790,320 840,320 875,340 C910,360 920,395 900,420 C880,445 835,452 800,435 C770,420 740,365 760,335 Z" fill="rgba(255,255,255,0.05)" />
        </g>

        {/* Highlightable country shapes (coarse, map-like) */}
        {/* Canada */}
        <path d="M120,135 L170,115 L250,120 L295,140 L260,160 L175,165 L120,150 Z" fill={fillFor('CA')} stroke={stroke} strokeWidth="1">
          <title>{`CA: ${fmtInt(byCC.get('CA') || 0)}`}</title>
        </path>

        {/* United States */}
        <path d="M130,170 L180,165 L260,170 L290,190 L260,210 L190,215 L135,200 Z" fill={fillFor('US')} stroke={stroke} strokeWidth="1">
          <title>{`US: ${fmtInt(byCC.get('US') || 0)}`}</title>
        </path>

        {/* United Kingdom */}
        <path d="M500,175 L512,170 L520,182 L512,195 L500,190 Z" fill={fillFor('GB')} stroke={stroke} strokeWidth="1">
          <title>{`GB: ${fmtInt(byCC.get('GB') || 0)}`}</title>
        </path>

        {/* New Zealand */}
        <path d="M885,385 L898,380 L905,392 L895,405 L883,398 Z" fill={fillFor('NZ')} stroke={stroke} strokeWidth="1">
          <title>{`NZ: ${fmtInt(byCC.get('NZ') || 0)}`}</title>
        </path>

        {/* Australia */}
        <path d="M780,360 L830,350 L880,360 L900,395 L875,430 L820,440 L780,420 L765,390 Z" fill={fillFor('AU')} stroke={stroke} strokeWidth="1">
          <title>{`AU: ${fmtInt(byCC.get('AU') || 0)}`}</title>
        </path>

        {/* Unknown/Other */}
        {byCC.get('UNK') ? (
          <g>
            <rect x="18" y="18" width="130" height="34" rx="10" fill="rgba(0,0,0,0.25)" stroke="rgba(255,255,255,0.10)" />
            <text x="30" y="40" fontSize="14" fill="rgba(255,255,255,0.85)">UNK: {fmtInt(byCC.get('UNK') || 0)}</text>
          </g>
        ) : null}
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
              ) : () : (
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
              )}</div>
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
