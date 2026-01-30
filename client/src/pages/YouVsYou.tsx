import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { track } from '../lib/analytics';


function ymdLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
type ShiftRow = { id: number; date: string; dn: string; totals_json: any; activities?: any[] };

function ymd(d: Date) {
  return ymdLocal(d);
}
function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function formatShortDate(ymdStr: string) {
  try {
    const [y, m, d] = ymdStr.split('-').map((v) => parseInt(v, 10));
    const dt = new Date(y, (m || 1) - 1, d || 1);
    const dd = String(dt.getDate()).padStart(2, '0');
    const mon = dt.toLocaleString('en-AU', { month: 'short' });
    return `${dd}/${mon}`;
  } catch {
    return ymdStr;
  }
}

function lc(s: any) {
  return String(s || '').toLowerCase().trim();
}
function formatDdMmm(ymdStr: string) {
  // ymd -> dd/Mon
  const [y, m, d] = String(ymdStr || '').split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return ymdStr;
  const dt = new Date(y, m - 1, d);
  const mon = dt.toLocaleString(undefined, { month: 'short' });
  return `${String(d).padStart(2, '0')}/${mon}`;
}

function sumMetric(totals: any, actName: string, metricName: string) {
  const t = totals || {};
  const actL = lc(actName);
  const keyL = lc(metricName);
  let sum = 0;

  for (const actKey of Object.keys(t)) {
    if (lc(actKey) !== actL) continue;
    const actObj = t[actKey] || {};
    for (const subKey of Object.keys(actObj)) {
      const subObj = actObj[subKey] || {};
      for (const k of Object.keys(subObj)) {
        if (lc(k) === keyL) sum += Number(subObj[k] || 0) || 0;
      }
    }
  }

  return sum;
}

function sumLoadingBuckets(totals: any) {
  // Legacy helper used by some screens.
  // In current totals_json schema, buckets are derived:
  //  - Stope buckets = (Stope to Truck + Stope to SP)
  //  - Dev buckets   = (Heading to Truck + Heading to SP)
  return (
    sumMetric(totals, 'loading', 'Stope to Truck') +
    sumMetric(totals, 'loading', 'Stope to SP') +
    sumMetric(totals, 'loading', 'Heading to Truck') +
    sumMetric(totals, 'loading', 'Heading to SP')
  );
}


function payloads(r: ShiftRow): any[] {
  return Array.isArray((r as any).activities) ? ((r as any).activities as any[]) : [];
}
function vOf(p0: any): any {
  const p: any = p0 || {};
  const v: any = p.values && typeof p.values === 'object' ? p.values : (p.payload_json?.values && typeof p.payload_json.values === 'object' ? p.payload_json.values : {});
  // Some rows store values directly in payload_json
  return v && typeof v === 'object' ? v : {};
}
function actOf(p0: any): string {
  const p: any = p0 || {};
  return String(p.activity ?? p.Activity ?? p.payload_json?.activity ?? '').trim();
}
function subOf(p0: any): string {
  const p: any = p0 || {};
  return String(p.sub ?? p.sub_activity ?? p.subActivity ?? p.payload_json?.sub_activity ?? p.payload_json?.subActivity ?? '').trim();
}
function locOf(p0: any): string {
  const p: any = p0 || {};
  const v = vOf(p);
  // Most activities store Location, but some (e.g. Firing) store Heading/Stope.
  return String(
    p.location ??
      p.Location ??
      p.payload_json?.location ??
      v.Location ??
      v.location ??
      v.Heading ??
      v.heading ??
      v.Stope ??
      v.stope ??
      ''
  ).trim();
}
function uniqCount(vals: string[]) {
  const s = new Set<string>();
  for (const v of vals) {
    const t = String(v || '').trim();
    if (t) s.add(t);
  }
  return s.size;
}
function n2(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Number formatting helpers (module-scope so chart helpers can use them)
const fmtInt = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }).format(Math.round(Number(n || 0)));

// Compact display for axis labels: 12,400 -> 12.4k, 1,250,000 -> 1.3m
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
    const k = a / 1000;
    return `${sign}${k.toFixed(0)}k`;
  }
  if (a >= 10_000) {
    const k = a / 1000;
    return `${sign}${k.toFixed(1)}k`;
  }
  return fmtInt(v);
}



// ---- Development helpers ----
function devBolts(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Development') continue;
    const sub = subOf(p0);
    if (sub !== 'Ground Support' && sub !== 'Rehab') continue;
    const v = vOf(p0);
    sum += n2(v['No. of Bolts'] ?? v['No of Bolts'] ?? v['No. of bolts'] ?? v['No of bolts'] ?? v['No of bolts '] ?? v['No. of bolts ']);
  }
  return sum;
}
function gsDrillmFromPayloads(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Development') continue;
    const sub = subOf(p0);
    if (sub !== 'Ground Support' && sub !== 'Rehab') continue;
    const v = vOf(p0);
    const direct = n2(v['GS Drillm']);
    if (direct > 0) {
      sum += direct;
    } else {
      const bolts = n2(v['No. of Bolts'] ?? v['No of Bolts'] ?? v['No. of bolts'] ?? v['No of bolts']);
      const bl = String(v['Bolt Length'] ?? v['Bolt length'] ?? '').toLowerCase();
      const blNum = n2(bl.replace(/[^0-9.]/g, ''));
      if (bolts > 0 && blNum > 0) sum += bolts * blNum;
    }
  }
  return sum;
}
function headingsSupported(payloadsAll: any[]): number {
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Development') continue;
    if (subOf(p0) !== 'Ground Support') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}
function headingsBored(payloadsAll: any[]): number {
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Development') continue;
    if (subOf(p0) !== 'Face Drilling') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}

// ---- Backfilling helpers ----
function backfillVolume(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Backfilling') continue;
    if (subOf(p0) !== 'Surface') continue;
    const v = vOf(p0);
    sum += n2(v['Volume']);
  }
  return sum;
}

