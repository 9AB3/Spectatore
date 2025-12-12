import { Router } from 'express';
import { db } from '../lib/db';
import { authMiddleware } from '../lib/auth';

const router = Router();

// GET /api/reports/summary
// Returns: { rows: [{id,date,dn,totals_json}], rollup: { activity: { sub: { metric: number } } } }
router.get('/summary', authMiddleware, (req: any, res: any) => {
  const authUserId = req.user_id;

  // Optional override via query (?user_id=123) for crew comparison
  const userIdParamRaw = req.query.user_id;
  let requestedUserId: number | undefined;

  if (typeof userIdParamRaw === 'string') {
    const n = Number(userIdParamRaw);
    if (Number.isFinite(n) && n > 0) {
      requestedUserId = n;
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
        return res.json({ rows: [], rollup: {} });
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
                    parseFloat(
                      String(
                        v['Trucks'] ??
                          v['No of trucks'] ??
                          v['No of Trucks'] ??
                          0,
                      ),
                    ) || 0;
                  const weight = parseFloat(String(v['Weight'] ?? 0)) || 0;
                  const distance = parseFloat(String(v['Distance'] ?? 0)) || 0;

                  t['hauling'] ||= {};
                  t['hauling'][sub] ||= {};
                  t['hauling'][sub]['Total Trucks'] =
                    (t['hauling'][sub]['Total Trucks'] || 0) + trucks;
                  t['hauling'][sub]['Total Distance'] =
                    (t['hauling'][sub]['Total Distance'] || 0) +
                    trucks * distance;
                  t['hauling'][sub]['Total Weight'] =
                    (t['hauling'][sub]['Total Weight'] || 0) +
                    trucks * weight;
                  t['hauling'][sub]['Total TKMS'] =
                    (t['hauling'][sub]['Total TKMS'] || 0) +
                    trucks * weight * distance;

                  // Also accumulate into 'All' combined bucket
                  t['hauling']['All'] ||= {};
                  t['hauling']['All']['Total Trucks'] =
                    (t['hauling']['All']['Total Trucks'] || 0) + trucks;
                  t['hauling']['All']['Total Distance'] =
                    (t['hauling']['All']['Total Distance'] || 0) +
                    trucks * distance;
                  t['hauling']['All']['Total Weight'] =
                    (t['hauling']['All']['Total Weight'] || 0) +
                    trucks * weight;
                  t['hauling']['All']['Total TKMS'] =
                    (t['hauling']['All']['Total TKMS'] || 0) +
                    trucks * weight * distance;
                } catch {
                  // ignore bad payload JSON
                }
              }
            }

            // Prune any raw hauling keys; keep only derived display metrics
            if (t['hauling']) {
              const ALLOWED = new Set([
                'Total Trucks',
                'Total Distance',
                'Total Weight',
                'Total TKMS',
              ]);
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

          res.json({ rows, rollup });
        },
      );
    },
  );
});

export default router;
