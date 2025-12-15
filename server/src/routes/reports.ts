import { Router } from 'express';
import { db } from '../lib/db.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// --- helpers ---
function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
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

// Flatten totals_json into metric -> numeric value for that shift (summing all activities/subs)
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

// Build per-metric milestones from rows: [{date,dn,totals_json}]
function computeMilestones(rows: any[]) {
  // 1) collect per-shift metric values and per-day metric sums
  const dayMetricSums = new Map<string, Record<string, number>>(); // date -> metric -> sum
  const shiftMetricValues: { date: string; dn: string; metric: string; value: number }[] = [];
  const allMetrics = new Set<string>();

  for (const r of rows) {
    const date = String(r.date || '');
    const dn = String(r.dn || '').toUpperCase();
    const metricMap = flattenTotalsToMetricMap(r.totals_json);

    // per-shift metric records (for DS/NS avg)
    for (const [metric, value] of Object.entries(metricMap)) {
      allMetrics.add(metric);
      if (value !== 0) {
        shiftMetricValues.push({ date, dn, metric, value });
      } else {
        // still track metric existence
        shiftMetricValues.push({ date, dn, metric, value: 0 });
      }
    }

    // per-day sums
    const dayMap = dayMetricSums.get(date) || {};
    for (const [metric, value] of Object.entries(metricMap)) {
      dayMap[metric] = (dayMap[metric] || 0) + n(value);
      allMetrics.add(metric);
    }
    dayMetricSums.set(date, dayMap);
  }

  // If no valid dates, return empty milestones
  const dates = Array.from(dayMetricSums.keys())
    .filter(isValidYmd)
    .sort((a, b) => a.localeCompare(b));

  if (dates.length === 0 || allMetrics.size === 0) {
    return { byMetric: {} as any };
  }

  // build continuous date range with 0 fills
  const start = parseYmd(dates[0]);
  const end = parseYmd(dates[dates.length - 1]);

  const timeline: { date: string; metrics: Record<string, number> }[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const key = ymd(d);
    timeline.push({ date: key, metrics: dayMetricSums.get(key) || {} });
  }

  // Pre-init results
  const byMetric: Record<
    string,
    {
      bestDay: MilestoneBestDay;
      bestWeek: MilestoneBestWeek;
      bestMonth: MilestoneBestMonth;
      shiftCompare: MilestoneShiftCompare;
    }
  > = {};

  // Monthly aggregation helper per metric
  // month -> metric -> total
  const monthTotals = new Map<string, Record<string, number>>();
  for (const t of timeline) {
    const month = t.date.slice(0, 7); // YYYY-MM
    const m = monthTotals.get(month) || {};
    for (const metric of allMetrics) {
      m[metric] = (m[metric] || 0) + n(t.metrics[metric] || 0);
    }
    monthTotals.set(month, m);
  }

  // Shift compare aggregation per metric
  const shiftAgg: Record<
    string,
    { sumDS: number; sumNS: number; countDS: number; countNS: number }
  > = {};
  for (const metric of allMetrics) {
    shiftAgg[metric] = { sumDS: 0, sumNS: 0, countDS: 0, countNS: 0 };
  }
  // We need per-shift values; if a metric didn't exist in a shift, treat as 0 for fairness
  // We'll iterate rows instead, using metricMap, to ensure missing metrics count as 0 for DS/NS averages.
  for (const r of rows) {
    const dn = String(r.dn || '').toUpperCase();
    const metricMap = flattenTotalsToMetricMap(r.totals_json);
    for (const metric of allMetrics) {
      const val = n(metricMap[metric] || 0);
      if (dn === 'DS') {
        shiftAgg[metric].sumDS += val;
        shiftAgg[metric].countDS += 1;
      } else if (dn === 'NS') {
        shiftAgg[metric].sumNS += val;
        shiftAgg[metric].countNS += 1;
      }
    }
  }

  // Compute per metric milestones
  for (const metric of allMetrics) {
    // Best day
    let bestDay: MilestoneBestDay = { total: 0, date: timeline[0].date };
    for (const t of timeline) {
      const v = n(t.metrics[metric] || 0);
      if (v > bestDay.total) bestDay = { total: v, date: t.date };
    }

    // Best rolling 7-day (consecutive)
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
        if (winSum > bestWeek.total) {
          bestWeek = { total: winSum, start: startDate, end: endDate };
        }
      }
    }

    // Best month
    let bestMonth: MilestoneBestMonth = { total: 0, month: Array.from(monthTotals.keys())[0] };
    for (const [month, m] of monthTotals.entries()) {
      const v = n(m[metric] || 0);
      if (v > bestMonth.total) bestMonth = { total: v, month };
    }

    // Shift compare
    const agg = shiftAgg[metric];
    const avgDS = agg.countDS ? agg.sumDS / agg.countDS : 0;
    const avgNS = agg.countNS ? agg.sumNS / agg.countNS : 0;
    let winner: 'DS' | 'NS' | 'TIE' = 'TIE';
    if (avgDS > avgNS) winner = 'DS';
    else if (avgNS > avgDS) winner = 'NS';

    const shiftCompare: MilestoneShiftCompare = {
      winner,
      avgDS,
      avgNS,
      countDS: agg.countDS,
      countNS: agg.countNS,
    };

    byMetric[metric] = { bestDay, bestWeek, bestMonth, shiftCompare };
  }

  return { byMetric };
}

