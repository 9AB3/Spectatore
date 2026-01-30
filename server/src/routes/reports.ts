import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// --- helpers ---
function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYmd(s: string) {
  const [y, m, d] = String(s || '').split('-').map((v) => parseInt(v, 10));
  return new Date(y || 0, (m || 1) - 1, d || 1);
}
function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function isValidYmd(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

type MilestoneBestDay = { total: number; date: string };
type MilestoneBestWeek = { total: number; start: string; end: string };
type MilestoneBestMonth = { total: number; month: string };
type MilestoneShiftCompare = {
  winner: 'DS' | 'NS' | 'TIE';
  avgDS: number;
  avgNS: number;
  countDS: number;
  countNS: number;
};

function asObj(v: any): any {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

// --- Milestone metrics (limited set) ---
// These are the ONLY metrics considered for milestone popups.
// Names match the UI copy exactly.
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

type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

function parseBoltLenMeters(v: any) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 0;
  // supports "2.4m" or "2.4"
  const m = parseFloat(s.replace('m', ''));
  return Number.isFinite(m) ? m : 0;
}

function getVal(p: any, field: string) {
  const v = p?.values?.[field];
  return v;
}

function getLoc(p: any) {
  const v = (p && typeof p === 'object' ? (p as any).values : null) || {};
  const loc = String(v?.Location ?? v?.location ?? v?.Heading ?? v?.heading ?? v?.Stope ?? v?.stope ?? '').trim();
  return loc;
}

// Fallback: flatten totals_json into metric -> numeric value for that shift (summing all activities/subs)
function flattenTotalsToMetricMap(t: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!t || typeof t !== 'object') return out;

  for (const act of Object.keys(t)) {
    const actObj = t[act];
    if (!actObj || typeof actObj !== 'object') continue;

    for (const sub of Object.keys(actObj)) {
      const subObj = actObj[sub];
      if (!subObj || typeof subObj !== 'object') continue;

      for (const k of Object.keys(subObj)) {
        const v = n(subObj[k]);
        out[k] = (out[k] || 0) + v;
      }
    }
  }

  return out;
}

