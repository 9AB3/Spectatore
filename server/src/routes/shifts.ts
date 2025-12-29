import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { notify } from '../lib/notify.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// Limited set of metrics used for milestone notifications (must match reports.ts)
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

function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function asObj(v: any) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

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
        out[k] = (out[k] || 0) + n(subObj[k]);
      }
    }
  }
  return out;
}

// Compute only the milestone metrics for a single shift.
// Prefer activity payloads if provided, otherwise fall back to totals_json.
function computeMilestoneMetricMapForShift(
  shiftRow: any,
  acts: Array<{ activity: string; sub_activity: string; payload_json: any }> | undefined,
): Record<string, number> {
  const out: any = {};
  for (const m of MILESTONE_METRICS as any) out[m] = 0;

  if (!acts || acts.length === 0) {
    const flat = flattenTotalsToMetricMap(shiftRow?.totals_json);
    out['GS Drillm'] = n(flat['GS Drillm'] || 0);
    out['Face Drillm'] = n(flat['Face Drillm'] || flat['Dev Drillm'] || 0);
    out['Headings supported'] = n(flat['Headings supported'] || 0);
    out['Headings bored'] = n(flat['Headings bored'] || 0);
    out['Truck Loads'] = n(flat['Trucks'] || 0);
    out["TKM's"] = n(flat['TKMs'] || 0);
    out['Tonnes Hauled'] = n(flat['Total Weight'] || flat['Weight'] || 0);
    out['Production drillm'] = n(flat['Metres Drilled'] || 0) + n(flat['Cleanouts Drilled'] || 0) + n(flat['Redrills'] || 0);
    out['Primary Production buckets'] = n(flat['Stope to Truck'] || 0) + n(flat['Stope to SP'] || 0);
    out['Primary Development buckets'] = n(flat['Heading to Truck'] || 0) + n(flat['Heading to SP'] || 0);
    out['Tonnes charged'] = n(flat['Charge kg'] || 0) / 1000;
    out['Headings Fired'] = n(flat['Headings Fired'] || 0);
    out['Tonnes Fired'] = n(flat['Tonnes Fired'] || 0);
    out['Ore tonnes hoisted'] = n(flat['Ore Tonnes'] || 0);
    out['Waste tonnes hoisted'] = n(flat['Waste Tonnes'] || 0);
    out['Total tonnes hoisted'] = n(out['Ore tonnes hoisted']) + n(out['Waste tonnes hoisted']);
    return out;
  }

  // With payloads: some metrics are already stored as final totals, so we can still use totals_json for many.
  // For now, use the same fallback derived from totals_json (keeps behavior stable) and allow payload-driven
  // totals_json to remain the source of truth.
  return computeMilestoneMetricMapForShift(shiftRow, undefined);
}


/**
 * Authoritative equipment → activity mapping
 * (MUST mirror frontend mapping)
 */
const EQUIPMENT_ACTIVITY_MAP: Record<string, string[]> = {
  Truck: ['Hauling'],
  Loader: ['Loading'],
  Jumbo: ['Development'],
  'Production Drill': ['Production Drilling'],
  'Spray Rig': ['Development'],
  Agi: ['Development'],
  'Charge Rig': ['Charging'],
};

function isYmd(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function getUserSite(client: any, user_id: number): Promise<string> {
  const r = await client.query('SELECT site FROM users WHERE id=$1', [user_id]);
  const site = String(r.rows?.[0]?.site || '').trim();
  return site || 'default';
}

async function getUserEmail(client: any, user_id: number): Promise<string> {
  const r = await client.query('SELECT email FROM users WHERE id=$1', [user_id]);
  const email = String(r.rows?.[0]?.email || '').trim();
  return email || '';
}

async function getUserName(client: any, user_id: number): Promise<string> {
  const r = await client.query('SELECT name FROM users WHERE id=$1', [user_id]);
  const name = String(r.rows?.[0]?.name || '').trim();
  return name || '';
}

// GET /api/shifts/dates-with-data
router.get('/dates-with-data', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'missing user' });

  try {
    const r = await pool.query(
      'SELECT DISTINCT date::text AS date FROM shifts WHERE user_id=$1 ORDER BY date ASC',
      [user_id],
    );
    res.json({ dates: r.rows.map((x) => x.date) });
  } catch (err) {
    console.error('dates-with-data failed', err);
    res.status(500).json({ error: 'db failed' });
  }
});

