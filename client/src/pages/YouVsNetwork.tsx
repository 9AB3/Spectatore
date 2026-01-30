// Wrapped by /You hub, so no standalone header/nav needed here.
import TvTileRow from '../components/TvTileRow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { track } from '../lib/analytics';

const fmtInt = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }).format(Math.round(Number(n || 0)));

const fmtFull = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }).format(Math.round(Number(n || 0)));

// Compact display that never truncates (no ellipsis): 12,400 -> 12.4k, 1,250,000 -> 1.3m
function fmtCompact(n: number | null | undefined) {
  const v = Math.round(Number(n || 0));
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1_000_000) {
    const m = a / 1_000_000;
    const dp = m < 10 ? 1 : 0;
    return `${sign}${m.toFixed(dp)}m`;
  }
  if (a >= 100_000) {
    // keep it short at high 100k+ values
    const k = a / 1000;
    return `${sign}${k.toFixed(0)}k`;
  }
  if (a >= 10_000) {
    const k = a / 1000;
    return `${sign}${k.toFixed(1)}k`;
  }
  return fmtFull(v);
}

const fmtPct0 = (n: number | null | undefined) => {
  const v = Number(n || 0);
  const sign = v > 0 ? '+' : '';
  return `${sign}${Math.round(v)}%`;
};

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
  'Spray Volume',
  'Agi Volume',
  'Backfill volume',
  'Backfill buckets',
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
  userPeriodTotal?: number;
  crewTotals?: Array<{ id: number; name: string; email: string; total: number }>;
  userAllTimeBest?: { total: number; date: string };
  userPeriodAvg?: number;
  crewTiles?: Array<{
    id: number;
    name: string;
    email: string;
    theirAllTimeBest: { total: number; date: string };
    theirPeriodAvg: number;
    yourAllTimeBest: { total: number; date: string };
    yourPeriodAvg: number;
    deltaPct: number;
  }>;
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