// GET /api/reports/summary
// Returns: { rows: [{id,date,dn,totals_json}], rollup: { activity: { sub: { metric: number } } }, milestones }
router.get('/summary', authMiddleware, (req: any, res: any) => {
  const authUserId = req.user_id;

  // Optional override via query (?user_id=123) for crew comparison
  const userIdParamRaw = req.query.user_id;
  let requestedUserId: number | undefined;

  if (typeof userIdParamRaw === 'string') {
    const nUser = Number(userIdParamRaw);
    if (Number.isFinite(nUser) && nUser > 0) {
      requestedUserId = nUser;
    }
  }

  const targetUserId = requestedUserId || authUserId;

  const from = String(req.query.from || '0001-01-01');
  const to = String(req.query.to || '9999-12-31');

  if (!targetUserId) {
    return res.status(400).json({ error: 'missing user' });
  }

  // First pull all shifts in range for this user
  db.all(
    `SELECT id, date, dn, totals_json
       FROM shifts
      WHERE user_id = ? AND date BETWEEN ? AND ?
      ORDER BY date`,
    [targetUserId, from, to],
    (err: any, shiftRows: any[]) => {
      if (err) return res.status(500).json({ error: 'query failed' });

      const rows: any[] = [];
      const rollup: any = {};

      if (!shiftRows || shiftRows.length === 0) {
        return res.json({ rows: [], rollup: {}, milestones: { byMetric: {} } });
      }

      // Load activities for these shifts so we can guarantee correct hauling totals
      const ids = shiftRows.map((r) => r.id);
      const inClause = '(' + ids.map(() => '?').join(',') + ')';

      db.all(
        `SELECT shift_id, activity, sub_activity, payload_json
           FROM shift_activities
          WHERE shift_id IN ${inClause}`,
        ids,
        (aerr: any, actRows: any[]) => {
          if (aerr) return res.status(500).json({ error: 'activities query failed' });

          // Index activities by shift
          const actByShift: Record<number, any[]> = {};
          for (const a of actRows || []) {
            (actByShift[a.shift_id] ||= []).push(a);
          }

          // Build per-row totals and rollup
          for (const r of shiftRows) {
            // Start from stored totals_json if present
            let t: any = {};
            try {
              const base = JSON.parse(r.totals_json || '{}');
              if (base && typeof base === 'object') t = base;
            } catch {
              // ignore bad JSON
            }

            // Ensure hauling section is computed from activities (device-agnostic)
            // Reset hauling so we don't mix pre-existing raw totals_json with derived values
            t['hauling'] = {};
            const acts = actByShift[r.id] || [];

            for (const a of acts) {
              const actName = String(a.activity || '').toLowerCase();
              const sub = a.sub_activity || 'All';

              if (actName === 'hauling' || actName === 'truck' || actName === 'trucking') {
                try {
                  const p = JSON.parse(a.payload_json || '{}');
                  const v = p && p.values ? p.values : {};

                  const trucks =
                    parseFloat(String(v['Trucks'] ?? v['No of trucks'] ?? v['No of Trucks'] ?? 0)) ||
                    0;
                  const weight = parseFloat(String(v['Weight'] ?? 0)) || 0;
                  const distance = parseFloat(String(v['Distance'] ?? 0)) || 0;

                  t['hauling'] ||= {};
                  t['hauling'][sub] ||= {};
                  t['hauling'][sub]['Total Trucks'] = (t['hauling'][sub]['Total Trucks'] || 0) + trucks;
                  t['hauling'][sub]['Total Distance'] =
                    (t['hauling'][sub]['Total Distance'] || 0) + trucks * distance;
                  t['hauling'][sub]['Total Weight'] =
                    (t['hauling'][sub]['Total Weight'] || 0) + trucks * weight;
                  t['hauling'][sub]['Total TKMS'] =
                    (t['hauling'][sub]['Total TKMS'] || 0) + trucks * weight * distance;

                  // Also accumulate into 'All' combined bucket
                  t['hauling']['All'] ||= {};
                  t['hauling']['All']['Total Trucks'] = (t['hauling']['All']['Total Trucks'] || 0) + trucks;
                  t['hauling']['All']['Total Distance'] =
                    (t['hauling']['All']['Total Distance'] || 0) + trucks * distance;
                  t['hauling']['All']['Total Weight'] =
                    (t['hauling']['All']['Total Weight'] || 0) + trucks * weight;
                  t['hauling']['All']['Total TKMS'] =
                    (t['hauling']['All']['Total TKMS'] || 0) + trucks * weight * distance;
                } catch {
                  // ignore bad payload JSON
                }
              }
            }

            // Prune any raw hauling keys; keep only derived display metrics
            if (t['hauling']) {
              const ALLOWED = new Set(['Total Trucks', 'Total Distance', 'Total Weight', 'Total TKMS']);
              for (const s of Object.keys(t['hauling'])) {
                for (const k of Object.keys(t['hauling'][s] || {})) {
                  if (!ALLOWED.has(k)) delete t['hauling'][s][k];
                }
              }
            }

            rows.push({
              id: r.id,
              date: r.date,
              dn: r.dn,
              totals_json: t,
            });

            // Contribute to global rollup
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

          const milestones = computeMilestones(rows);

          res.json({ rows, rollup, milestones });
        },
      );
    },
  );
});

export default router;