// GET /api/shifts/dates-with-finalized
router.get('/dates-with-finalized', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'missing user' });

  try {
    const r = await pool.query(
      'SELECT DISTINCT date::text AS date FROM shifts WHERE user_id=$1 AND finalized_at IS NOT NULL ORDER BY date ASC',
      [user_id],
    );
    res.json({ dates: r.rows.map((x) => x.date) });
  } catch (err) {
    console.error('dates-with-finalized failed', err);
    res.status(500).json({ error: 'db failed' });
  }
});

// POST /api/shifts/delete-finalized
router.post('/delete-finalized', authMiddleware, async (req: any, res: any) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'missing user' });

  let dates: any = req.body?.dates;
  if (!Array.isArray(dates)) dates = [];
  dates = dates
    .map((d: any) => String(d || '').trim())
    .filter((d: string) => isYmd(d));

  if (dates.length === 0) return res.json({ ok: true, deleted: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Identify finalized shift ids that match these dates
    const r = await client.query(
      `SELECT id FROM shifts
        WHERE user_id=$1 AND finalized_at IS NOT NULL AND date = ANY($2::date[])`,
      [user_id, dates],
    );
    const ids = r.rows.map((x) => x.id);

    if (ids.length === 0) {
      // Nothing to delete — do not reference undefined vars here.
      await client.query('COMMIT');
      return res.json({ ok: true, deleted: 0 });
    }

    // Optional: also delete the corresponding validated snapshot rows for those dates
    // (only if your product logic wants delete-finalized to wipe validation copies too)
    try {
      const site = await getUserSite(client, user_id);
      const user_email = await getUserEmail(client, user_id);

      // dn is not provided to delete-finalized, so remove both DS + NS for the date list.
      await client.query(
        `DELETE FROM validated_shift_activities
          WHERE site=$1
            AND COALESCE(user_email,'')=COALESCE($2,'')
            AND date = ANY($3::date[])
            AND dn IN ('DS','NS')`,
        [site, user_email, dates],
      );

      await client.query(
        `DELETE FROM validated_shifts
          WHERE site=$1
            AND COALESCE(user_email,'')=COALESCE($2,'')
            AND date = ANY($3::date[])
            AND dn IN ('DS','NS')`,
        [site, user_email, dates],
      );
    } catch (e) {
      // Don't fail the delete if validation layer isn't present / schema differs
      console.warn('delete-finalized: validated layer cleanup skipped/failed', e);
    }

    // shift_activities cascade via FK, but be explicit just in case
    await client.query('DELETE FROM shift_activities WHERE shift_id = ANY($1::bigint[])', [ids]);
    await client.query('DELETE FROM shifts WHERE id = ANY($1::bigint[])', [ids]);

    await client.query('COMMIT');
    return res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('delete-finalized failed', err);
    return res.status(500).json({ error: 'db failed' });
  } finally {
    client.release();
  }
});

async function validateActivities(user_id: number, activities: any[]): Promise<string | null> {
  const equipmentIds = new Set<string>();

  for (const it of activities) {
    const values = it?.payload?.values || {};
    const eq = values?.Equipment || values?.equipment || values?.['Equipment ID'];
    if (eq) {
      const norm = String(eq).trim().toUpperCase();
      if (norm) equipmentIds.add(norm);
    }
  }

  if (equipmentIds.size === 0) return null;

  const ids = Array.from(equipmentIds);
  const r = await pool.query(
    `SELECT equipment_id, type
       FROM equipment
      WHERE user_id=$1 AND equipment_id = ANY($2::text[])`,
    [user_id, ids],
  );

  const typeByEquip: Record<string, string> = {};
  for (const row of r.rows) typeByEquip[String(row.equipment_id).toUpperCase()] = row.type;

  for (const it of activities) {
    const p = it?.payload || {};
    const activity = p.activity;
    const values = p.values || {};
    const eqRaw = values?.Equipment || values?.equipment || values?.['Equipment ID'];
    const eq = eqRaw ? String(eqRaw).trim().toUpperCase() : '';
    if (!eq) continue;

    const eqType = typeByEquip[eq];
    if (!eqType) continue; // allow unknown equipment values

    const allowed = EQUIPMENT_ACTIVITY_MAP[eqType]?.includes(activity);
    if (!allowed) return `Equipment "${eqType}" not allowed for activity "${activity}"`;
  }

  return null;
}