function fmtShortDate(ymdStr: string) {
  // e.g. 13 Jan 26 (compact for iPhone tiles)
  try {
    const d = new Date(ymdStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
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
    let pad = 34; // dynamic: adjusted below for large Y-axis labels

    const xs = rows.map((_, i) => (rows.length <= 1 ? 0.5 : i / (rows.length - 1)));
    const rawMax = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));

    // Nice rounded Y scale so axis labels feel clean (Power BI-style).
    const approxStep = rawMax / 4;
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, approxStep))));
    const frac = approxStep / pow10;
    const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    const step = niceFrac * pow10;
    const maxV = Math.max(step, Math.ceil(rawMax / step) * step);
    const yTicks = [0, maxV * 0.25, maxV * 0.5, maxV * 0.75, maxV];

    const maxLabelLen = Math.max(...yTicks.map((v) => fmtCompact(v).length));
    pad = Math.max(pad, 18 + maxLabelLen * 7);

    const mapX = (t: number) => pad + t * (w - pad * 2);
    const mapY = (v: number) => h - pad - (v / maxV) * (h - pad * 2);

    const a = rows.map((r, i) => ({ x: mapX(xs[i]), y: mapY(r.a), v: r.a, label: r.x }));
    const b = rows.map((r, i) => ({ x: mapX(xs[i]), y: mapY(r.b), v: r.b, label: r.x }));

    // tick labels: aim for ~7 labels + always include first/last
    const tickEvery = rows.length <= 8 ? 1 : Math.ceil(rows.length / 7);
    const ticks = rows
      .map((r, i) => ({ i, label: r.x }))
      .filter((t, idx) => idx === 0 || idx === rows.length - 1 || idx % tickEvery === 0);

    return { w, h, pad, maxV, a, b, ticks, yTicks };
  }, [rows]);

  const path = (arr: Array<{ x: number; y: number }>) => {
    if (arr.length === 0) return '';
    return arr.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  };

  const areaPath = (arr: Array<{ x: number; y: number }>) => {
    if (arr.length === 0) return '';
    const baseY = pts.h - pts.pad;
    const first = arr[0];
    const last = arr[arr.length - 1];
    const top = arr.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `${top} L${last.x.toFixed(1)},${baseY.toFixed(1)} L${first.x.toFixed(1)},${baseY.toFixed(1)} Z`;
  };

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || rows.length === 0) return;

    const r = el.getBoundingClientRect();
    const xPx = e.clientX - r.left;

    // Convert from pixels → SVG viewBox units so hover/tooltip aligns correctly.
    const x = (xPx / Math.max(1, r.width)) * pts.w;

    const rel = Math.max(0, Math.min(1, (x - pts.pad) / (pts.w - pts.pad * 2)));
    const i = Math.round(rel * (rows.length - 1));

    const ax = pts.a[i]?.x ?? x;
    const ay = Math.min(pts.a[i]?.y ?? 0, pts.b[i]?.y ?? 0);
    setHover({ i, x: ax, y: ay });
  };

  return (
    <div ref={ref} className="w-full relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${pts.w} ${pts.h}`} className="w-full h-[280px]">
        <defs>
          <linearGradient id="goldLine" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(242, 211, 128, 0.95)" />
            <stop offset="60%" stopColor="rgba(184,135,47,0.92)" />
            <stop offset="100%" stopColor="rgba(96, 62, 18, 0.92)" />
          </linearGradient>
          <linearGradient id="goldArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(242, 211, 128, 0.22)" />
            <stop offset="100%" stopColor="rgba(184,135,47,0.02)" />
          </linearGradient>
          <linearGradient id="crewBlue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(110, 231, 255, 0.95)" />
            <stop offset="100%" stopColor="rgba(10,132,255,0.85)" />
          </linearGradient>
          <filter id="goldGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="rgba(184,135,47,0.35)" />
          </filter>
        </defs>
        {/* Y axis label */}
        <text
          x={12}
          y={pts.pad + (pts.h - pts.pad * 2) / 2}
          transform={`rotate(-90 12 ${pts.pad + (pts.h - pts.pad * 2) / 2})`}
          textAnchor="middle"
          fontSize="12"
          fontWeight={700}
          fill="var(--chart-title)"
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
          fill="var(--chart-title)"
        >
          Date
        </text>

        {/* Y ticks + labels */}
        {pts.yTicks.map((v: number, idx: number) => {
          const y = pts.h - pts.pad - (v / pts.maxV) * (pts.h - pts.pad * 2);
          return (
            <g key={idx}>
              <line x1={pts.pad - 4} y1={y} x2={pts.pad} y2={y} stroke="currentColor" opacity={0.25} />
              <line x1={pts.pad} y1={y} x2={pts.w - pts.pad} y2={y} stroke="currentColor" opacity={0.08} />
              <text
                x={pts.pad - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--chart-title)"
                opacity={0.85}
              >
                {fmtCompact(v)}
              </text>
            </g>
          );
        })}

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
                fill="var(--chart-title)"
                opacity={0.85}
              >
                {fmtYmd(t.label)}
              </text>
            </g>
          );
        })}

        {/* area fill (you) */}
        <path d={areaPath(pts.a)} fill="url(#goldArea)" />

        {/* lines */}
        <path d={path(pts.a)} fill="none" stroke="url(#goldLine)" strokeWidth={3} filter="url(#goldGlow)" />
        <path
          d={path(pts.b)}
          fill="none"
          stroke="url(#crewBlue)"
          strokeWidth={3}
          strokeDasharray="8 6"
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
                  <circle cx={aPt.x} cy={aPt.y} r={4} fill="rgba(242, 211, 128, 0.95)" />
                  <circle cx={bPt.x} cy={bPt.y} r={4} fill="rgba(10,132,255,0.9)" opacity={0.9} />
                </>
              );
            })()
          : null}
      </svg>

      {/* hover tooltip */}
      {hover ? (() => {
        const clampedY = Math.min(Math.max(hover.y, pts.pad + 12), pts.h - pts.pad - 12);
        return (
        <div
          className="absolute pointer-events-none text-xs px-2 py-1 rounded-xl border"
          style={{
            borderColor: 'rgba(148,163,184,0.35)',
            background: 'var(--card)',
            transform: 'translate(-50%, -120%)',
            left: `${(hover.x / pts.w) * 100}%`,
            top: `${(clampedY / pts.h) * 100}%`,
          }}
        >
          <div className="font-semibold">{fmtYmd(rows[hover.i].x)}</div>
          <div>You: {fmtInt(rows[hover.i].a)}</div>
          <div>
            {bLabel}: {fmtInt(rows[hover.i].b)}
          </div>
        </div>
      );})() : null}
    </div>
  );
}