function backfillBuckets(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Backfilling') continue;
    if (subOf(p0) !== 'Underground') continue;
    const v = vOf(p0);
    sum += n2(v['Buckets']);
  }
  return sum;
}
function prodDrillmFromPayloads(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Production Drilling') continue;
    const sub = subOf(p0);
    if (sub !== 'Stope' && sub !== 'Service Hole') continue;
    const v = vOf(p0);
    sum += n2(v['Metres Drilled']) + n2(v['Cleanouts Drilled']) + n2(v['Redrills']);
  }
  return sum;
}

// ---- Haulage helpers ----
function aggHaul(payloadsAll: any[]) {
  const out = { oreTrucks: 0, wasteTrucks: 0, prodTrucks: 0, devOreTrucks: 0, devWasteTrucks: 0 };
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Hauling') continue;
    const sub = subOf(p0).toLowerCase();
    const v = vOf(p0);

    const trucks = n2(v['No of trucks'] ?? v['No. of trucks'] ?? v['Trucks'] ?? v['No of Trucks'] ?? v['No. of Trucks']);
    const material = String(v['Material'] ?? v.material ?? '').toLowerCase();

    if (material.includes('ore')) out.oreTrucks += trucks;
    else if (material.includes('waste')) out.wasteTrucks += trucks;

    const isProd = sub.includes('production') || sub === 'production' || sub.includes('stope');
    const isDev = sub.includes('development') || sub === 'development' || sub.includes('heading');

    if (isProd) out.prodTrucks += trucks;
    else if (isDev) {
      if (material.includes('ore')) out.devOreTrucks += trucks;
      else if (material.includes('waste')) out.devWasteTrucks += trucks;
    }
  }
  return out;
}

// ---- Charging helpers ----
function headingsCharged(payloadsAll: any[]): number {
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Charging') continue;
    if (subOf(p0) !== 'Development') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}
function stopesCharged(payloadsAll: any[]): number {
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Charging') continue;
    if (subOf(p0) !== 'Production') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}
function devChargeMetres(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Charging') continue;
    if (subOf(p0) !== 'Development') continue;
    const v = vOf(p0);
    sum += n2(v['Charge Metres'] ?? v['Charge metres'] ?? v['Charge m'] ?? v['ChargeM'] ?? v['Charge Metres (m)']);
  }
  return sum;
}
function stopeChargeMetres(payloadsAll: any[]): number {
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Charging') continue;
    if (subOf(p0) !== 'Production') continue;
    const v = vOf(p0);
    sum += n2(v['Charge Metres'] ?? v['Charge metres'] ?? v['Charge m'] ?? v['ChargeM'] ?? v['Charge Metres (m)']);
  }
  return sum;
}
function tonnesFired(payloadsAll: any[]): number {
  // Production firing tonnes (Firing -> Production)
  let sum = 0;
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Firing') continue;
    if (subOf(p0) !== 'Production') continue;
    const v = vOf(p0);
    sum += n2(v['Tonnes Fired'] ?? v['tonnes fired']);
  }
  return sum;
}
function headingsFired(payloadsAll: any[]): number {
  // Development firing headings (Firing -> Development)
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Firing') continue;
    if (subOf(p0) !== 'Development') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}
function stopesFired(payloadsAll: any[]): number {
  // Production firing stopes (Firing -> Production)
  const locs: string[] = [];
  for (const p0 of payloadsAll || []) {
    if (actOf(p0) !== 'Firing') continue;
    if (subOf(p0) !== 'Production') continue;
    locs.push(locOf(p0));
  }
  return uniqCount(locs);
}


function avg(nums: number[]) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Treat 0 as "no output" for averaging/benchmarks to avoid diluting the mean.
function nonZero(nums: number[]) {
  return nums.filter((v) => (Number(v) || 0) > 0);
}

function avgNonZero(nums: number[]) {
  const xs = nonZero(nums);
  return avg(xs);
}

function percentileRange(nums: number[]) {
  // "Typical" range = IQR (25–75%)
  const xs = nums
    .filter((n) => Number.isFinite(n) && (Number(n) || 0) > 0)
    .slice()
    .sort((a, b) => a - b);
  if (!xs.length) return { p25: 0, p75: 0 };
  const q = (p: number) => {
    const idx = (xs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo];
    const w = idx - lo;
    return xs[lo] * (1 - w) + xs[hi] * w;
  };
  return { p25: q(0.25), p75: q(0.75) };
}