// POST /api/shifts/finalize
router.post('/finalize', authMiddleware, async (req: any, res: any) => {
  const user_id = req.user_id;
  const date = String(req.body?.date || '').trim();
  const dn = String(req.body?.dn || '').trim();
  const totals = req.body?.totals || {};
  const activities = req.body?.activities;

  if (!user_id) return res.status(401).json({ error: 'missing user' });
  if (!date || !dn) return res.status(400).json({ error: 'missing date or dn' });
  if (!isYmd(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (!Array.isArray(activities)) return res.status(400).json({ error: 'activities must be an array' });

  // Normalise activity payloads to the canonical shape we persist in Postgres.
  function normaliseItem(it: any) {
    const rawP = it?.payload ?? it ?? {};
    const activity = String(rawP.activity ?? rawP.payload?.activity ?? '').trim();
    const sub = String(rawP.sub ?? rawP.sub_activity ?? rawP.payload?.sub ?? '').trim() || '(No Sub Activity)';

    let values: any = rawP.values ?? rawP.payload?.values ?? rawP.payload_json?.values;
    if (!values || typeof values !== 'object') {
      const v: any = {};
      for (const [k, v0] of Object.entries(rawP)) {
        if (k === 'activity' || k === 'sub' || k === 'sub_activity' || k === 'values' || k === 'payload') continue;
        v[k] = v0 as any;
      }
      values = v;
    }

    // Ensure important meta fields are kept (forms rely on these).
    for (const k of ['Source', 'Location', 'From', 'To', 'Material', 'Equipment']) {
      if (rawP?.[k] != null && values?.[k] == null) values[k] = rawP[k];
    }

    return { activity, sub, values };
  }

  try {
    const valErr = await validateActivities(user_id, activities);
    if (valErr) return res.status(400).json({ error: valErr });


function buildMetaJson(items: any[]) {
  const meta: any = {};
  const add = (act: string, sub: string, key: string, val: any) => {
    if (val == null) return;
    const s = String(val).trim();
    if (!s || s === '-') return;
    if (!meta[act]) meta[act] = {};
    if (!meta[act][sub]) meta[act][sub] = {};
    if (!meta[act][sub][key]) meta[act][sub][key] = [];
    if (!meta[act][sub][key].includes(s)) meta[act][sub][key].push(s);
  };

  for (const it of items || []) {
    const p = normaliseItem(it);
    if (!p?.activity) continue;
    const act = p.activity;
    const sub = p.sub || '(No Sub Activity)';
    const v = p.values || {};
    add(act, sub, 'Sources', v.Source ?? v.source);
    add(act, sub, 'Locations', v.Location ?? v.location);
    add(act, sub, 'From', v.From ?? v.from);
    add(act, sub, 'To', v.To ?? v.to);
    add(act, sub, 'Materials', v.Material ?? v.material);
    add(act, sub, 'Equipment', v.Equipment ?? v.equipment ?? v.equipment_id);
  }
  return meta;
}


    const meta_json = buildMetaJson(activities);


    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Denormalised user info for filtering + display
      const site = await getUserSite(client, user_id);
      const user_email = await getUserEmail(client, user_id);
      const user_name = await getUserName(client, user_id);

      // Upsert the shift row and mark finalized
      const up = await client.query(
        `INSERT INTO shifts (user_id, site, date, dn, totals_json, meta_json, finalized_at, user_email, user_name)
         VALUES ($1,$2,$3::date,$4,$5::jsonb,$6::jsonb,NOW(),$7,$8)
         ON CONFLICT (user_id, date, dn)
         DO UPDATE SET site=EXCLUDED.site,
                       totals_json=EXCLUDED.totals_json,
                       meta_json=EXCLUDED.meta_json,
                       finalized_at=NOW(),
                       user_email=EXCLUDED.user_email,
                       user_name=EXCLUDED.user_name
         RETURNING id`,
        [user_id, site, date, dn, JSON.stringify(totals || {}), JSON.stringify(meta_json || {}), user_email, user_name],
      );
      const shift_id = up.rows?.[0]?.id;
      if (!shift_id) throw new Error('shift upsert failed');

      // Replace activities snapshot for this shift
      await client.query('DELETE FROM shift_activities WHERE shift_id=$1', [shift_id]);

      for (const it of activities) {
        const p = normaliseItem(it);
        if (!p.activity) continue;

        await client.query(
          `INSERT INTO shift_activities (shift_id, user_email, user_name, site, activity, sub_activity, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [shift_id, user_email, user_name, site, p.activity, p.sub, JSON.stringify(p)],
        );
      }

      // Mirror the finalized snapshot into validation layer (unvalidated by default).
      // (validated_* tables are keyed by site/date/dn/user_email in this project.)
      await client.query(
        `DELETE FROM validated_shift_activities
         WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [site, date, dn, user_email],
      );
      await client.query(
        `DELETE FROM validated_shifts
         WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [site, date, dn, user_email],
      );

      await client.query(
        `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
         VALUES ($1,$2::date,$3,$4,$5,0,$6::jsonb)`,
        [site, date, dn, user_email, user_name, JSON.stringify(totals || {})],
      );

      for (const it of activities) {
        const p = normaliseItem(it);
        if (!p.activity) continue;

        await client.query(
          `INSERT INTO validated_shift_activities (site, date, dn, user_email, user_name, activity, sub_activity, payload_json)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::jsonb)`,
          [site, date, dn, user_email, user_name, p.activity, p.sub, JSON.stringify(p)],
        );
      }

      await client.query('COMMIT');

      // --- Notifications (best-effort; do not fail finalize) ---
      try {
        const actorId = Number(user_id);
        const actorName = user_name || 'A crew mate';
        const metricMap = computeMilestoneMetricMapForShift({ totals_json: totals || {} }, activities as any);

        // Find accepted connections
        const cr = await pool.query(
          `SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END as other_id
             FROM connections
            WHERE (requester_id=$1 OR addressee_id=$1) AND status='accepted'`,
          [actorId],
        );
        const others = (cr.rows || []).map((r: any) => Number(r.other_id)).filter((x: any) => Number.isFinite(x) && x > 0);

        // Build list of exceeded milestones per other user, then notify (cap to avoid spam)
        for (const otherId of others) {
          // Compute recipient bests over last 365 days using totals_json only
          const sr = await pool.query(
            `SELECT date::text as date, totals_json
               FROM shifts
              WHERE user_id=$1 AND date >= (CURRENT_DATE - INTERVAL '365 days')`,
            [otherId],
          );

          const best: Record<string, number> = {};
          for (const m of MILESTONE_METRICS as any) best[m] = 0;
          for (const row of sr.rows || []) {
            const mm = computeMilestoneMetricMapForShift({ totals_json: asObj(row.totals_json) }, undefined);
            for (const m of MILESTONE_METRICS as any) {
              const v = n(mm[m] || 0);
              if (v > best[m]) best[m] = v;
            }
          }

          const exceeded: Array<{ metric: string; value: number; diff: number }> = [];
          for (const m of MILESTONE_METRICS as any) {
            const v = n(metricMap[m] || 0);
            if (v > 0 && v > (best[m] || 0)) exceeded.push({ metric: m, value: v, diff: v - (best[m] || 0) });
          }
          exceeded.sort((a, b) => b.diff - a.diff);
          const top = exceeded.slice(0, 4);
          for (const ex of top) {
            await notify(
              otherId,
              'milestone_broken',
              'Milestone broken',
              `${actorName} just beat your personal best for ${ex.metric}: ${ex.value.toFixed(1)} on ${date}.`,
              { actor_id: actorId, actor_name: actorName, metric: ex.metric, value: ex.value, date },
              `/YouVsNetwork?metric=${encodeURIComponent(String(ex.metric))}`,
            );
          }
        }
      } catch (e) {
        console.warn('finalize notifications skipped', e);
      }

      return res.json({ ok: true, shift_id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('finalize failed', err);
      return res.status(500).json({ error: 'db failed' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('finalize failed (outer)', err);
    return res.status(500).json({ error: 'db failed' });
  }
});


export default router;