function ColumnChartDaily({
  rows,
  bLabel,
  yLabel,
}: {
  rows: Array<{ x: string; a: number; b: number }>;
  bLabel: string;
  yLabel: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ i: number } | null>(null);

  // Reset hover when data changes
  useEffect(() => {
    setHover(null);
  }, [rows]);

  const pts = useMemo(() => {
    const w = 900;
    const h = 260;
    let pad = 34; // dynamic: adjusted below for large Y-axis labels

    const rawMax = Math.max(1, ...rows.flatMap((r) => [Number(r.a || 0), Number(r.b || 0)]));

    // Nice rounded Y scale (match line chart)
    const approxStep = rawMax / 4;
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, approxStep))));
    const frac = approxStep / pow10;
    const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    const step = niceFrac * pow10;
    const maxV = Math.max(step, Math.ceil(rawMax / step) * step);
    const yTicks = [0, maxV * 0.25, maxV * 0.5, maxV * 0.75, maxV];

    const maxLabelLen = Math.max(...yTicks.map((v) => fmtCompact(v).length));
    pad = Math.max(pad, 18 + maxLabelLen * 7);

    const mapX = (t: number) => pad + t * (w - pad * 2);
    const mapY = (v: number) => h - pad - (v / maxV) * (h - pad * 2);

    const xs = rows.map((_, i) => (rows.length <= 1 ? 0.5 : i / (rows.length - 1)));

    // tick labels: aim for ~7 labels + always include first/last
    const tickEvery = rows.length <= 8 ? 1 : Math.ceil(rows.length / 7);
    const ticks = rows
      .map((r, i) => ({ i, label: r.x }))
      .filter((t, idx) => idx === 0 || idx === rows.length - 1 || idx % tickEvery === 0);

    // bar sizing (slot-based, responsive-looking)
    const plotW = w - pad * 2;
    const slotW = plotW / Math.max(1, rows.length);
    const groupW = Math.max(14, Math.min(34, slotW * 0.75)); // total width for the pair
    const gap = Math.max(4, Math.min(8, groupW * 0.18));
    const barW = Math.max(6, (groupW - gap) / 2);

    return { w, h, pad, maxV, yTicks, xs, mapX, mapY, ticks, groupW, gap, barW };
  }, [rows]);

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || rows.length === 0) return;

    const r = el.getBoundingClientRect();
    const xPx = e.clientX - r.left;

    // Convert pixels → SVG viewBox units so the hover aligns at any screen width
    const x = (xPx / Math.max(1, r.width)) * pts.w;
    const rel = Math.max(0, Math.min(1, (x - pts.pad) / (pts.w - pts.pad * 2)));
    const i = Math.round(rel * (rows.length - 1));
    setHover({ i: Math.max(0, Math.min(rows.length - 1, i)) });
  };

  const idx = hover?.i ?? null;
  const row = idx === null ? null : rows[idx];

  // Hover marker x coordinate (center of group)
  const hx = idx === null ? 0 : pts.mapX(pts.xs[idx]);

  const fmtTick = (v: number) => fmtInt(v);

  return (
    <div ref={ref} className="w-full relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${pts.w} ${pts.h}`} className="w-full h-[280px] select-none">
        <defs>
          <linearGradient id="goldBarDaily_v2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(242, 211, 128, 0.95)" />
            <stop offset="45%" stopColor="rgba(184,135,47,0.92)" />
            <stop offset="100%" stopColor="rgba(96, 62, 18, 0.92)" />
          </linearGradient>
          <linearGradient id="blueBarDaily_v2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(110,231,255,0.95)" />
            <stop offset="100%" stopColor="rgba(10,132,255,0.85)" />
          </linearGradient>
          <filter id="goldGlowDaily_v2" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="rgba(184,135,47,0.35)" />
          </filter>
        </defs>

        {/* Y axis label (match line chart) */}
        <text
          x={12}
          y={pts.pad + (pts.h - pts.pad * 2) / 2}
          transform={`rotate(-90 12 ${pts.pad + (pts.h - pts.pad * 2) / 2})`}
          textAnchor="middle"
          fontSize="12"
          fontWeight={700}
          fill="var(--chart-title)"
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
          fill="var(--chart-title)"
        >
          Date
        </text>

        {/* Y ticks + labels */}
        {pts.yTicks.map((v, idx2) => {
          const y = pts.mapY(v);
          return (
            <g key={idx2}>
              <line x1={pts.pad - 4} y1={y} x2={pts.pad} y2={y} stroke="currentColor" opacity={0.25} />
              <line x1={pts.pad} y1={y} x2={pts.w - pts.pad} y2={y} stroke="currentColor" opacity={0.08} />
              <text
                x={pts.pad - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--chart-title)"
                opacity={0.85}
              >
                {fmtTick(v)}
              </text>
            </g>
          );
        })}

        {/* X ticks + labels */}
        {pts.ticks.map((t) => {
          const x = pts.mapX(pts.xs[t.i]);
          return (
            <g key={t.i}>
              <line x1={x} y1={pts.h - pts.pad} x2={x} y2={pts.h - pts.pad + 6} stroke="currentColor" opacity={0.25} />
              <text x={x} y={pts.h - pts.pad + 18} textAnchor="middle" fontSize="10" fill="var(--chart-title)" opacity={0.85}>
                {fmtYmd(t.label)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {rows.map((r, i) => {
          const cx = pts.mapX(pts.xs[i]);
          const baseY = pts.mapY(0);

          const ya = pts.mapY(Number(r.a || 0));
          const yb = pts.mapY(Number(r.b || 0));

          const aTop = Math.min(baseY, ya);
          const bTop = Math.min(baseY, yb);
          const aH = Math.max(2, Math.abs(baseY - ya));
          const bH = Math.max(2, Math.abs(baseY - yb));

          const x0 = cx - pts.groupW / 2;
          const isHover = idx === i;

          return (
            <g key={r.x + i} opacity={isHover ? 1 : 0.92}>
              <rect
                x={x0}
                y={aTop}
                width={pts.barW}
                height={aH}
                rx={8}
                fill="url(#goldBarDaily_v2)"
                filter={isHover ? 'url(#goldGlowDaily_v2)' : undefined}
              />
              <rect
                x={x0 + pts.barW + pts.gap}
                y={bTop}
                width={pts.barW}
                height={bH}
                rx={8}
                fill="url(#blueBarDaily_v2)"
                opacity={0.9}
              />
            </g>
          );
        })}

        {/* hover marker */}
        {row ? (
          <>
            <line x1={hx} y1={pts.pad} x2={hx} y2={pts.h - pts.pad} stroke="currentColor" opacity={0.12} />
          </>
        ) : null}
      </svg>

      {/* Tooltip: always centered in the card (never clipped) */}
      {row && idx !== null ? (
        <div
          className="absolute pointer-events-none text-xs px-3 py-2 rounded-xl border tv-border shadow-sm tv-surface-soft"
          style={{ left: '50%', top: '50%', transform: 'translate(-50%, -55%)' }}
        >
          <div className="font-semibold text-[color:var(--text)]">{fmtYmd(row.x)}</div>
          <div className="text-slate-700">
            You: {fmtInt(Number(row.a || 0))} • {bLabel}: {fmtInt(Number(row.b || 0))}
          </div>
        </div>
      ) : null}
    </div>
  );
}


export default function YouVsNetwork() {
  useEffect(() => {
    track.openYouVsCrew();
  }, []);

  const location = useLocation();
  const fromRef = useRef<HTMLInputElement | null>(null);
  const toRef = useRef<HTMLInputElement | null>(null);

  const showNativePicker = (ref: React.MutableRefObject<HTMLInputElement | null>) => {
    const el: any = ref.current;
    // Chrome/Edge support input.showPicker(). If unavailable, focusing still lets users type.
    if (el && typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {}
    }
    // Fallback for Firefox/Safari or when showPicker throws.
    try {
      ref.current?.focus();
      ref.current?.click();
    } catch {}
  };
  const [from, setFrom] = useState(() => {
    // Default: start of current month
    const d = new Date();
    d.setDate(1);
    return ymd(d);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [metric, setMetric] = useState<Metric>('Tonnes Hauled');
  const [crewRankMode, setCrewRankMode] = useState<'total' | 'avg' | 'pb'>('total');
  const [crewCompareMode, setCrewCompareMode] = useState<'total' | 'avg' | 'pb'>('avg');

  // Allow deep-linking from push notifications, e.g. /You/Crew?metric=Tonnes%20Hauled
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

  const crewAvgDailyRows = useMemo(() => {
    const tl = data?.timeline || [];
    return tl.map((r) => ({ x: r.date, a: Number(r.user || 0), b: Number(r.network_avg || 0) }));
  }, [data]);

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

  // Crew avg should be stable (independent of which compare line is selected)
  const crewAvgCumTotal = useMemo(() => {
    let sum = 0;
    for (const r of crewAvgDailyRows) sum += Number(r.b || 0);
    return sum;
  }, [crewAvgDailyRows]);


  // Daily-mode summary should reflect daily averages (not cumulative totals)
  const dailyAvgSummary = useMemo(() => {
    const xs = dailyRows || [];
    const meanNonZero = (arr: number[]) => {
      const vals = arr.filter((v) => Number.isFinite(v) && v > 0);
      if (!vals.length) return 0;
      const s = vals.reduce((acc, v) => acc + v, 0);
      return s / vals.length;
    };
    const a = meanNonZero(xs.map((r) => Number(r.a || 0)));
    const b = meanNonZero(xs.map((r) => Number(r.b || 0)));
    const pct = b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0;
    return { a, b, pct };
  }, [dailyRows]);

  const kpiSummary = useMemo(() => (mode === 'daily' ? dailyAvgSummary : cumSummary), [mode, dailyAvgSummary, cumSummary]);

  const bLabel = useMemo(() => {
    const name = data?.compare?.name?.trim();
    return name ? name : 'Crew avg';
  }, [data]);




  const leaderboard = useMemo(() => {
    const mode = crewRankMode;

    const pick = (m: any) => {
      if (mode === 'avg') return Number(m.avg ?? m.total ?? 0);
      if (mode === 'pb') return Number(m.pb ?? 0);
      return Number(m.total ?? 0);
    };

    const crew = (data?.crewTotals || []).map((m: any) => ({
      key: `crew-${m.id}`,
      label: m.name?.trim() ? m.name : m.email,
      total: pick(m),
      kind: 'crew' as const,
    }));

    const youTotal =
      mode === 'avg'
        ? Number(data?.userPeriodAvg ?? 0)
        : mode === 'pb'
        ? Number(data?.userAllTimeBest?.total ?? 0)
        : Number(data?.userPeriodTotal ?? cumSummary.a ?? 0);

    const crewAvg =
      mode === 'total'
        ? Number(crewAvgCumTotal || 0)
        : mode === 'avg'
        ? (() => {
            const vals = (data?.crewTotals || []).map((m: any) => Number(m.avg || 0)).filter((v: number) => v > 0);
            return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0;
          })()
        : (() => {
            const vals = (data?.crewTotals || []).map((m: any) => Number(m.pb || 0)).filter((v: number) => v > 0);
            return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0;
          })();

    const rows = [
      { key: 'you', label: 'You', total: youTotal, kind: 'you' as const },
      { key: 'avg', label: 'Crew avg', total: crewAvg, kind: 'avg' as const },
      ...crew,
    ].filter((r) => Number.isFinite(r.total));

    rows.sort((a, b) => (b.total || 0) - (a.total || 0));

    // keep list compact: top 5, but always include "You" + "Crew avg"
    const top = rows.slice(0, 5);
    const ensure = (k: string) => {
      const r = rows.find((x) => x.key === k);
      if (r && !top.some((x) => x.key === k)) top.push(r);
    };
    ensure('you');
    ensure('avg');

    const max = Math.max(1, ...top.map((r) => Number(r.total || 0)));
    return { rows: top, max, mode };
  }, [data, cumSummary.a, crewAvgCumTotal, crewRankMode]);

  return (
      <div className="space-y-4">
        {/* Card 1: header + filters */}
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-lg font-semibold">You vs Crew</div>
              <div className="text-sm opacity-70">Compare your performance to your crew connections.</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="tv-tile tv-hoverable p-4">
              <div className="text-xs tv-muted mb-2">From date</div>
              <input
                className="tv-date-input"
                type="date"
                ref={fromRef}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                // NOTE: do NOT mark date inputs as readOnly; Chromium won't open the native picker.
                // We still force-open the picker on desktop via showPicker() when available.
                onPointerDown={(e) => {
                  // desktop mouse click should always open the picker
                  if ((e as any).pointerType === 'mouse') showNativePicker(fromRef);
                }}
                onClick={() => showNativePicker(fromRef)}
                onFocus={() => showNativePicker(fromRef)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showNativePicker(fromRef);
                  }
                }}
                aria-label="From date"
              />
            </div>
            <div className="tv-tile tv-hoverable p-4">
              <div className="text-xs tv-muted mb-2">To date</div>
              <input
                className="tv-date-input"
                type="date"
                ref={toRef}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                // NOTE: do NOT mark date inputs as readOnly; Chromium won't open the native picker.
                onPointerDown={(e) => {
                  if ((e as any).pointerType === 'mouse') showNativePicker(toRef);
                }}
                onClick={() => showNativePicker(toRef)}
                onFocus={() => showNativePicker(toRef)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showNativePicker(toRef);
                  }
                }}
                aria-label="To date"
              />
            </div>
          </div>

          <div className="mb-3">
            <div className="text-xs tv-muted mb-2">Metric</div>
            {/* Free-scrolling row (same feel as You vs You trend cards). */}
            <TvTileRow itemWidth={250}>
              {MILESTONE_METRICS.map((m) => {
                const active = metric === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMetric(m as Metric)}
                    className={`metricTile w-full text-left rounded-2xl border p-4 tv-hoverable ${active ? "metricTile--active" : ""}`}
                  >
                    <div className="text-sm font-semibold leading-snug break-words" style={{ minHeight: 44 }}>
                      {m}
                    </div>
                    <div className="text-xs tv-muted mt-1">Tap to select</div>
                  </button>
                );
              })}
            </TvTileRow>
          </div>

	          <div className="text-sm opacity-70 flex items-center">
	            {data?.members?.length ? `${data.members.length} crew mates in network` : 'No crew mates yet'}
	          </div>

          {err ? (
            <div className="text-sm" style={{ color: '#b00020' }}>
              {err}
            </div>
          ) : null}
        </div>

        {/* Data cards */}
        {rows.length ? (
          <>


            {/* Card 2: crew comparison tiles */}
            <div className="card">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-sm font-semibold">Crew comparison (date range)</div>
                <div className="text-xs tv-muted">{metric}</div>
              </div>

              <div className="mb-3">
                <div className="tv-seg" role="tablist" aria-label="Crew comparison mode">
                  {(['total','avg','pb'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setCrewCompareMode(k)}
                      className={`tv-segBtn ${crewCompareMode === k ? 'tv-segBtn--active' : ''}`}
                      role="tab"
                      aria-selected={crewCompareMode === k}
                    >
                      {k === 'total' ? 'Total' : k === 'avg' ? 'Avg' : 'PB'}
                    </button>
                  ))}
                </div>
              </div>

{data?.crewTiles?.length ? (
                <TvTileRow itemWidth={280}>
                  {data.crewTiles.map((t) => {
                    return (
                      <div
                        key={t.id}
                        className="w-full rounded-2xl border p-3"
                        style={{ borderColor: 'rgba(148,163,184,0.35)', background: 'rgba(0,0,0,0.02)' }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">{t.name || t.email}</div>
                            <div className="text-xs tv-muted mt-1">{crewCompareMode === "total" ? "Period total" : crewCompareMode === "avg" ? "Period avg" : "All-time PB"}</div>
                          </div>
                        </div>

                        {(() => {
                          const theirPB = Number(t.theirAllTimeBest?.total || 0);
                          const yourPB = Number(t.yourAllTimeBest?.total || 0);
                          const theirAvg = Number(t.theirPeriodAvg || 0);
                          const yourAvg = Number(t.yourPeriodAvg || 0);

                          const pct = (you: number, them: number) => (them > 0 ? ((you - them) / them) * 100 : (you > 0 ? 100 : 0));

                          const pbDelta = pct(yourPB, theirPB);
                          const avgDelta = pct(yourAvg, theirAvg);

                          const colorFor = (v: number) =>
                            v === 0
                              ? 'rgba(148,163,184,0.9)'
                              : v > 0
                              ? 'rgba(34,197,94,0.98)'
                              : 'rgba(239,68,68,0.98)';

                          return (
                            <div className="mt-2">
                              {(() => {
                                const mode = crewCompareMode;
                                const their =
                                  mode === 'avg'
                                    ? theirAvg
                                    : mode === 'pb'
                                    ? theirPB
                                    : Number(t.theirPeriodTotal || 0);
                                const yours =
                                  mode === 'avg'
                                    ? yourAvg
                                    : mode === 'pb'
                                    ? yourPB
                                    : Number(t.yourPeriodTotal || 0);

                                const delta = pct(yours, their);

                                return (
                                  <div className="stackCard stackCard--tight">
                                    <div className="stackLabel">
                                      {mode === 'total' ? 'Total' : mode === 'avg' ? 'Avg' : 'PB'}
                                    </div>

                                    <div className="stackRow">
                                      <div className="stackCap">Their</div>
                                      <div className="stackVal tabular-nums" title={fmtFull(their)}>{fmtCompact(their)}</div>
                                    </div>
                                    <div className="stackRow">
                                      <div className="stackCap">You</div>
                                      <div className="stackVal tabular-nums" title={fmtFull(yours)}>{fmtCompact(yours)}</div>
                                    </div>

                                    <div className="flex items-center justify-between mt-2">
                                      <div className="text-xs tv-muted">Δ vs them</div>
                                      <div
                                        className="text-xs font-semibold tabular-nums"
                                        style={{ color: colorFor(delta) }}
                                        title={`${delta.toFixed(1)}%`}
                                      >
                                        {delta === 0 ? '0%' : `${delta > 0 ? '+' : ''}${delta.toFixed(0)}%`}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </TvTileRow>
              ) : (
                <div className="text-sm tv-muted">No crew connections yet — add crew mates to unlock comparisons.</div>
              )}
            </div>

            {/* Card 3: crew rank */}
            <div className="card">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-sm font-semibold">Crew rank ({leaderboard.mode === "total" ? "period total" : leaderboard.mode === "avg" ? "period avg" : "all-time PB"})</div>
                <div className="text-xs opacity-70">{metric}</div>
              </div>

              
              <div className="tv-seg mb-1" role="tablist" aria-label="Crew rank mode">
                {(['total','avg','pb'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setCrewRankMode(k)}
                    className={`tv-segBtn ${crewRankMode === k ? 'tv-segBtn--active' : ''}`}
                    role="tab"
                    aria-selected={crewRankMode === k}
                  >
                    {k === 'total' ? 'Total' : k === 'avg' ? 'Avg' : 'PB'}
                  </button>
                ))}
              </div><div className="space-y-2">
                {leaderboard.rows.map((r, idx) => {
                  const pct = Math.max(0, Math.min(1, (r.total || 0) / leaderboard.max));
                  return (
                    <div key={r.key} className="p-2 rounded-2xl border" >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="text-sm font-semibold">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full mr-2" style={{ background: idx === 0 ? 'rgba(242,211,128,0.22)' : 'rgba(148,163,184,0.16)', border: '1px solid rgba(148,163,184,0.28)' }}>{idx + 1}</span>{r.label}
                          {r.kind === 'you' ? <span className="ml-2 text-xs opacity-70">(you)</span> : null}
                        </div>
                        <div className="text-sm font-semibold tabular-nums">{fmtInt(r.total || 0)}</div>
                      </div>
                      <div className="h-3 rounded-xl border overflow-hidden" style={{ background: "rgba(2,6,23,0.55)", borderColor: "rgba(148,163,184,0.28)" }}>
                        <div
                          className="h-full"
                          style={{
                            width: `${pct * 100}%`,
                            boxShadow: r.kind === 'avg' ? '0 0 10px rgba(10,132,255,0.25)' : '0 0 10px rgba(184,135,47,0.25)',
                            background: r.kind === 'avg' ? 'linear-gradient(180deg, rgba(110,231,255,0.95), rgba(10,132,255,0.85))' : 'linear-gradient(180deg, rgba(242,211,128,0.95), rgba(184,135,47,0.92), rgba(96,62,18,0.92))',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Card 4: chart */}
            <div className="card">
              <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
                <div className="text-xs tv-muted">Gold = you, blue dashed = {bLabel} • {mode === 'cumulative' ? 'cumulative total' : 'daily average'}</div>
                <div className="flex rounded-xl border tv-border overflow-hidden">
                  <button
                    className={`px-3 py-2 text-sm ${mode === 'daily' ? 'font-semibold' : 'opacity-70'}`}
                    onClick={() => setMode('daily')}
                    type="button"
                  >
                    Daily
                  </button>
                  <button
                    className={`px-3 py-2 text-sm border-l ${mode === 'cumulative' ? 'font-semibold' : 'opacity-70'}`}
                    onClick={() => setMode('cumulative')}
                    type="button"
                  >
                    Cumulative
                  </button>
                </div>

                <div className="min-w-[220px]">
                  <div className="text-xs tv-muted mb-1">Compare line</div>
                  <select
                    className="input"
                    value={String(compareUserId)}
                    onChange={(e) => setCompareUserId(parseInt(e.target.value || '0', 10) || 0)}
                  >
                    <option value="0">Crew avg</option>
                    {(data?.members || []).map((m) => (
                      <option key={m.id} value={String(m.id)}>{m.name || `Crew mate ${m.id}`}</option>
                    ))}
                  </select>
                </div>
              </div>
			      {mode === 'daily' ? (
			        <ColumnChartDaily rows={rows} bLabel={bLabel} yLabel={metric} />
			      ) : (
			        <LineChart rows={rows} bLabel={bLabel} yLabel={metric} />
			      )}
            </div>
          </>
        ) : (
          <div className="card">
            <div className="text-sm opacity-70">No data in range.</div>
          </div>
        )}
      </div>
  );
}