function stddev(nums: number[]) {
  const xs = nonZero(nums);
  if (xs.length < 2) return 0;
  const m = avg(xs);
  const v = avg(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function Sparkline({ values }: { values: number[] }) {
  const w = 70;
  const h = 22;
  const xs = values.slice(-14);
  const max = Math.max(1, ...xs);
  const min = Math.min(0, ...xs);
  const range = Math.max(1e-9, max - min);
  const pts = xs
    .map((v, i) => {
      const x = (i / Math.max(1, xs.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / range) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" opacity={0.85} />
    </svg>
  );
}

function LineChart({
  points,
  unit,
  yLabel,
}: {
  points: { label: string; date: string; value: number }[];
  unit: string;
  yLabel: string;
}) {
  // Defensive: when data hasn't loaded (or API errored), avoid crashing the whole page.
  if (!points || points.length === 0) {
    return (
      <div className="w-full rounded-xl border tv-border tv-surface-soft p-4 text-sm tv-muted">
        No data to chart for this metric yet.
      </div>
    );
  }

  const ref = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const w = 640;
  const h = 240;
  const padL = 46;
  const padR = 14;
  const padT = 12;
  const padB = 34;

  const xs = points.map((p) => p.value);

  // Nice rounded Y scale so tick labels are readable (Power BI-style).
  const rawMax = Math.max(1, ...xs);
  const approxStep = rawMax / 4;
  const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, approxStep))));
  const frac = approxStep / pow10;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  const step = niceFrac * pow10;
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  const min = 0;
  const range = Math.max(1e-9, max - min);

  const yTicks = [0, max * 0.25, max * 0.5, max * 0.75, max];

  const toX = (i: number) =>
    padL + (i / Math.max(1, points.length - 1)) * (w - padL - padR);
  const toY = (v: number) =>
    h - padB - ((v - min) / range) * (h - padT - padB);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.value).toFixed(1)}`)
    .join(' ');

  // rolling avg for the shown window (non-zero only to avoid dilution)
  const m = avgNonZero(xs);
  const yAvg = toY(m);

  function onMove(e: any) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const xPx = e.clientX - r.left;
    // Convert from pixels → SVG viewBox units so hover aligns even when the chart is scaled.
    const x = (xPx / Math.max(1, r.width)) * w;
    const rel = Math.min(1, Math.max(0, (x - padL) / Math.max(1, w - padL - padR)));
    const idx = Math.round(rel * Math.max(0, points.length - 1));
    setHoverIdx(Number.isFinite(idx) ? idx : null);
  }

  function onLeave() {
    setHoverIdx(null);
  }

  const safeIdx =
    hoverIdx === null ? null : Math.min(points.length - 1, Math.max(0, hoverIdx));
  const hover = safeIdx === null ? null : points[safeIdx];
  const hx = safeIdx === null ? 0 : toX(safeIdx);
  const hy = safeIdx === null ? 0 : toY(points[safeIdx]?.value ?? 0);

  return (
    <div ref={ref} className="w-full overflow-x-auto">
      <div className="relative" style={{ width: '100%', maxWidth: w }}>
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          className="select-none text-[color:var(--text)]"
        >
          {/* y grid + ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const y = padT + t * (h - padT - padB);
            return <line key={t} x1={padL} y1={y} x2={w - padR} y2={y} stroke="var(--chart-grid)" />;
          })}

          {yTicks.map((v) => {
            const y = toY(v);
            return (
              <text
                key={`y-${v}`}
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--chart-tick)"
                opacity={0.95}
                style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,0.85)', strokeWidth: 3 }}
              >
                {Math.round(v).toLocaleString()}
              </text>
            );
          })}

          {/* axes */}
          <line x1={padL} y1={padT} x2={padL} y2={h - padB} stroke="var(--chart-axis)" />
          <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="var(--chart-axis)" />

          {/* y axis title */}
          <text
            x={12}
            y={padT + (h - padT - padB) / 2}
            transform={`rotate(-90 12 ${padT + (h - padT - padB) / 2})`}
            textAnchor="middle"
            fontSize="12"
            fontWeight={700}
            fill="var(--chart-title)"
          >
            {yLabel}
          </text>

          {/* y labels */}
          {[min, (min + max) / 2, max].map((v, i) => {
            const y = toY(v);
            return (
              <text
                key={i}
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                fontSize="11"
                fill="rgba(226, 232, 240, 0.82)"
                stroke="rgba(0, 0, 0, 0.45)"
                strokeWidth="2"
                paintOrder="stroke"
              >
                {Math.round(v)}
              </text>
            );
          })}

          {/* avg line */}
          <line
            x1={padL}
            y1={yAvg}
            x2={w - padR}
            y2={yAvg}
            stroke="var(--chart-avg)"
            strokeDasharray="6 6"
            opacity={0.9}
          />

          {/* series */}
          <path d={path} fill="none" stroke="var(--chart-line)" strokeWidth={3} opacity={0.95} />

          {/* points */}
          {points.map((p, i) => (
            <circle
              key={p.date + i}
              cx={toX(i)}
              cy={toY(p.value)}
              r={hoverIdx === i ? 5 : 3}
              fill="var(--chart-point)"
              opacity={hoverIdx === i ? 1 : 0.85}
            />
          ))}

          {/* x labels (sparse) */}
          {points
            .map((p, i) => ({ p, i }))
            .filter(({ i }) => points.length <= 8 || i === 0 || i === points.length - 1 || i % 5 === 0)
            .map(({ p, i }) => (
              <text
                key={p.date}
                x={toX(i)}
                y={h - 20}
                textAnchor={points.length > 10 ? "end" : "middle"}
                transform={points.length > 10 ? `rotate(-35 ${toX(i)} ${h - 20})` : undefined}
                fontSize="11"
                fill="rgba(226, 232, 240, 0.82)"
                stroke="rgba(0, 0, 0, 0.45)"
                strokeWidth="2"
                paintOrder="stroke"
              >
                {p.label}
              </text>
            ))}

          {/* axis title */}
          <text x={(padL + (w - padR)) / 2} y={h - 4} textAnchor="middle" fontSize="12" fill="var(--chart-point)">
            Date
          </text>

          {/* hover marker */}
          {hover && (
            <>
              <line x1={hx} y1={padT} x2={hx} y2={h - padB} stroke="var(--chart-hover)" opacity={0.45} />
              <circle cx={hx} cy={hy} r={6} fill="var(--chart-hover)" opacity={1} />
            </>
          )}
        </svg>

        {hover && (
          <div
            className="absolute pointer-events-none px-3 py-2 rounded-xl border tv-border shadow-sm tv-surface-soft text-xs"
            // Center tooltip so it never gets clipped above the chart on small screens.
            style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
          >
            <div className="font-semibold text-[color:var(--text)]">
              {hover.date} ({hover.label})
            </div>
            <div className="text-slate-700">
              {Math.round(hover.value).toLocaleString()} {unit}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


function ColumnChart({
  points,
  unit,
  yLabel,
}: {
  points: { label: string; date: string; value: number }[];
  unit: string;
  yLabel: string;
}) {
  if (!points || points.length === 0) {
    return (
      <div className="w-full rounded-xl border tv-border tv-surface-soft p-4 text-sm tv-muted">
        No data to chart for this metric yet.
      </div>
    );
  }

  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ i: number } | null>(null);

  // Reset hover when points change (window / metric change)
  useEffect(() => {
    setHover(null);
  }, [points]);

  const pts = useMemo(() => {
    const w = 900;
    const h = 260;
    let pad = 34; // dynamic: adjusted below for large Y-axis labels

    const xs = points.map((p) => Number(p.value || 0));
    const rawMax = Math.max(1, ...xs);

    // Nice rounded Y scale (match You vs Crew line chart)
    const approxStep = rawMax / 4;
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, approxStep))));
    const frac = approxStep / pow10;
    const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    const step = niceFrac * pow10;
    const maxV = Math.max(step, Math.ceil(rawMax / step) * step);
    const yTicks = [0, maxV * 0.25, maxV * 0.5, maxV * 0.75, maxV];

    const maxLabelLen = Math.max(...yTicks.map((v) => fmtCompact(v).length));
    pad = Math.max(pad, 18 + maxLabelLen * 7);

    const ts = points.map((_, i) => (points.length <= 1 ? 0.5 : i / (points.length - 1)));
    const mapX = (t: number) => pad + t * (w - pad * 2);
    const mapY = (v: number) => h - pad - (v / maxV) * (h - pad * 2);

    // tick labels: aim for ~7 labels + always include first/last
    const tickEvery = points.length <= 8 ? 1 : Math.ceil(points.length / 7);
    const ticks = points
      .map((p, i) => ({ i, label: p.label }))
      .filter((t, idx) => idx === 0 || idx === points.length - 1 || idx % tickEvery === 0);

    // bar sizing (slot-based)
    const plotW = w - pad * 2;
    const slotW = plotW / Math.max(1, points.length);
    const barW = Math.max(10, Math.min(28, slotW * 0.65));

    const avgV = avgNonZero(xs);

    return { w, h, pad, maxV, yTicks, ts, mapX, mapY, ticks, barW, avgV };
  }, [points]);

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || points.length === 0) return;

    const r = el.getBoundingClientRect();
    const xPx = e.clientX - r.left;

    // Convert pixels → SVG viewBox units
    const x = (xPx / Math.max(1, r.width)) * pts.w;
    const rel = Math.max(0, Math.min(1, (x - pts.pad) / (pts.w - pts.pad * 2)));
    const i = Math.round(rel * (points.length - 1));
    setHover({ i: Math.max(0, Math.min(points.length - 1, i)) });
  };

  const idx = hover?.i ?? null;
  const p = idx === null ? null : points[idx];
  const hx = idx === null ? 0 : pts.mapX(pts.ts[idx]);
  const hy = idx === null ? 0 : pts.mapY(Number(points[idx]?.value || 0));

  const fmtTick = (v: number) => fmtCompact(v);

  return (
    <div ref={ref} className="w-full relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${pts.w} ${pts.h}`} className="w-full h-[280px] select-none">
        <defs>
          <linearGradient id="youGoldBar_v2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(242, 211, 128, 0.95)" />
            <stop offset="45%" stopColor="rgba(184,135,47,0.92)" />
            <stop offset="100%" stopColor="rgba(96, 62, 18, 0.92)" />
          </linearGradient>
          <filter id="youGoldGlow_v2" x="-20%" y="-20%" width="140%" height="140%">
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
          {yLabel} ({unit})
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
              <text x={pts.pad - 8} y={y + 3} textAnchor="end" fontSize="10" fill="var(--chart-title)" opacity={0.85}>
                {fmtTick(v)}
              </text>
            </g>
          );
        })}

        {/* Avg (non-zero) dashed line */}
        <line
          x1={pts.pad}
          y1={pts.mapY(pts.avgV)}
          x2={pts.w - pts.pad}
          y2={pts.mapY(pts.avgV)}
          stroke="rgba(184,135,47,0.55)"
          strokeDasharray="8 6"
        />

        {/* Bars */}
        {points.map((pp, i) => {
          const cx = pts.mapX(pts.ts[i]);
          const x = cx - pts.barW / 2;
          const baseY = pts.mapY(0);
          const yv = pts.mapY(Number(pp.value || 0));
          const top = Math.min(baseY, yv);
          const height = Math.max(2, Math.abs(baseY - yv));
          const isHover = idx === i;
          return (
            <rect
              key={pp.date + i}
              x={x}
              y={top}
              width={pts.barW}
              height={height}
              rx={8}
              fill="url(#youGoldBar_v2)"
              opacity={isHover ? 1 : 0.92}
              filter={isHover ? 'url(#youGoldGlow_v2)' : undefined}
            />
          );
        })}

        {/* X ticks + labels */}
        {pts.ticks.map((t) => {
          const x = pts.mapX(pts.ts[t.i]);
          return (
            <g key={t.i}>
              <line x1={x} y1={pts.h - pts.pad} x2={x} y2={pts.h - pts.pad + 6} stroke="currentColor" opacity={0.25} />
              <text x={x} y={pts.h - pts.pad + 18} textAnchor="middle" fontSize="10" fill="var(--chart-title)" opacity={0.85}>
                {t.label}
              </text>
            </g>
          );
        })}

        {/* hover marker */}
        {p && idx !== null ? (
          <>
            <line x1={hx} y1={pts.pad} x2={hx} y2={pts.h - pts.pad} stroke="currentColor" opacity={0.12} />
            <circle cx={hx} cy={hy} r={4} fill="rgba(242, 211, 128, 0.95)" />
          </>
        ) : null}
      </svg>

      {/* Tooltip centered so it never clips */}
      {p && idx !== null ? (
        <div
          className="absolute pointer-events-none text-xs px-3 py-2 rounded-xl border tv-border shadow-sm tv-surface-soft"
          style={{ left: '50%', top: '50%', transform: 'translate(-50%, -55%)' }}
        >
          <div className="font-semibold text-[color:var(--text)]">
            {p.date} ({p.label})
          </div>
          <div className="text-slate-700">
            {Math.round(Number(p.value || 0)).toLocaleString()} {unit}
          </div>
        </div>
      ) : null}
    </div>
  );
}


