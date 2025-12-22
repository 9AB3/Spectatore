import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

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

  try {
    const valErr = await validateActivities(user_id, activities);
    if (valErr) return res.status(400).json({ error: valErr });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ✅ get user's profile info for not-null constraints, filtering, and denormalized columns
      const site = await getUserSite(client, user_id);
      const user_email = await getUserEmail(client, user_id);
      const user_name = await getUserName(client, user_id);

      // Upsert shift row (INCLUDES site)
      const up = await client.query(
        `INSERT INTO shifts (user_id, user_email, user_name, site, date, dn, totals_json, finalized_at)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7::jsonb,NOW())
         ON CONFLICT (user_id, date, dn)
         DO UPDATE SET
           user_email = EXCLUDED.user_email,
           user_name = EXCLUDED.user_name,
           site = EXCLUDED.site,
           totals_json = EXCLUDED.totals_json,
           finalized_at = NOW()
         RETURNING id`,
        [user_id, user_email, user_name, site, date, dn, JSON.stringify(totals || {})],
      );

      const shift_id = up.rows[0].id;

      // Replace activities for that shift
      await client.query('DELETE FROM shift_activities WHERE shift_id=$1', [shift_id]);

      for (const it of activities as any[]) {
        const p = it?.payload || {};
        const activity = String(p.activity || '');
        const sub = String(p.sub || '');

        // ✅ store site so admin/site filtering is easy
        await client.query(
          `INSERT INTO shift_activities (shift_id, user_email, user_name, site, activity, sub_activity, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [shift_id, user_email, user_name, site, activity, sub, JSON.stringify(p)],
        );
      }

      // --- mirror finalized data into validation layer (default validated=0) ---

      // Replace any prior validated rows for this user/date/dn (latest finalized snapshot wins)
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
        const activity = String(it?.activity || '');
        const sub = String(it?.sub_activity || '');
        const p = it?.payload || {};
        await client.query(
          `INSERT INTO validated_shift_activities (site, date, dn, user_email, user_name, activity, sub_activity, payload_json)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::jsonb)`,
          [site, date, dn, user_email, user_name, activity, sub, JSON.stringify(p)],
        );
      }

      await client.query('COMMIT');
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