// Compute only the milestone metrics for a single shift.
// Prefer shift_activities for accurate derived metrics (unique locations, drillm, tonnes hauled, etc.).
function computeMilestoneMetricMapForShift(
  shiftRow: any,
  acts: Array<{ activity: string; sub_activity: string; payload_json: any }> | undefined,
): Record<MilestoneMetric, number> {
  const out: any = {};
  for (const m of MILESTONE_METRICS) out[m] = 0;

  // If activities aren't available, fall back to totals_json.
  if (!acts || acts.length === 0) {
    const flat = flattenTotalsToMetricMap(shiftRow?.totals_json);
    out['GS Drillm'] = n(flat['GS Drillm'] || 0);
    out['Face Drillm'] = n(flat['Face Drillm'] || flat['Dev Drillm'] || 0);
    out['Truck Loads'] = n(flat['Trucks'] || 0);
    out["TKM's"] = n(flat['TKMs'] || 0);
    out['Tonnes Hauled'] = n(flat['Total Weight'] || flat['Weight'] || 0);
    out['Production drillm'] = n(flat['Metres Drilled'] || 0) + n(flat['Cleanouts Drilled'] || 0) + n(flat['Redrills'] || 0);
    out['Primary Production buckets'] = n(flat['Stope to Truck'] || 0) + n(flat['Stope to SP'] || 0);
    out['Primary Development buckets'] = n(flat['Heading to Truck'] || 0) + n(flat['Heading to SP'] || 0);
    out['Spray Volume'] = n(flat['Spray Volume'] || 0);
    out['Agi Volume'] = n(flat['Agi Volume'] || 0);
    // Backfilling is split by sub-activity, so prefer the nested totals_json shape when available.
    out['Backfill volume'] = n(shiftRow?.totals_json?.Backfilling?.Surface?.Volume ?? flat['Volume'] ?? 0);
    out['Backfill buckets'] = n(shiftRow?.totals_json?.Backfilling?.Underground?.Buckets ?? flat['Buckets'] ?? 0);
    out['Tonnes charged'] = n(flat['Charge kg'] || 0) / 1000;
    out['Tonnes Fired'] = n(flat['Tonnes Fired'] || 0);
    out['Ore tonnes hoisted'] = n(flat['Ore Tonnes'] || 0);
    out['Waste tonnes hoisted'] = n(flat['Waste Tonnes'] || 0);
    out['Total tonnes hoisted'] = out['Ore tonnes hoisted'] + out['Waste tonnes hoisted'];
    return out;
  }

  // Activity-driven metrics
  const gsLocs = new Set<string>();
  const faceLocs = new Set<string>();
  const devChargeLocs = new Set<string>();

  let tonnesHauled = 0;
  let truckLoads = 0;
  let tkms = 0;
  let gsDrillm = 0;
  let faceDrillm = 0;
  let prodDrillm = 0;
  let primProdBuckets = 0;
  let primDevBuckets = 0;
  let sprayVol = 0;
  let agiVol = 0;
  let chargeKg = 0;
  let tonnesFired = 0;
  let oreHoisted = 0;
  let wasteHoisted = 0;

  for (const a of acts) {
    const activity = String(a.activity || '').trim();
    const sub = String(a.sub_activity || '').trim();
    const p = a.payload_json || {};

    if (activity === 'Development' && (sub === 'Ground Support' || sub === 'Rehab')) {
      const loc = getLoc(p);
      if (loc) gsLocs.add(loc);

      const bolts = n(getVal(p, 'No. of Bolts') || getVal(p, 'No of Bolts') || 0);
      const bl = parseBoltLenMeters(getVal(p, 'Bolt Length'));
      if (bolts && bl) gsDrillm += bolts * bl;
    }

    if (activity === 'Development' && sub === 'Face Drilling') {
      const loc = getLoc(p);
      if (loc) faceLocs.add(loc);

      const holes = n(getVal(p, 'No of Holes') || 0);
      const cut = n(getVal(p, 'Cut Length') || 0);
      if (holes && cut) faceDrillm += holes * cut;
    }

    // Development support volumes (simple sum across all Development sub-activities)
    if (activity === 'Development') {
      sprayVol += n(getVal(p, 'Spray Volume') || 0);
      agiVol += n(getVal(p, 'Agi Volume') || 0);
    }

    if (activity === 'Hauling') {
      const trucks = n(getVal(p, 'Trucks') || 0);
      const weight = n(getVal(p, 'Weight') || 0);
      const dist = n(getVal(p, 'Distance') || 0);
      if (trucks) truckLoads += trucks;
      // tonnes hauled = trucks * weight (weight assumed tonnes/truck)
      if (trucks && weight) tonnesHauled += trucks * weight;
      // tkms = trucks * weight * distance
      if (trucks && weight && dist) tkms += trucks * weight * dist;
    }

    if (activity === 'Production Drilling') {
      prodDrillm += n(getVal(p, 'Metres Drilled') || 0);
      prodDrillm += n(getVal(p, 'Cleanouts Drilled') || 0);
      prodDrillm += n(getVal(p, 'Redrills') || 0);
    }

    if (activity === 'Loading' && String(sub).startsWith('Production')) {
      primProdBuckets += n(getVal(p, 'Stope to Truck') || 0);
      primProdBuckets += n(getVal(p, 'Stope to SP') || 0);
    }

    if (activity === 'Loading' && sub === 'Development') {
      primDevBuckets += n(getVal(p, 'Heading to Truck') || 0);
      primDevBuckets += n(getVal(p, 'Heading to SP') || 0);
    }


    if (activity === 'Charging') {
      chargeKg += n(getVal(p, 'Charge kg') || 0);
    }

    if (activity === 'Firing') {
      const loc = getLoc(p);
      if (sub === 'Development' && loc) devChargeLocs.add(loc);
      if (sub === 'Production') tonnesFired += n(getVal(p, 'Tonnes Fired') || 0);
    }


    if (activity === 'Hoisting') {
      oreHoisted += n(getVal(p, 'Ore Tonnes') || 0);
      wasteHoisted += n(getVal(p, 'Waste Tonnes') || 0);
    }
  }

  out['GS Drillm'] = gsDrillm;
  out['Face Drillm'] = faceDrillm;
  out['Headings supported'] = gsLocs.size;
  out['Headings bored'] = faceLocs.size;
  out['Truck Loads'] = truckLoads;
  out["TKM's"] = tkms;
  out['Tonnes Hauled'] = tonnesHauled;
  out['Production drillm'] = prodDrillm;
  out['Primary Production buckets'] = primProdBuckets;
  out['Primary Development buckets'] = primDevBuckets;
  out['Spray Volume'] = sprayVol;
  out['Agi Volume'] = agiVol;
  // Backfilling metrics live under totals_json by sub-activity.
  out['Backfill volume'] = n(shiftRow?.totals_json?.Backfilling?.Surface?.Volume ?? 0);
  out['Backfill buckets'] = n(shiftRow?.totals_json?.Backfilling?.Underground?.Buckets ?? 0);
  out['Tonnes charged'] = chargeKg / 1000;
  out['Headings Fired'] = devChargeLocs.size;
  out['Tonnes Fired'] = tonnesFired;
  out['Ore tonnes hoisted'] = oreHoisted;
  out['Waste tonnes hoisted'] = wasteHoisted;
  out['Total tonnes hoisted'] = oreHoisted + wasteHoisted;

  return out;
}