function HeatmapMonth({
  points,
  onSelect,
  selectedDate,
}: {
  points: { date: string; value: number }[];
  selectedDate: string | null;
  onSelect: (d: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Build a month list from available data (min -> max), then default to the latest month.
  const months = useMemo(() => {
    if (!points?.length) return [] as Array<{ y: number; m: number; title: string }>;
    const ds = points
      .map((p) => new Date(p.date + 'T00:00:00'))
      .filter((d) => !isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    const min = ds[0];
    const max = ds[ds.length - 1];
    const out: Array<{ y: number; m: number; title: string }> = [];

    let cy = min.getFullYear();
    let cm = min.getMonth();
    const endY = max.getFullYear();
    const endM = max.getMonth();

    while (cy < endY || (cy === endY && cm <= endM)) {
      const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(cy, cm, 1));
      out.push({ y: cy, m: cm, title });
      cm++;
      if (cm > 11) {
        cm = 0;
        cy++;
      }
    }
    return out;
  }, [points]);

  const [monthIdx, setMonthIdx] = useState<number>(() => (months.length ? months.length - 1 : 0));

  // Keep index valid if months change
  useEffect(() => {
    if (!months.length) return;
    setMonthIdx((i) => Math.max(0, Math.min(months.length - 1, i || months.length - 1)));
  }, [months.length]);

  // Scroll to the selected month on mount / when monthIdx changes (snap container will do the rest).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const child = el.children.item(monthIdx) as HTMLElement | null;
    if (!child) return;
    el.scrollTo({ left: child.offsetLeft, behavior: 'smooth' });
  }, [monthIdx]);

  const byDate: Record<string, number> = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of points || []) m[p.date] = Number(p.value || 0);
    return m;
  }, [points]);

  function renderMonth(y: number, m: number) {
    const first = new Date(y, m, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const monthDates: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      monthDates.push(ymd(new Date(y, m, d)));
    }

    const vals = monthDates.map((d) => byDate[d] || 0);
    const max = Math.max(1, ...vals);

    const cells: Array<string | null> = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (const d of monthDates) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    return (
      <div className="heatmapMonthPane">
        <div className="text-sm font-semibold mb-2">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(y, m, 1))}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={i} className="h-8 rounded-lg tv-surface-soft" />;
            const v = byDate[d] || 0;
            const ratio = Math.min(1, v / max);

            // Higher-contrast phone-friendly palette (easier to distinguish levels)
            const level = v <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;

            const GOLD = '184,135,47';
            const bg =
              level === 0
                ? 'rgba(148,163,184,0.18)'
                : level === 1
                  ? `rgba(${GOLD},0.22)`
                  : level === 2
                    ? `rgba(${GOLD},0.38)`
                    : level === 3
                      ? `rgba(${GOLD},0.58)`
                      : `rgba(${GOLD},0.82)`;
            const isSel = selectedDate === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => onSelect(d)}
                className="h-8 rounded-lg border"
                style={{
                  background: bg,
                  borderColor: isSel ? 'var(--brand)' : 'rgba(148,163,184,0.35)',
                  boxShadow: isSel ? '0 0 0 2px rgba(10,132,255,0.22)' : 'none',
                }}
                title={`${d} • ${Math.round(v)}`}
              />
            );
          })}
        </div>
        <div className="mt-2 text-[11px] tv-muted">Swipe left/right for more months • lighter → darker = higher output (relative to month max)</div>
      </div>
    );
  }

  if (!months.length) {
    return <div className="text-sm tv-muted">No data yet.</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          className="px-3 py-2 rounded-xl border tv-border text-sm"
          onClick={() => setMonthIdx((i) => Math.max(0, i - 1))}
          disabled={monthIdx <= 0}
          aria-label="Previous month"
          style={{ opacity: monthIdx <= 0 ? 0.45 : 1 }}
        >
          ‹
        </button>
        <div className="text-xs tv-muted">{months[monthIdx]?.title}</div>
        <button
          type="button"
          className="px-3 py-2 rounded-xl border tv-border text-sm"
          onClick={() => setMonthIdx((i) => Math.min(months.length - 1, i + 1))}
          disabled={monthIdx >= months.length - 1}
          aria-label="Next month"
          style={{ opacity: monthIdx >= months.length - 1 ? 0.45 : 1 }}
        >
          ›
        </button>
      </div>

      <div
        ref={scrollerRef}
        className="heatmapMonthScroller"
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = el.clientWidth || 1;
          const i = Math.round(el.scrollLeft / w);
          if (i !== monthIdx) setMonthIdx(Math.max(0, Math.min(months.length - 1, i)));
        }}
      >
        {months.map((mm) => (
          <div key={`${mm.y}-${mm.m}`} className="heatmapMonthSnap">
            {renderMonth(mm.y, mm.m)}
          </div>
        ))}
      </div>
    </div>
  );
}

