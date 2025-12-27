import Header from '../components/Header';
import BottomNav from '../components/BottomNav';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const MILESTONE_METRICS = [
  'GS Drillm',
  'Face Drillm',
  'Headings supported',
  'Headings bored',
  'Truck Loads',
  "TKM's",
  'Tonnes Hauled',
  'Production drillm',
  'Primary Production buckets',
  'Primary Development buckets',
  'Tonnes charged',
  'Headings Fired',
  'Tonnes Fired',
  'Ore tonnes hoisted',
  'Waste tonnes hoisted',
  'Total tonnes hoisted',
] as const;

type Metric = (typeof MILESTONE_METRICS)[number];

type NetworkResp = {
  metric: Metric;
  members: Array<{ id: number; name: string; email: string }>;
  userBest: { total: number; date: string };
  networkBest: { total: number; date: string; user_id: number; name: string };
  compare?: { user_id: number; name: string; email: string } | null;
  timeline: Array<{ date: string; user: number; network_avg: number; network_best: number; compare?: number }>;
};

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtYmd(ymdStr: string) {
  // dd/mmm
  try {
    const d = new Date(ymdStr + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const m = d.toLocaleString(undefined, { month: 'short' });
    return `${dd}/${m}`;
  } catch {
    return ymdStr;
  }
}

function LineChart({
  rows,
  bLabel,
  yLabel,
}: {
  rows: Array<{ x: string; a: number; b: number }>;
  bLabel: string;
  yLabel: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  // RESET hover when rows change (dates / metric change)
  useEffect(() => {
    setHover(null);
  }, [rows]);

  const pts = useMemo(() => {
    const w = 900;
    const h = 260; // <- a bit taller for x labels
    const pad = 34; // <- more padding for x labels

    const xs = rows.map((_, i) => (rows.length <= 1 ? 0.5 : i / (rows.length - 1)));
    const maxV = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));

    const mapX = (t: number) => pad + t * (w - pad * 2);
    const mapY = (v: number) => h - pad - (v / maxV) * (h - pad * 2);

    const a = rows.map((r, i) => ({ x: mapX(xs[i]), y: mapY(r.a), v: r.a, label: r.x }));
    const b = rows.map((r, i) => ({ x: mapX(xs[i]), y: mapY(r.b), v: r.b, label: r.x }));

    // tick labels: aim for ~7 labels + always include first/last
    const tickEvery = rows.length <= 8 ? 1 : Math.ceil(rows.length / 7);
    const ticks = rows
      .map((r, i) => ({ i, label: r.x }))
      .filter((t, idx) => idx === 0 || idx === rows.length - 1 || idx % tickEvery === 0);

    return { w, h, pad, maxV, a, b, ticks };
  }, [rows]);

  const path = (arr: Array<{ x: number; y: number }>) => {
    if (arr.length === 0) return '';
    return arr.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  };

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || rows.length === 0) return;

    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;

    const rel = Math.max(0, Math.min(1, (x - pts.pad) / (pts.w - pts.pad * 2)));
    const i = Math.round(rel * (rows.length - 1));

    const ax = pts.a[i]?.x ?? x;
    const ay = Math.min(pts.a[i]?.y ?? 0, pts.b[i]?.y ?? 0);
    setHover({ i, x: ax, y: ay });
  };

  return (
    <div ref={ref} className="w-full relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${pts.w} ${pts.h}`} className="w-full h-[280px]">
        {/* Y axis label */}
        <text
          x={12}
          y={pts.pad + (pts.h - pts.pad * 2) / 2}
          transform={`rotate(-90 12 ${pts.pad + (pts.h - pts.pad * 2) / 2})`}
          textAnchor="middle"
          fontSize="12"
          fontWeight={700}
          fill="#334155"
        >
          {yLabel}
        </text>

        {/* axes */}
        <path
          d={`M${pts.pad},${pts.pad} V${pts.h - pts.pad} H${pts.w - pts.pad}`}
          fill="none"
          stroke="currentColor"
          opacity={0.25}
        />

        {/* X axis title */}
        <text
          x={(pts.w + pts.pad) / 2}
          y={pts.h - 8}
          textAnchor="middle"
          fontSize="12"
          fontWeight={700}
          fill="#334155"
        >
          Date
        </text>

        {/* X ticks + labels */}
        {pts.ticks.map((t) => {
          const x = pts.a[t.i]?.x ?? pts.pad;
          return (
            <g key={t.i}>
              <line
                x1={x}
                y1={pts.h - pts.pad}
                x2={x}
                y2={pts.h - pts.pad + 6}
                stroke="currentColor"
                opacity={0.25}
              />
              <text
                x={x}
                y={pts.h - pts.pad + 18}
                textAnchor="middle"
                fontSize="10"
                fill="#334155"
                opacity={0.85}
              >
                {fmtYmd(t.label)}
              </text>
            </g>
          );
        })}

        {/* lines */}
        <path d={path(pts.a)} fill="none" stroke="currentColor" strokeWidth={2} />
        <path
          d={path(pts.b)}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="6 6"
          opacity={0.85}
        />

        {/* hover marker */}
        {hover
          ? (() => {
              const i = Math.max(0, Math.min(rows.length - 1, hover.i));
              const aPt = pts.a[i];
              const bPt = pts.b[i];
              if (!aPt || !bPt) return null;

              return (
                <>
                  <line
                    x1={aPt.x}
                    y1={pts.pad}
                    x2={aPt.x}
                    y2={pts.h - pts.pad}
                    stroke="currentColor"
                    opacity={0.12}
                  />
                  <circle cx={aPt.x} cy={aPt.y} r={4} fill="currentColor" />
                  <circle cx={bPt.x} cy={bPt.y} r={4} fill="currentColor" opacity={0.6} />
                </>
              );
            })()
          : null}
      </svg>

      {/* hover tooltip */}
      {hover ? (
        <div
          className="absolute pointer-events-none text-xs px-2 py-1 rounded-xl border"
          style={{
            borderColor: '#e9d9c3',
            background: 'var(--card)',
            transform: 'translate(-50%, -110%)',
            left: `${(hover.x / pts.w) * 100}%`,
            top: 0,
          }}
        >
          <div className="font-semibold">{fmtYmd(rows[hover.i].x)}</div>
          <div>You: {rows[hover.i].a.toFixed(1)}</div>
          <div>
            {bLabel}: {rows[hover.i].b.toFixed(1)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function YouVsNetwork() {
  const location = useLocation();
  const nav = useNavigate();
  const [from, setFrom] = useState(() => {
    // Default: start of current month
    const d = new Date();
    d.setDate(1);
    return ymd(d);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [metric, setMetric] = useState<Metric>('Tonnes Hauled');

  // Allow deep-linking from push notifications, e.g. /YouVsNetwork?metric=Tonnes%20Hauled
  useEffect(() => {
    try {
      const sp = new URLSearchParams(location.search);
      const m = (sp.get('metric') || '').trim();
      if (!m) return;

      // match ignoring case against known metrics (no readonly->mutable cast)
      const hit = MILESTONE_METRICS.find((x) => x.toLowerCase() === m.toLowerCase());
      if (hit) setMetric(hit);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const [compareUserId, setCompareUserId] = useState<number>(0); // 0 = network avg
  const [mode, setMode] = useState<'daily' | 'cumulative'>('cumulative');
  const [data, setData] = useState<NetworkResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true);
    setErr('');
    try {
      const cmp = compareUserId ? `&compare_user_id=${encodeURIComponent(String(compareUserId))}` : '';
      const r = (await api(
        `/api/reports/network?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}${cmp}`
      )) as NetworkResp;
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, compareUserId, from, to]);

  const dailyRows = useMemo(() => {
    const tl = data?.timeline || [];
    // If comparing against a specific member, server returns timeline.compare; otherwise we fall back to network_avg.
    return tl.map((r) => ({ x: r.date, a: Number(r.user || 0), b: Number((r as any).compare ?? r.network_avg ?? 0) }));
  }, [data]);

  const cumulativeRows = useMemo(() => {
    let aSum = 0;
    let bSum = 0;
    return dailyRows.map((r) => {
      aSum += Number(r.a || 0);
      bSum += Number(r.b || 0);
      return { x: r.x, a: aSum, b: bSum };
    });
  }, [dailyRows]);

  const rows = useMemo(() => (mode === 'cumulative' ? cumulativeRows : dailyRows), [mode, cumulativeRows, dailyRows]);

  const cumSummary = useMemo(() => {
    const last = cumulativeRows[cumulativeRows.length - 1];
    const a = last?.a ?? 0;
    const b = last?.b ?? 0;
    const pct = b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0;
    return { a, b, pct };
  }, [cumulativeRows]);

  const bLabel = useMemo(() => {
    const name = data?.compare?.name?.trim();
    return name ? name : 'Network avg';
  }, [data]);

  return (
    <div>
      <Header />
      <div className="max-w-2xl mx-auto p-4 pb-24 space-y-4">
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-lg font-semibold">You vs Network</div>
              <div className="text-sm opacity-70">Compare your performance to your crew connections.</div>
            </div>
            <div className="flex gap-2">
              <button className="btn" onClick={() => nav('/YouVsYou')} title="You vs You">
                You
              </button>
              <button className="btn" onClick={() => nav('/Connections')} title="Crew">
                Crew
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-4 gap-3 mb-3">
            <div>
              <label className="block text-xs opacity-70 mb-1">From</label>
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">To</label>
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Metric</label>
              <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                {MILESTONE_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs opacity-70 mb-1">Compare to</label>
              <select
                className="input"
                value={String(compareUserId)}
                onChange={(e) => setCompareUserId(parseInt(e.target.value || '0', 10) || 0)}
              >
                <option value="0">Network avg</option>
                {(data?.members || []).map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
              <div className="text-[11px] opacity-70 mt-1">Choose a crew mate to compare one-on-one, or leave on Network avg.</div>
            </div>
          </div>

          <div className="flex gap-2 mb-3">
            <button className="btn" onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>

            <div className="flex rounded-xl border overflow-hidden" style={{ borderColor: '#e9d9c3' }}>
              <button
                className={`px-3 py-2 text-sm ${mode === 'daily' ? 'font-semibold' : 'opacity-70'}`}
                onClick={() => setMode('daily')}
                type="button"
              >
                Daily
              </button>
              <button
                className={`px-3 py-2 text-sm border-l ${mode === 'cumulative' ? 'font-semibold' : 'opacity-70'}`}
                style={{ borderColor: '#e9d9c3' }}
                onClick={() => setMode('cumulative')}
                type="button"
              >
                Cumulative
              </button>
            </div>

            <div className="text-sm opacity-70 flex items-center">
              {data?.members?.length ? `${data.members.length} crew mates in network` : 'No crew mates yet'}
            </div>
          </div>

          {err ? (
            <div className="text-sm" style={{ color: '#b00020' }}>
              {err}
            </div>
          ) : null}

          {rows.length ? (
            <div className="relative">
              <div className="text-xs opacity-70 mb-2">
                Solid = you, dashed = {bLabel} • {mode === 'cumulative' ? 'cumulative total' : 'daily total'}
              </div>

              <LineChart rows={rows} bLabel={bLabel} yLabel={metric} />

              {/* cumulative summary */}
              <div className="grid md:grid-cols-3 gap-3 mt-3">
                <div className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-xs opacity-70">
                    Your cumulative ({from} → {to})
                  </div>
                  <div className="text-lg font-semibold">{cumSummary.a.toFixed(1)}</div>
                </div>
                <div className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-xs opacity-70">{bLabel} cumulative</div>
                  <div className="text-lg font-semibold">{cumSummary.b.toFixed(1)}</div>
                </div>
                <div className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-xs opacity-70">You vs {bLabel}</div>
                  <div className="text-lg font-semibold">
                    {cumSummary.pct >= 0 ? '+' : ''}
                    {cumSummary.pct.toFixed(1)}%
                  </div>
                  <div className="text-sm opacity-70">{cumSummary.pct >= 0 ? 'Above' : 'Below'} for selected period</div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-3 mt-3">
                <div className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-xs opacity-70">Your best day</div>
                  <div className="text-lg font-semibold">{(data?.userBest?.total || 0).toFixed(1)}</div>
                  <div className="text-sm opacity-70">{data?.userBest?.date || '-'}</div>
                </div>
                <div className="p-3 rounded-2xl border" style={{ borderColor: '#e9d9c3' }}>
                  <div className="text-xs opacity-70">Network best day</div>
                  <div className="text-lg font-semibold">{(data?.networkBest?.total || 0).toFixed(1)}</div>
                  <div className="text-sm opacity-70">
                    {data?.networkBest?.date || '-'}
                    {data?.networkBest?.name ? ` • ${data.networkBest.name}` : ''}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm opacity-70">No data in range.</div>
          )}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