// Build per-metric milestones from shift rows: [{id,date,dn,totals_json}] plus shift_activities per shift
function computeMilestones(
  rows: any[],
  actsByShiftId: Map<number, Array<{ activity: string; sub_activity: string; payload_json: any }>>,
) {
  const dayMetricSums = new Map<string, Record<string, number>>();
  const allMetrics = new Set<string>(MILESTONE_METRICS as any);

  for (const r of rows) {
    const date = String(r.date || '');
    const dn = String(r.dn || '').toUpperCase();
    void dn; // kept for backward compatibility

    const acts = actsByShiftId.get(Number(r.id)) || [];
    const metricMap = computeMilestoneMetricMapForShift(r, acts);

    const dayMap = dayMetricSums.get(date) || {};
    for (const metric of MILESTONE_METRICS) {
      const value = n((metricMap as any)[metric] || 0);
      dayMap[metric] = (dayMap[metric] || 0) + value;
    }
    dayMetricSums.set(date, dayMap);
  }

  const dates = Array.from(dayMetricSums.keys())
    .filter(isValidYmd)
    .sort((a, b) => a.localeCompare(b));

  if (dates.length === 0) {
    return { byMetric: {} as any };
  }

  const start = parseYmd(dates[0]);
  const end = parseYmd(dates[dates.length - 1]);

  const timeline: { date: string; metrics: Record<string, number> }[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const key = ymd(d);
    timeline.push({ date: key, metrics: dayMetricSums.get(key) || {} });
  }

  const byMetric: Record<
    string,
    {
      bestDay: MilestoneBestDay;
      bestWeek: MilestoneBestWeek;
      bestMonth: MilestoneBestMonth;
      shiftCompare: MilestoneShiftCompare;
    }
  > = {};

  // Monthly totals
  const monthTotals = new Map<string, Record<string, number>>();
  for (const t of timeline) {
    const month = t.date.slice(0, 7);
    const m = monthTotals.get(month) || {};
    for (const metric of MILESTONE_METRICS) {
      m[metric] = (m[metric] || 0) + n(t.metrics[metric] || 0);
    }
    monthTotals.set(month, m);
  }

  // Shift compare: compute from per-shift metric maps (DS vs NS)
  const shiftAgg: Record<
    string,
    { sumDS: number; sumNS: number; countDS: number; countNS: number }
  > = {};
  for (const metric of MILESTONE_METRICS)
    shiftAgg[metric] = { sumDS: 0, sumNS: 0, countDS: 0, countNS: 0 };

  for (const r of rows) {
    const dn = String(r.dn || '').toUpperCase();
    const acts = actsByShiftId.get(Number(r.id)) || [];
    const metricMap = computeMilestoneMetricMapForShift(r, acts);

    for (const metric of MILESTONE_METRICS) {
      const val = n((metricMap as any)[metric] || 0);
      if (dn === 'DS') {
        shiftAgg[metric].sumDS += val;
        shiftAgg[metric].countDS += 1;
      } else if (dn === 'NS') {
        shiftAgg[metric].sumNS += val;
        shiftAgg[metric].countNS += 1;
      }
    }
  }

  for (const metric of MILESTONE_METRICS) {
    let bestDay: MilestoneBestDay = { total: 0, date: timeline[0].date };
    for (const t of timeline) {
      const v = n(t.metrics[metric] || 0);
      if (v > bestDay.total) bestDay = { total: v, date: t.date };
    }

    let bestWeek: MilestoneBestWeek = {
      total: 0,
      start: timeline[0].date,
      end: timeline[Math.min(6, timeline.length - 1)].date,
    };
    let winSum = 0;
    for (let i = 0; i < timeline.length; i++) {
      winSum += n(timeline[i].metrics[metric] || 0);
      if (i >= 7) winSum -= n(timeline[i - 7].metrics[metric] || 0);
      if (i >= 6) {
        const startDate = timeline[i - 6].date;
        const endDate = timeline[i].date;
        if (winSum > bestWeek.total) bestWeek = { total: winSum, start: startDate, end: endDate };
      }
    }

    const monthKeys = Array.from(monthTotals.keys());
    let bestMonth: MilestoneBestMonth = { total: 0, month: monthKeys[0] || timeline[0].date.slice(0, 7) };
    for (const [month, m] of monthTotals.entries()) {
      const v = n(m[metric] || 0);
      if (v > bestMonth.total) bestMonth = { total: v, month };
    }

    const agg = shiftAgg[metric];
    const avgDS = agg.countDS ? agg.sumDS / agg.countDS : 0;
    const avgNS = agg.countNS ? agg.sumNS / agg.countNS : 0;
    let winner: 'DS' | 'NS' | 'TIE' = 'TIE';
    if (avgDS > avgNS) winner = 'DS';
    else if (avgNS > avgDS) winner = 'NS';

    byMetric[metric] = {
      bestDay,
      bestWeek,
      bestMonth,
      shiftCompare: { winner, avgDS, avgNS, countDS: agg.countDS, countNS: agg.countNS },
    };
  }

  return { byMetric };
}
// GET /api/reports/summary
router.get('/summary', authMiddleware, async (req: any, res: any) => {
  const authUserId = req.user_id;

  // Optional override via query (?user_id=123) for crew comparison
  const userIdParamRaw = req.query.user_id;
  const requestedUserId = typeof userIdParamRaw === 'string' && Number(userIdParamRaw) > 0 ? Number(userIdParamRaw) : undefined;
  const targetUserId = requestedUserId || authUserId;
  const from = String(req.query.from || '0001-01-01');
  const to = String(req.query.to || '9999-12-31');
  if (!targetUserId) return res.status(400).json({ error: 'missing user' });

  try {
    const shiftR = await pool.query(
      `SELECT id, date::text as date, dn, totals_json
         FROM shifts
        WHERE user_id=$1 AND date::date BETWEEN $2::date AND $3::date
        ORDER BY date ASC`,
      [targetUserId, from, to],
    );

    const shiftRows = shiftR.rows || [];
    if (shiftRows.length === 0) {
      // No shifts in range
      return res.json({ rows: [], rollup: {}, milestones: { byMetric: {} } });
    }

    const ids = shiftRows.map((r: any) => r.id);
    const actR = await pool.query(
      `SELECT shift_id, activity, sub_activity, payload_json
         FROM shift_activities
        WHERE shift_id = ANY($1::bigint[])`,
      [ids],
    );
    const actRows = actR.rows || [];

    const actByShift: Record<string, any[]> = {};
    for (const a of actRows) {
      (actByShift[String(a.shift_id)] ||= []).push(a);
    }

    const rows: any[] = [];
    const rollup: any = {};

    for (const r of shiftRows) {
      let t: any = asObj(r.totals_json);

      // Ensure hauling section is computed from activities (device-agnostic)
      t['hauling'] = {};
      const acts = actByShift[String(r.id)] || [];
      for (const a of acts) {
        const actName = String(a.activity || '').toLowerCase();
        const sub = a.sub_activity || 'All';
        if (actName === 'hauling' || actName === 'truck' || actName === 'trucking') {
          const p = asObj(a.payload_json);
          const v = p && p.values ? p.values : {};

          const trucks = parseFloat(String(v['Trucks'] ?? v['No of trucks'] ?? v['No of Trucks'] ?? 0)) || 0;
          const weight = parseFloat(String(v['Weight'] ?? 0)) || 0;
          const distance = parseFloat(String(v['Distance'] ?? 0)) || 0;

          t['hauling'] ||= {};
          t['hauling'][sub] ||= {};
          t['hauling'][sub]['Total Trucks'] = (t['hauling'][sub]['Total Trucks'] || 0) + trucks;
          t['hauling'][sub]['Total Distance'] = (t['hauling'][sub]['Total Distance'] || 0) + trucks * distance;
          t['hauling'][sub]['Total Weight'] = (t['hauling'][sub]['Total Weight'] || 0) + trucks * weight;
          t['hauling'][sub]['Total TKMS'] = (t['hauling'][sub]['Total TKMS'] || 0) + trucks * weight * distance;

          t['hauling']['All'] ||= {};
          t['hauling']['All']['Total Trucks'] = (t['hauling']['All']['Total Trucks'] || 0) + trucks;
          t['hauling']['All']['Total Distance'] = (t['hauling']['All']['Total Distance'] || 0) + trucks * distance;
          t['hauling']['All']['Total Weight'] = (t['hauling']['All']['Total Weight'] || 0) + trucks * weight;
          t['hauling']['All']['Total TKMS'] = (t['hauling']['All']['Total TKMS'] || 0) + trucks * weight * distance;
        }
      }

      if (t['hauling']) {
        const ALLOWED = new Set(['Total Trucks', 'Total Distance', 'Total Weight', 'Total TKMS']);
        for (const s of Object.keys(t['hauling'])) {
          for (const k of Object.keys(t['hauling'][s] || {})) {
            if (!ALLOWED.has(k)) delete t['hauling'][s][k];
          }
        }
      }

      rows.push({ id: r.id, date: r.date, dn: r.dn, totals_json: t });

      for (const act of Object.keys(t || {})) {
        rollup[act] ||= {};
        for (const sub of Object.keys(t[act] || {})) {
          rollup[act][sub] ||= {};
          for (const k of Object.keys(t[act][sub] || {})) {
            const v = Number(t[act][sub][k] || 0);
            rollup[act][sub][k] = (rollup[act][sub][k] || 0) + v;
          }
        }
      }
    }

    const actsByShiftId = new Map<number, Array<{ activity: string; sub_activity: string; payload_json: any }>>();
    for (const [sid, list] of Object.entries(actByShift)) {
      actsByShiftId.set(Number(sid), list as any);
    }

    const milestones = computeMilestones(rows, actsByShiftId);
    return res.json({ rows, rollup, milestones });
  } catch (err) {
    console.error('reports summary failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});


// You vs You: shift totals + raw shift_activities payloads (for location-based metrics)
router.get('/you-vs-you', authMiddleware, async (req: any, res: any) => {
  // authMiddleware in this codebase sets req.user_id (see /summary route)
  const authUserId = req.user_id;
  const from = String(req.query.from || '0001-01-01');
  const to = String(req.query.to || '9999-12-31');
  if (!authUserId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const shiftR = await pool.query(
      `SELECT id, date::text as date, dn, totals_json
         FROM shifts
        WHERE user_id=$1 AND date::date BETWEEN $2::date AND $3::date
        ORDER BY date ASC`,
      [authUserId, from, to],
    );

    const rows = (shiftR.rows || []).map((r: any) => ({
      id: Number(r.id),
      date: String(r.date),
      dn: String(r.dn || ''),
      totals_json: asObj(r.totals_json),
      activities: [] as any[],
    }));

    const ids = rows.map((r: any) => r.id).filter((x: any) => Number.isFinite(x) && x > 0);
    if (ids.length) {
      const actR = await pool.query(
        `SELECT shift_id, activity, sub_activity, payload_json
           FROM shift_activities
          WHERE shift_id = ANY($1::int[])
          ORDER BY shift_id ASC, id ASC`,
        [ids],
      );

      const byShift = new Map<number, any[]>();
      for (const a of actR.rows || []) {
        const sid = Number(a.shift_id);
        const list = byShift.get(sid) || [];
        const pj = asObj(a.payload_json);
        list.push({
          activity: String(a.activity || pj.activity || ''),
          sub_activity: String(a.sub_activity || pj.sub_activity || pj.subActivity || ''),
          ...pj,
        });
        byShift.set(sid, list);
      }

      for (const r of rows) {
        r.activities = byShift.get(r.id) || [];
      }
    }

    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

// User vs Network: return a metric timeline for the authed user and their accepted connections
// GET /api/reports/network?metric=...&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/network', authMiddleware, async (req: any, res: any) => {
  const authUserId = req.user_id;
  const from = String(req.query.from || '0001-01-01');
  const to = String(req.query.to || '9999-12-31');
  const metric = String(req.query.metric || '').trim();
  const compareUserId = Number(req.query.compare_user_id || 0);

  if (!authUserId) return res.status(401).json({ error: 'unauthorized' });
  if (!metric || !(MILESTONE_METRICS as any).includes(metric)) {
    return res.status(400).json({ error: 'metric must be one of milestone metrics' });
  }

  try {
    // Get accepted connection user ids
    const c = await pool.query(
      `SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END as other_id
         FROM connections
        WHERE (requester_id=$1 OR addressee_id=$1) AND status='accepted'`,
      [authUserId],
    );
    const otherIds = (c.rows || []).map((r: any) => Number(r.other_id)).filter((x: any) => Number.isFinite(x) && x > 0);

    // Fetch members for display
    let members: any[] = [];
    if (otherIds.length) {
      const m = await pool.query('SELECT id, name, email FROM users WHERE id = ANY($1::int[])', [otherIds]);
      members = m.rows || [];
    }

    // Helper to load shifts + activities then compute per-day metric totals
    async function loadDaily(userId: number) {
      const shiftR = await pool.query(
        `SELECT id, date::text as date, dn, totals_json
           FROM shifts
          WHERE user_id=$1 AND date::date BETWEEN $2::date AND $3::date
          ORDER BY date ASC`,
        [userId, from, to],
      );
      const shiftRows = shiftR.rows || [];
      if (shiftRows.length === 0) return { daily: new Map<string, number>(), best: { total: 0, date: '' } };

      const ids = shiftRows.map((r: any) => r.id);
      const actR = await pool.query(
        `SELECT shift_id, activity, sub_activity, payload_json
           FROM shift_activities
          WHERE shift_id = ANY($1::bigint[])`,
        [ids],
      );
      const actByShift: Record<string, any[]> = {};
      for (const a of actR.rows || []) (actByShift[String(a.shift_id)] ||= []).push(a);

      const daily = new Map<string, number>();
      let best = { total: 0, date: String(shiftRows[0].date || '') };
      for (const r of shiftRows) {
        const sid = Number(r.id);
        const acts = actByShift[String(sid)] || [];
        const mm = computeMilestoneMetricMapForShift(
          { id: sid, date: String(r.date), dn: String(r.dn || ''), totals_json: asObj(r.totals_json) },
          acts as any,
        );
        const v = n((mm as any)[metric] || 0);
        const d = String(r.date);
        daily.set(d, (daily.get(d) || 0) + v);
      }
      for (const [d, v] of daily.entries()) {
        if (v > best.total) best = { total: v, date: d };
      }
      return { daily, best };
    }



    function avgNonZero(values: number[]) {
      const vals = values.filter((v) => Number.isFinite(v) && v > 0);
      if (!vals.length) return 0;
      return vals.reduce((acc, v) => acc + v, 0) / vals.length;
    }

    // All-time best (PB) for this metric (best single-day total across all shifts).
    // Uses totals_json only (fast).
    // All-time best (PB) for this metric (best single-day total across all shifts).
    // Must use the same metric computation path as the period series (includes shift_activities),
    // otherwise PB can be inconsistent with Avg/Total for metrics derived from activities.
    async function loadAllTimeBest(userId: number): Promise<{ total: number; date: string }> {
      const shiftR = await pool.query(
        `SELECT id, date::text as date, dn, totals_json
           FROM shifts
          WHERE user_id=$1
          ORDER BY date ASC`,
        [userId],
      );
      const shiftRows = shiftR.rows || [];
      if (!shiftRows.length) return { total: 0, date: '' };

      const ids = shiftRows.map((r: any) => r.id);
      const actR = await pool.query(
        `SELECT shift_id, activity, sub_activity, payload_json
           FROM shift_activities
          WHERE shift_id = ANY($1::bigint[])`,
        [ids],
      );
      const actByShift: Record<string, any[]> = {};
      for (const a of actR.rows || []) (actByShift[String(a.shift_id)] ||= []).push(a);

      const daily = new Map<string, number>();
      for (const r of shiftRows) {
        const sid = Number(r.id);
        const acts = actByShift[String(sid)] || [];
        const mm = computeMilestoneMetricMapForShift(
          { id: sid, date: String(r.date), dn: String(r.dn || ''), totals_json: asObj(r.totals_json) },
          acts as any,
        );
        const v = n((mm as any)[metric] || 0);
        const d = String(r.date);
        daily.set(d, (daily.get(d) || 0) + v);
      }

      let best = { total: 0, date: String(shiftRows[0].date || '') };
      for (const [d, v] of daily.entries()) {
        if (v > best.total) best = { total: v, date: d };
      }
      return best;
    }const user = await loadDaily(authUserId);

    const crewDailyList: Array<{ id: number; name: string; email: string; daily: Map<string, number>; best: any }> = [];
    for (const m of members) {
      const uid = Number(m.id);
      const d = await loadDaily(uid);
      crewDailyList.push({ id: uid, name: String(m.name || ''), email: String(m.email || ''), daily: d.daily, best: d.best });
    }


    const userAllTimeBest = await loadAllTimeBest(authUserId);
    const userPeriodAvg = avgNonZero(Array.from(user.daily.values()).map((v) => n(v)));
    const userPeriodTotal = Array.from(user.daily.values()).reduce((acc, v) => acc + n(v), 0);

    // Precompute crew all-time PBs and period avgs for tiles
    const crewTiles = [] as Array<{
      id: number;
      name: string;
      email: string;
      theirAllTimeBest: { total: number; date: string };
      theirPeriodAvg: number;
      theirPeriodTotal: number;
      yourAllTimeBest: { total: number; date: string };
      yourPeriodAvg: number;
      yourPeriodTotal: number;
      deltaPct: number;
    }>;

    for (const cm of crewDailyList) {
      const theirAllTimeBest = await loadAllTimeBest(cm.id);
      const theirPeriodAvg = avgNonZero(Array.from(cm.daily.values()).map((v) => n(v)));
      const theirPeriodTotal = Array.from(cm.daily.values()).reduce((acc, v) => acc + n(v), 0);
      const base = theirPeriodAvg;
      const deltaPct = base > 0 ? ((userPeriodAvg - base) / base) * 100 : userPeriodAvg > 0 ? 100 : 0;
      crewTiles.push({
        id: cm.id,
        name: cm.name,
        email: cm.email,
        theirAllTimeBest,
        theirPeriodAvg,
        theirPeriodTotal,
        yourAllTimeBest: userAllTimeBest,
        yourPeriodAvg: userPeriodAvg,
        yourPeriodTotal: userPeriodTotal,
        deltaPct,
      });
    }

    // Optional: compare against a specific crew mate (must be an accepted connection)
    const compareMember = compareUserId && otherIds.includes(compareUserId)
      ? crewDailyList.find((x) => x.id === compareUserId) || null
      : null;

    // Build timeline across the full date range between from..to, using the user's date span as anchor when possible
    // If the user has no data, we still build timeline from from..to (clamped to 370 days for safety)
    const start = isValidYmd(from) ? parseYmd(from) : (isValidYmd(to) ? parseYmd(to) : new Date());
    const end = isValidYmd(to) ? parseYmd(to) : start;
    const maxDays = 370;

    const timeline: Array<{ date: string; user: number; network_avg: number; network_best: number; compare: number }> = [];
    let days = 0;
    for (let d = new Date(start); d <= end && days < maxDays; d = addDays(d, 1)) {
      const key = ymd(d);
      const uVal = user.daily.get(key) || 0;

      let sum = 0;
      let cnt = 0;
      let best = 0;
      for (const cm of crewDailyList) {
        const v = cm.daily.get(key);
        if (v == null) continue;
        sum += v;
        cnt += 1;
        if (v > best) best = v;
      }
      const avg = cnt ? sum / cnt : 0;
      const cmp = compareMember ? (compareMember.daily.get(key) || 0) : avg;
      timeline.push({ date: key, user: uVal, network_avg: avg, network_best: best, compare: cmp });
      days++;
    }

    // Determine network best day (across crew) for this metric within the range
    let networkBest = { total: 0, date: '', user_id: 0, name: '' };
    for (const cm of crewDailyList) {
      if (cm.best.total > networkBest.total) {
        networkBest = { total: cm.best.total, date: cm.best.date, user_id: cm.id, name: cm.name };
      }
    }
    // Period totals (used by the "You vs Crew" ranked list UI)
        const crewAllTimePbById = new Map<number, number>(crewTiles.map((t) => [t.id, n(t.theirAllTimeBest?.total)]));

    const crewTotals = crewDailyList
      .map((cm) => ({
        id: cm.id,
        name: cm.name,
        email: cm.email,
        total: Array.from(cm.daily.values()).reduce((acc, v) => acc + n(v), 0),
        avg: avgNonZero(Array.from(cm.daily.values()).map((v) => n(v))),
        pb: Number(crewAllTimePbById.get(cm.id) || 0),
      }))
      .sort((a, b) => b.total - a.total);

    return res.json({
      metric,
      userAllTimeBest,
      userPeriodAvg,
      crewTiles,
      members: crewDailyList.map((x) => ({ id: x.id, name: x.name, email: x.email })),
      userBest: user.best,
      networkBest,
      compare: compareMember ? { user_id: compareMember.id, name: compareMember.name, email: compareMember.email } : null,
      userPeriodTotal,
      crewTotals,
      timeline,
    });
  } catch (err) {
    console.error('reports network failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});

export default router;