type TrendDef = {
  id: string;
  title: string;
  unit: string;
  get: (r: ShiftRow) => number;
};

export default function YouVsYou() {
  useEffect(() => {
    track.openYouVsYou();
  }, []);

  const nav = useNavigate();
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [rowsAll, setRowsAll] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [reloadKey, setReloadKey] = useState(0);
  const [windowN, setWindowN] = useState<7 | 14 | 30 | 999>(30);
  const [selectedId, setSelectedId] = useState<string>('dev_drillm');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    function on() {
      setOnline(true);
    }
    function off() {
      setOnline(false);
    }
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Fetch enough history for real trends without stressing the API.
  // (You can expand later if needed.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        setError(undefined);
        const to = new Date();
        const from = addDays(to, -365);
        const res = await api(`/api/reports/you-vs-you?from=${ymd(from)}&to=${ymd(to)}`);
        if (!cancelled) setRowsAll((res?.rows || []) as ShiftRow[]);
      } catch (e: any) {
        if (cancelled) return;
        const msg = String(e?.message || 'Failed to load');
        // Common auth failure cases should be user-friendly.
        if (
          msg.includes('missing token') ||
          msg.includes('invalid token') ||
          msg.includes('unauthorized') ||
          msg.includes('401')
        ) {
          setError('Your session has expired. Please log out and log back in.');
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const trends: TrendDef[] = useMemo(
    () => {
      const base: any[] = [
        {
          id: 'dev_drillm',
          title: 'Dev Drillm',
          unit: 'm',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'development', 'Dev Drillm'),
        },
        {
          id: 'gs_drillm',
          title: 'GS Drillm',
          unit: 'm',
          get: (r: ShiftRow) => gsDrillmFromPayloads(payloads(r)),
        },
        {
          id: 'total_drillm',
          title: 'Total Drillm',
          unit: 'm',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'development', 'Dev Drillm') + gsDrillmFromPayloads(payloads(r)),
        },
        {
          id: 'dev_bolts',
          title: 'Dev Bolts',
          unit: 'ea',
          get: (r: ShiftRow) => devBolts(payloads(r)),
        },
        {
          id: 'dev_spray_volume',
          title: 'Spray Volume',
          unit: 'm³',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'development', 'Spray Volume'),
        },
        {
          id: 'dev_agi_volume',
          title: 'Agi Volume',
          unit: 'm³',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'development', 'Agi Volume'),
        },
        {
          id: 'headings_supported',
          title: 'Headings supported',
          unit: 'hdgs',
          get: (r: ShiftRow) => headingsSupported(payloads(r)),
        },
        {
          id: 'headings_bored',
          title: 'Headings bored',
          unit: 'hdgs',
          get: (r: ShiftRow) => headingsBored(payloads(r)),
        },
        {
          id: 'tkms',
          title: 'TKMs',
          unit: 'tkm',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'hauling', 'Total TKMS'),
        },
        {
          id: 'stope_trucks',
          title: 'Stope Trucks',
          unit: 'trucks',
          get: (r: ShiftRow) => aggHaul(payloads(r)).prodTrucks,
        },
        {
          id: 'dev_trucks',
          title: 'Dev Trucks',
          unit: 'trucks',
          get: (r: ShiftRow) => {
            const h = aggHaul(payloads(r));
            return h.devOreTrucks + h.devWasteTrucks;
          },
        },
        {
          id: 'ore_trucks',
          title: 'Ore Trucks',
          unit: 'trucks',
          get: (r: ShiftRow) => {
            const h = aggHaul(payloads(r));
            return h.prodTrucks + h.devOreTrucks;
          },
        },
        {
          id: 'waste_trucks',
          title: 'Waste Trucks',
          unit: 'trucks',
          get: (r: ShiftRow) => aggHaul(payloads(r)).devWasteTrucks,
        },
        {
          id: 'prod_drillm',
          title: 'Prod Drillm',
          unit: 'm',
          get: (r: ShiftRow) => prodDrillmFromPayloads(payloads(r)),
        },
        {
          id: 'stope_buckets',
          title: 'Stope buckets',
          unit: 'ea',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'loading', 'Stope to Truck') + sumMetric(r.totals_json, 'loading', 'Stope to SP'),
        },
        {
          id: 'dev_buckets',
          title: 'Dev buckets',
          unit: 'ea',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'loading', 'Heading to Truck') + sumMetric(r.totals_json, 'loading', 'Heading to SP'),
        },
        {
          id: 'backfill_volume',
          title: 'Backfill volume',
          unit: 'm³',
          get: (r: ShiftRow) => backfillVolume(payloads(r)),
        },
        {
          id: 'backfill_buckets',
          title: 'Backfill buckets',
          unit: 'ea',
          get: (r: ShiftRow) => backfillBuckets(payloads(r)),
        },
        {
          id: 'hoist_tonnes',
          title: 'Hoist Tonnes',
          unit: 't',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'hoisting', 'Ore Tonnes') + sumMetric(r.totals_json, 'hoisting', 'Waste Tonnes'),
        },
        {
          id: 'hoist_ore_tonnes',
          title: 'Hoist Ore Tonnes',
          unit: 't',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'hoisting', 'Ore Tonnes'),
        },
        {
          id: 'hoist_waste_tonnes',
          title: 'Hoist Waste Tonnes',
          unit: 't',
          get: (r: ShiftRow) => sumMetric(r.totals_json, 'hoisting', 'Waste Tonnes'),
        },
        {
          id: 'headings_charged',
          title: 'Headings charged',
          unit: 'hdgs',
          get: (r: ShiftRow) => headingsCharged(payloads(r)),
        },
        {
          id: 'dev_charge_metres',
          title: 'Dev Charge Metres',
          unit: 'm',
          get: (r: ShiftRow) => devChargeMetres(payloads(r)),
        },
        {
          id: 'stope_charge_metres',
          title: 'Stope Charge Metres',
          unit: 'm',
          get: (r: ShiftRow) => stopeChargeMetres(payloads(r)),
        },
        {
          id: 'stopes_charged',
          title: 'Stopes Charged',
          unit: 'stopes',
          get: (r: ShiftRow) => stopesCharged(payloads(r)),
        },
        {
          id: 'headings_fired',
          title: 'Headings fired',
          unit: 'hdgs',
          get: (r: ShiftRow) => headingsFired(payloads(r)),
        },
        {
          id: 'stopes_fired',
          title: 'Stopes fired',
          unit: 'stopes',
          get: (r: ShiftRow) => stopesFired(payloads(r)),
        },
        {
          id: 'stope_tonnes_fired',
          title: 'Stope tonnes fired',
          unit: 't',
          get: (r: ShiftRow) => tonnesFired(payloads(r)),
        },
        {
          id: 'shifts',
          title: 'Shifts logged',
          unit: 'shifts',
          get: (_r: ShiftRow) => 1,
          isZeroOk: true,
        },
      ];

      const withData = base.filter((t) => {
        if (t.isZeroOk) return true;
        return rowsAll.some((r) => (t.get(r) || 0) > 0);
      });

      return (withData.length ? withData : base) as TrendDef[];
    },
    [rowsAll],
  );

  
  useEffect(() => {
    if (!trends.find((t) => t.id === selectedId)) {
      setSelectedId(trends[0]?.id || 'shifts');
    }
  }, [trends, selectedId]);

  const selected = useMemo(
    () => trends.find((t) => t.id === selectedId) || trends[0],
    [selectedId, trends],
  );

  const rowsSorted = useMemo(() => {
    return rowsAll
      .slice()
      .sort((a, b) => (a.date === b.date ? a.dn.localeCompare(b.dn) : a.date.localeCompare(b.date)));
  }, [rowsAll]);

  const windowRows = useMemo(() => {
    if (windowN === 999) return rowsSorted;
    return rowsSorted.slice(-windowN);
  }, [rowsSorted, windowN]);

  const prevWindowRows = useMemo(() => {
    if (windowN === 999) return [];
    const n = windowN;
    if (rowsSorted.length <= n) return [];
    return rowsSorted.slice(Math.max(0, rowsSorted.length - n * 2), rowsSorted.length - n);
  }, [rowsSorted, windowN]);

  const series = useMemo(() => {
    const pts = windowRows.map((r) => {
      const v = selected.id === 'shifts' ? 1 : selected.get(r);
      const label = formatShortDate(r.date);
      return { date: r.date, label, value: Number(v || 0) || 0 };
    });
    return pts;
  }, [windowRows, selected]);

  const values = useMemo(() => series.map((p) => p.value), [series]);
  const currentAvg = useMemo(() => {
    if (selected.id === 'shifts') return series.length; // count
    return avgNonZero(values);
  }, [values, selected.id, series.length]);

  const prevAvg = useMemo(() => {
    if (!prevWindowRows.length) return 0;
    if (selected.id === 'shifts') return prevWindowRows.length;
    return avgNonZero(prevWindowRows.map((r) => selected.get(r)));
  }, [prevWindowRows, selected]);

  const deltaPct = useMemo(() => {
    if (!prevAvg) return 0;
    return ((currentAvg - prevAvg) / prevAvg) * 100;
  }, [currentAvg, prevAvg]);

  const nonZeroPct = useMemo(() => {
    if (!values.length) return 0;
    const nz = values.filter((v) => (Number(v) || 0) > 0).length;
    return (nz / values.length) * 100;
  }, [values]);

  const typical = useMemo(() => percentileRange(values), [values]);

  const best = useMemo(() => {
    if (!series.length) return { value: 0, date: '–', dn: '' };
    let bestIdx = 0;
    for (let i = 1; i < series.length; i++) if (series[i].value > series[bestIdx].value) bestIdx = i;
    const b = series[bestIdx];
    return { value: b.value, date: b.date, dn: b.label };
  }, [series]);

  const consistency = useMemo(() => {
    if (selected.id === 'shifts') return { label: 'High', variance: 0 };
    const sd = stddev(values);
    const m = avgNonZero(values);
    const cv = m > 0 ? sd / m : 0;
    // gentle buckets
    if (cv <= 0.25) return { label: 'High', variance: cv };
    if (cv <= 0.5) return { label: 'Medium', variance: cv };
    return { label: 'Variable', variance: cv };
  }, [values, selected.id]);

  const trendCards = useMemo(() => {
    const last = rowsSorted.slice(-30);
    return trends.map((t) => {
      const vals = last.map((r) => (t.id === 'shifts' ? 1 : t.get(r))).map((x) => Number(x || 0) || 0);
      const cur = t.id === 'shifts' ? last.length : avgNonZero(vals);
      const prev = t.id === 'shifts'
        ? rowsSorted.slice(Math.max(0, rowsSorted.length - 60), rowsSorted.length - 30).length
        : avgNonZero(
            rowsSorted
              .slice(Math.max(0, rowsSorted.length - 60), rowsSorted.length - 30)
              .map((r) => t.get(r)),
          );
      const pct = prev ? ((cur - prev) / prev) * 100 : 0;
      const dir = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
      return { t, vals, cur, pct, dir };
    });
  }, [rowsSorted, trends]);

  const monthPoints = useMemo(() => {
    // Map all loaded rows into date->value (sum DS+NS if both)
    const m: Record<string, number> = {};
    for (const r of rowsSorted) {
      const v = selected.id === 'shifts' ? 1 : selected.get(r);
      m[r.date] = (m[r.date] || 0) + (Number(v || 0) || 0);
    }
    return Object.keys(m)
      .sort()
      .map((d) => ({ date: d, value: m[d] }));
  }, [rowsSorted, selected]);

  const selectedDateValue = useMemo(() => {
    if (!selectedDate) return null;
    const p = monthPoints.find((x) => x.date === selectedDate);
    return p ? p.value : 0;
  }, [monthPoints, selectedDate]);

  if (!online) {
    return (
      <div className="card">
        <h2 className="text-xl font-semibold mb-2">You vs You</h2>
        <div className="text-sm tv-muted">
          Connection required. Please connect to the network and try again.
        </div>
        <div className="mt-4 flex gap-2">
          <button className="btn" onClick={() => nav('/Main')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Trend cards</div>
              <div className="text-xs tv-muted">Tap a card to change the chart</div>
            </div>
            <div className="text-xs tv-muted">Last 30 shifts</div>
          </div>

          <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
            {trendCards.map(({ t, vals, cur, pct, dir }) => {
              const active = t.id === selectedId;
              const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬';
              const col = dir === 'up' ? 'var(--ok)' : dir === 'down' ? 'var(--warn)' : '#64748b';
              const headline = t.id === 'shifts' ? `${fmtInt(cur)} ${t.unit}` : `${fmtInt(cur)} ${t.unit} / shift`;
              const sub = pct
                ? `${arrow} ${Math.abs(pct).toFixed(0)}% vs prev 30`
                : `▬ 0% vs prev 30`;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className="min-w-[210px] text-left rounded-2xl border p-4"
                  style={{
                    borderColor: active ? 'var(--brand)' : 'rgba(148,163,184,0.35)',
                    background: active ? 'rgba(15,23,42,0.03)' : 'transparent',
                  }}
                >
                  <div className="text-xs tv-muted">{t.title}</div>
                  <div className="text-xl font-bold mt-1">{headline}</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="text-xs" style={{ color: col }}>
                      {sub}
                    </div>
                    <div className="text-[color:var(--text)]" style={{ color: 'var(--brand)' }}>
                      <Sparkline values={vals} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
      </div>

        <div className="card">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="text-sm font-semibold">{selected.title}</div>
              <div className="text-xs tv-muted">{windowN === 999 ? 'All time' : `Last ${windowN} shifts`}</div>
            </div>
            <div className="flex gap-2">
              {[7, 14, 30].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={
                    'px-3 py-2 rounded-xl border text-sm ' +
                    (windowN === n ? 'font-semibold' : 'opacity-75')
                  }
                  style={{ borderColor: windowN === n ? 'var(--brand)' : 'rgba(148,163,184,0.35)' }}
                  onClick={() => setWindowN(n as any)}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                className={'px-3 py-2 rounded-xl border text-sm ' + (windowN === 999 ? 'font-semibold' : 'opacity-75')}
                style={{ borderColor: windowN === 999 ? 'var(--brand)' : 'rgba(148,163,184,0.35)' }}
                onClick={() => setWindowN(999)}
              >
                All
              </button>
            </div>
          </div>

         <div className="mt-3">
  <ColumnChart points={series} unit={selected.unit} yLabel={selected.title} />
</div>


          <div className="mt-3 text-xs tv-muted">
            Dashed line = your average for the selected window (non‑zero shifts). Hover a bar to see the value.
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card">
            <div className="text-sm font-semibold mb-2">Personal benchmarks</div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <div className="tv-muted">Average</div>
                <div className="font-semibold">
                  {selected.id === 'shifts' ? Math.round(currentAvg) : Math.round(currentAvg)} {selected.unit}
                  {selected.id === 'shifts' ? '' : ' / shift'}
                </div>
              </div>
              {selected.id !== 'shifts' && (
                <div className="flex items-center justify-between">
                  <div className="tv-muted">Typical range</div>
                  <div className="font-semibold">
                    {Math.round(typical.p25)} – {Math.round(typical.p75)} {selected.unit}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <div className="tv-muted">Best shift</div>
                <div className="font-semibold">
                  {Math.round(best.value)} {selected.unit}{' '}
                  <span className="tv-muted font-normal">({best.date} {best.dn})</span>
                </div>
              </div>
              {selected.id !== 'shifts' && (
                <div className="flex items-center justify-between">
                  <div className="tv-muted">Change vs previous window</div>
                  <div className="font-semibold" style={{ color: deltaPct >= 0 ? 'var(--ok)' : 'var(--warn)' }}>
                    {prevWindowRows.length ? `${deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(0)}%` : '–'}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="text-sm font-semibold mb-2">Consistency & reliability</div>
            <div className="flex items-center justify-between">
              <div className="tv-muted text-sm">Consistency</div>
              <div
                className="font-semibold"
                style={{
                  color:
                    consistency.label === 'High'
                      ? 'var(--ok)'
                      : consistency.label === 'Medium'
                        ? '#64748b'
                        : 'var(--warn)',
                }}
              >
                {consistency.label}
              </div>
            </div>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <div className="tv-muted">Non-zero shifts</div>
                <div className="font-semibold">{nonZeroPct.toFixed(0)}%</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="tv-muted">Shifts in window</div>
                <div className="font-semibold">{series.length}</div>
              </div>
              {selected.id !== 'shifts' && (
                <div className="flex items-center justify-between">
                  <div className="tv-muted">Variance</div>
                  <div className="font-semibold">{(consistency.variance * 100).toFixed(0)}%</div>
                </div>
              )}
            </div>
            <div className="mt-3 text-xs tv-muted">
              Consistency is based on how stable your output is across the selected window.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="text-sm font-semibold mb-2">Calendar heatmap</div>
          <div className="text-xs tv-muted mb-3">Tap a day to see your output.</div>
          <HeatmapMonth points={monthPoints} selectedDate={selectedDate} onSelect={setSelectedDate} />
          {selectedDate && (
            <div className="mt-3 rounded-2xl border tv-border p-4">
              <div className="text-sm font-semibold">{selectedDate}</div>
              <div className="text-sm text-slate-700 mt-1">
                {selected.title}: <span className="font-semibold">{Math.round(selectedDateValue || 0)} {selected.unit}</span>
              </div>
              <div className="text-[11px] tv-muted mt-2">Tip: switch cards to shade the calendar by a different metric.</div>
            </div>
          )}
        </div>

        {loading && (
          <div className="card">
            <div className="text-sm tv-muted">Loading…</div>
          </div>
        )}
        {error && (
          <div className="card">
            <div className="text-sm font-semibold mb-1">Couldn’t load</div>
            <div className="text-sm tv-muted">{error}</div>
            <div className="mt-3 flex gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                Retry
              </button>
              <button
                className="px-3 py-2 rounded-xl border tv-border text-sm"
                onClick={() => nav('/Main')}
              >
                Back
              </button>
            </div>
          </div>
        )}
    </div>
  );
}