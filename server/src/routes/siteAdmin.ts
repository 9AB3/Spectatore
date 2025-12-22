import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../lib/pg.js';
import { siteAdminMiddleware } from '../lib/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';


// ---- admin sites management ----
router.get('/admin-sites', siteAdminMiddleware, async (_req, res) => {
  try {
    const req: any = _req as any;
    const sites = allowedSites(req);
    if (sites.includes('*')) {
      const r = await pool.query('SELECT id, name, state FROM admin_sites ORDER BY name ASC');
      return res.json({ ok: true, sites: r.rows });
    }

    // Regular site-admin users only see their own site(s)
    const r = await pool.query(
      'SELECT id, name, state FROM admin_sites WHERE name = ANY($1) ORDER BY name ASC',
      [sites],
    );
    // If for some reason the admin_sites table doesn't contain the user's site yet,
    // still return the token-scoped site(s) so the UI can show the correct (locked) value.
    if (!r.rows || r.rows.length === 0) {
      const fallback = (sites || []).filter((x) => x && x !== '*').map((name, i) => ({ id: -(i + 1), name, state: null }));
      return res.json({ ok: true, sites: fallback });
    }
    return res.json({ ok: true, sites: r.rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to load admin sites' });
  }
});

router.post('/admin-sites', siteAdminMiddleware, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const state = String(req.body?.state || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Site name is required' });
  try {
    // Only the super-admin (Admin/Password token) can create/update sites
    const sites = allowedSites(req);
    if (!sites.includes('*')) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const r = await pool.query(
      `INSERT INTO admin_sites(name, state) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET state = EXCLUDED.state
       RETURNING id, name, state`,
      [name, state || null],
    );
    res.json({ ok: true, site: r.rows[0] });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to create site' });
  }
});

// Delete a site (super-admin only)
// - If force=true: deletes per-site admin master lists and shift data for that site,
//   and moves any users currently on that site back to 'default'.
// - If force not set: returns 409 with counts if the site has any users/shifts.
router.delete('/admin-sites', siteAdminMiddleware, async (req: any, res) => {
  const name = String(req.body?.name || '').trim();
  const force = !!req.body?.force;
  if (!name) return res.status(400).json({ ok: false, error: 'Missing site name' });

  try {
    const sites = allowedSites(req);
    if (!sites.includes('*')) return res.status(403).json({ ok: false, error: 'forbidden' });

    const usersR = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE site=$1', [name]);
    const shiftsR = await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE site=$1', [name]);
    const usersN = usersR.rows?.[0]?.n || 0;
    const shiftsN = shiftsR.rows?.[0]?.n || 0;

    if (!force && (usersN > 0 || shiftsN > 0)) {
      return res.status(409).json({
        ok: false,
        error: 'site_in_use',
        users: usersN,
        shifts: shiftsN,
      });
    }

    await pool.query('BEGIN');
    // Remove per-site master lists
    await pool.query('DELETE FROM admin_equipment WHERE site=$1', [name]);
    await pool.query('DELETE FROM admin_locations WHERE site=$1', [name]);

    // Remove shift data for the site (shift_activities cascades via FK)
    await pool.query('DELETE FROM shifts WHERE site=$1', [name]);

    // Move any users from the deleted site back to default
    await pool.query("UPDATE users SET site='default' WHERE site=$1", [name]);

    // Finally remove from admin_sites
    await pool.query('DELETE FROM admin_sites WHERE name=$1', [name]);
    await pool.query('COMMIT');

    return res.json({ ok: true });
  } catch (e: any) {
    try {
      await pool.query('ROLLBACK');
    } catch {
      // ignore
    }
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to delete site' });
  }
});

// Convenience endpoint for the SiteAdmin UI to understand current scope
router.get('/me', siteAdminMiddleware, async (req: any, res) => {
  const sites = allowedSites(req);
  return res.json({ ok: true, sites, is_super: sites.includes('*') });
});

// ---- feedback moderation (super-admin only) ----
router.get('/feedback/pending', siteAdminMiddleware, async (req: any, res) => {
  try {
    const sites = allowedSites(req);
    if (!sites.includes('*')) return res.status(403).json({ ok: false, error: 'forbidden' });

    const r = await pool.query(
      `SELECT id, message, user_name, user_email, site, created_at::text as created_at
       FROM user_feedback
       WHERE approved=FALSE AND declined=FALSE
       ORDER BY created_at ASC`,
    );
    return res.json({ ok: true, rows: r.rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to load feedback' });
  }
});

router.post('/feedback/decision', siteAdminMiddleware, async (req: any, res) => {
  const id = Number(req.body?.id || 0);
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!id || (decision !== 'approve' && decision !== 'decline')) {
    return res.status(400).json({ ok: false, error: 'Invalid request' });
  }

  try {
    const sites = allowedSites(req);
    if (!sites.includes('*')) return res.status(403).json({ ok: false, error: 'forbidden' });

    const approve = decision === 'approve';
    await pool.query(
      `UPDATE user_feedback
       SET approved=$2, declined=$3, reviewed_by=$4, reviewed_at=now()
       WHERE id=$1 AND approved=FALSE AND declined=FALSE`,
      [id, approve, !approve, req.site_admin?.username || 'Super Admin'],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to update feedback' });
  }
});

router.post('/create-site-admin', siteAdminMiddleware, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const siteInput = String(req.body?.site || '').trim();

  if (!email || !password || !name) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    const sites = allowedSites(req as any);
    const isSuper = sites.includes('*');

    // Super-admin can assign any site; regular admins can only assign within their site
    const site = isSuper ? siteInput : (sites[0] || '');
    if (!site) return res.status(400).json({ ok: false, error: 'Missing site' });

    // Ensure site exists in admin_sites (and fetch state)
    // NOTE: state may legitimately be NULL (optional), so do NOT treat NULL state as non-existent.
    const s = await pool.query('SELECT state FROM admin_sites WHERE name = $1', [site]);
    const state = s.rows?.[0]?.state ?? null;
    if ((s.rowCount || 0) === 0 && !isSuper) {
      // If a regular admin has a site set but it isn't in admin_sites, block creation
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const hash = await bcrypt.hash(password, 10);

    // Create user as site admin (is_admin = true, email_confirmed = true)
    const ins = await pool.query(
      `INSERT INTO users(email, password_hash, name, site, state, email_confirmed, confirm_code, is_admin)
       VALUES ($1,$2,$3,$4,$5,TRUE,NULL,TRUE)
       RETURNING id, email, name, site, is_admin`,
      [email, hash, name, site, state],
    );
    res.json({ ok: true, user: ins.rows[0] });
  } catch (e: any) {
    // unique violation (email)
    const msg = String(e?.message || '');
    if (msg.includes('users_email_key') || msg.toLowerCase().includes('duplicate')) {
      return res.status(409).json({ ok: false, error: 'Email already exists' });
    }
    res.status(500).json({ ok: false, error: e?.message || 'Failed to create site admin' });
  }
});

// ---- site admins management (list + delete) ----
router.get('/site-admins', siteAdminMiddleware, async (req: any, res) => {
  try {
    const sites = allowedSites(req);
    let q = `SELECT id, name, email, site FROM users WHERE is_admin=TRUE ORDER BY site, name`;
    const params: any[] = [];
    if (!sites.includes('*')) {
      q = `SELECT id, name, email, site FROM users WHERE is_admin=TRUE AND site = ANY($1) ORDER BY site, name`;
      params.push(sites);
    }
    const r = await pool.query(q, params);
    res.json({ ok: true, admins: r.rows || [] });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to load admins' });
  }
});

router.delete('/site-admins', siteAdminMiddleware, async (req: any, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Missing id' });

    const sites = allowedSites(req);
    if (!sites.includes('*')) {
      const r = await pool.query('SELECT site FROM users WHERE id=$1 AND is_admin=TRUE', [id]);
      const site = r.rows?.[0]?.site;
      if (!site || !sites.includes(String(site))) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
    }

    await pool.query('DELETE FROM users WHERE id=$1 AND is_admin=TRUE', [id]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to delete admin' });
  }
});


function hashDaySnapshot(input: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// ---- totals recompute helpers (server-side, authoritative) ----
function n(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Mirrors client FinalizeShift.tsx totalsBySub logic.
function computeTotalsBySubFromPayloads(payloads: any[]) {
  const totals: Record<string, Record<string, Record<string, number>>> = {};
  for (const p0 of payloads) {
    const p: any = p0 || {};
    const activity = p.activity || '(No Activity)';
    const subActivity = p.sub || p.sub_activity || '(No Sub Activity)';
    totals[activity] ||= {};
    totals[activity][subActivity] ||= {};

    for (const [k, v] of Object.entries(p.values || {})) {
      const key = String(k || '');
      // For Hauling, Weight/Distance totals should be weighted by trucks (trucks × value).
      // We'll handle those after the loop and skip raw accumulation here.
      if (activity === 'Hauling' && (key === 'Weight' || key === 'Distance')) continue;

      const num = typeof v === 'number' ? v : parseFloat(String(v));
      if (!Number.isNaN(num)) {
        totals[activity][subActivity][key] = (totals[activity][subActivity][key] || 0) + num;
      }
    }

    // For Hauling, accumulate weighted totals for Weight and Distance.
    if (activity === 'Hauling') {
      const trucks = n((p.values || {})['Trucks']);
      const wt = n((p.values || {})['Weight']);
      const dist = n((p.values || {})['Distance']);
      totals[activity][subActivity]['Weight'] =
        (totals[activity][subActivity]['Weight'] || 0) + trucks * wt;
      totals[activity][subActivity]['Distance'] =
        (totals[activity][subActivity]['Distance'] || 0) + trucks * dist;
    }

    // Derived metrics (keep consistent with client)
    if (activity === 'Development' && subActivity === 'Face Drilling') {
      const holes = n((p.values || {})['No of Holes']);
      const cut = n((p.values || {})['Cut Length']);
      const devDrillm = holes * cut;
      totals[activity][subActivity]['Dev Drillm'] =
        (totals[activity][subActivity]['Dev Drillm'] || 0) + devDrillm;
    }
    if (activity === 'Development' && (subActivity === 'Ground Support' || subActivity === 'Rehab')) {
      const bolts = n((p.values || {})['No. of Bolts']);
      const blRaw = String((p.values || {})['Bolt Length'] ?? '').replace('m', '');
      const bl = n(blRaw);
      const gsDrillm = bolts * bl;
      totals[activity][subActivity]['GS Drillm'] =
        (totals[activity][subActivity]['GS Drillm'] || 0) + gsDrillm;
    }
    if (activity === 'Hauling' && (subActivity === 'Production' || subActivity === 'Development')) {
      const wt = n((p.values || {})['Weight']);
      const dist = n((p.values || {})['Distance']);
      const trucks = n((p.values || {})['Trucks']);
      const tkms = wt * dist * trucks;
      totals[activity][subActivity]['TKMs'] = (totals[activity][subActivity]['TKMs'] || 0) + tkms;
    }
  }
  return totals;
}

async function recomputeShiftTotals(client: any, shift_id: number) {
  const r = await client.query(
    `SELECT payload_json FROM shift_activities WHERE shift_id=$1 ORDER BY id ASC`,
    [shift_id],
  );
  const payloads = r.rows.map((x: any) => x.payload_json);
  const totals = computeTotalsBySubFromPayloads(payloads);
  await client.query(`UPDATE shifts SET totals_json=$2::jsonb WHERE id=$1`, [shift_id, JSON.stringify(totals)]);
  return totals;
}

function allowedSites(req: any): string[] {
  return req.site_admin?.sites || ['*'];
}

function normalizeSiteParam(req: any): string {
  const tokenSites = allowedSites(req);
  const q = String(req.query.site || req.body.site || '').trim();
  if (q) return q;
  if (tokenSites.length === 1 && tokenSites[0] !== '*') return tokenSites[0];
  return '*';
}

function assertSiteAccess(req: any, site: string) {
  const tokenSites = allowedSites(req);
  if (tokenSites.includes('*')) return;
  if (!tokenSites.includes(site)) {
    const err: any = new Error('forbidden');
    err.status = 403;
    throw err;
  }
}

async function loadDaySnapshot(site: string, date: string) {
  const params: any[] = [date];
  let siteJoin = '';
  if (site !== '*') {
    siteJoin = ' AND s.site = $2 ';
    params.push(site);
  }

  const shiftsR = await pool.query(
    `
    SELECT
      s.id as shift_id,
      s.user_id,
      u.name as user_name,
      u.email as user_email,
      s.site as site,
      s.date::text as date,
      s.dn,
      s.totals_json,
      s.finalized_at
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    WHERE s.date = $1::date ${siteJoin}
    ORDER BY s.site, s.dn, u.name, s.user_id
  `,
    params,
  );

  const actsR = await pool.query(
    `
    SELECT
      a.id,
      a.shift_id,
      s.user_id,
      u.email as user_email,
      s.site as site,
      s.dn,
      a.activity,
      a.sub_activity,
      a.payload_json
    FROM shift_activities a
    JOIN shifts s ON s.id = a.shift_id
    JOIN users u ON u.id = s.user_id
    WHERE s.date = $1::date ${siteJoin}
    ORDER BY a.activity, a.sub_activity, a.id
  `,
    params,
  );

  const shifts = shiftsR.rows || [];
  const activities = actsR.rows || [];

  const snapshot = {
    site,
    date,
    shifts: shifts.map((r: any) => ({
      shift_id: r.shift_id,
      user_id: r.user_id,
      user_name: r.user_name,
      user_email: r.user_email,
      dn: r.dn,
      finalized_at: r.finalized_at,
    })),
    activities: activities.map((r: any) => ({
      id: r.id,
      shift_id: r.shift_id,
      user_id: r.user_id,
      user_name: r.user_name,
      user_email: r.user_email,
      dn: r.dn,
      activity: r.activity,
      sub_activity: r.sub_activity,
      payload_json: r.payload_json,
    })),
  };
  const source_hash = hashDaySnapshot(snapshot);
  return { shifts, activities, source_hash };
}

// --- AUTH ---
router.post('/login', async (req, res) => {
  // Supports:
  // 1) Super-admin legacy login: Admin / Password
  // 2) Regular is_admin users: email + password (returns a normal auth-style token)
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  // Super-admin
  if (username === 'Admin' && password === 'Password') {
    const payload = { type: 'site_admin', username, sites: ['*'] };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, username, sites: payload.sites, super_admin: true });
  }

  // Regular site-admin user (must exist in users table, is_admin=true)
  try {
    const email = username.toLowerCase();
    const r = await pool.query(
      'SELECT id, email, name, site, password_hash, is_admin, email_confirmed FROM users WHERE email=$1',
      [email],
    );
    const u = r.rows?.[0];
    if (!u || !u.is_admin) return res.status(401).json({ error: 'invalid credentials' });
    if (!u.email_confirmed) return res.status(403).json({ error: 'EMAIL_NOT_CONFIRMED' });
    const ok = bcrypt.compareSync(String(password), String(u.password_hash || ''));
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    const payload = { id: u.id, email: u.email, is_admin: true };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, username: u.name || u.email, sites: [String(u.site || '')].filter(Boolean), super_admin: false });
  } catch (e) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
});

// --- META ---
router.get('/sites', siteAdminMiddleware, async (req: any, res) => {
  const tokenSites = allowedSites(req);
  if (tokenSites.includes('*')) {
    const r = await pool.query(
      `SELECT DISTINCT site as site FROM shifts WHERE site IS NOT NULL AND site != '' ORDER BY site`,
    );
    return res.json({ sites: r.rows.map((x) => x.site).filter(Boolean) });
  }
  return res.json({ sites: tokenSites });
});

// --- ADMIN MASTER LISTS (per-site) ---
router.get('/admin-equipment', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const r = await pool.query(
      `SELECT id, site, type, equipment_id
         FROM admin_equipment
        WHERE site=$1
        ORDER BY type, equipment_id`,
      [site],
    );
    return res.json({ rows: r.rows || [] });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.post('/admin-equipment', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const type = String(req.body?.type || '').trim();
    const equipment_id = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!site || !type || !equipment_id) return res.status(400).json({ error: 'missing site, type or equipment_id' });
    await pool.query(
      `INSERT INTO admin_equipment (site, type, equipment_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (site, equipment_id) DO NOTHING`,
      [site, type, equipment_id],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.delete('/admin-equipment', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const equipment_id = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!site || !equipment_id) return res.status(400).json({ error: 'missing site or equipment_id' });
    await pool.query(`DELETE FROM admin_equipment WHERE site=$1 AND equipment_id=$2`, [site, equipment_id]);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.get('/admin-locations', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const r = await pool.query(
      `SELECT id, site, name, type
         FROM admin_locations
        WHERE site=$1
        ORDER BY type, name`,
      [site],
    );
    return res.json({ rows: r.rows || [] });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.post('/admin-locations', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const name = String(req.body?.name || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!site || !name) return res.status(400).json({ error: 'missing site or name' });
    await pool.query(
      `INSERT INTO admin_locations (site, name, type)
       VALUES ($1,$2,$3)
       ON CONFLICT (site, name) DO NOTHING`,
      [site, name, type || null],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.delete('/admin-locations', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const name = String(req.body?.name || '').trim();
    if (!site || !name) return res.status(400).json({ error: 'missing site or name' });
    await pool.query(`DELETE FROM admin_locations WHERE site=$1 AND name=$2`, [site, name]);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

// --- CALENDAR STATUS ---
router.get('/calendar', siteAdminMiddleware, async (req: any, res) => {
  const year = parseInt(String(req.query.year || ''), 10) || new Date().getFullYear();
  const site = normalizeSiteParam(req);
  assertSiteAccess(req, site);

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  // We base calendar status purely on validated_shifts.validated flags:
  // - green if at least 1 validated_shifts row exists AND all rows for that (site,date) are validated=1
  // - red if at least 1 validated_shifts row exists AND any row is validated=0
  // - none if no validated_shifts rows exist (even if shifts exist)
  const out: any[] = [];

  if (site === '*') {
    // For '*', return status per date across all sites:
    // green if all sites with rows that date are fully validated, red otherwise.
    const datesR = await pool.query(
      `SELECT DISTINCT date::text AS date
         FROM validated_shifts
        WHERE date >= $1::date AND date <= $2::date
        ORDER BY date ASC`,
      [from, to],
    );

    for (const row of datesR.rows) {
      const d = String(row.date);

      const agg = await pool.query(
        `SELECT site,
                MIN(validated) AS minv,
                MAX(validated) AS maxv
           FROM validated_shifts
          WHERE date=$1::date
          GROUP BY site`,
        [d],
      );

      if (!agg.rows.length) {
        out.push({ date: d, status: 'none' });
        continue;
      }

      let allGreen = true;
      for (const r of agg.rows) {
        const minv = Number(r.minv ?? 0);
        const maxv = Number(r.maxv ?? 0);
        if (!(minv === 1 && maxv === 1)) {
          allGreen = false;
          break;
        }
      }
      out.push({ date: d, status: allGreen ? 'green' : 'red' });
    }

    return res.json({ year, site, days: out });
  }

  const agg = await pool.query(
    `SELECT date::text AS date,
            MIN(validated) AS minv,
            MAX(validated) AS maxv
       FROM validated_shifts
      WHERE site=$1 AND date >= $2::date AND date <= $3::date
      GROUP BY date
      ORDER BY date ASC`,
    [site, from, to],
  );

  for (const r of agg.rows) {
    const d = String(r.date);
    const minv = Number(r.minv ?? 0);
    const maxv = Number(r.maxv ?? 0);
    const status = minv === 1 && maxv === 1 ? 'green' : 'red';
    out.push({ date: d, status });
  }

  return res.json({ year, site, days: out });
});

router.get('/day', siteAdminMiddleware, async (req: any, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }

  const site = normalizeSiteParam(req);
  assertSiteAccess(req, site);

  // Live snapshot (from shifts/shift_activities) — your helper already supports site='*'
  const { shifts, activities, source_hash } = await loadDaySnapshot(site, date);

  // Validation-layer rows (created automatically on finalize)
  // IMPORTANT:
  //  - qualify columns using aliases (vs.site, vs.date, etc.)
  //  - if site === '*', do NOT filter by site
  let validated_shifts: any[] = [];
  let validated_activities: any[] = [];

  if (site === '*') {
    const vShifts = await pool.query(
      `SELECT
          vs.id,
          vs.site,
          vs.date::text as date,
          vs.dn,
          vs.user_email,
          COALESCE(u.name,'') as user_name,
          vs.validated,
          vs.totals_json
        FROM validated_shifts vs
        LEFT JOIN users u ON u.email = vs.user_email
        WHERE vs.date = $1::date
        ORDER BY vs.site, vs.dn, vs.user_email, vs.id`,
      [date],
    );
    validated_shifts = vShifts.rows || [];

    const vActs = await pool.query(
      `SELECT
          vsa.id,
          vsa.site,
          vsa.date::text as date,
          vsa.dn,
          vsa.user_email,
          vsa.activity,
          vsa.sub_activity,
          vsa.payload_json
        FROM validated_shift_activities vsa
        WHERE vsa.date = $1::date
        ORDER BY vsa.site, vsa.activity, vsa.sub_activity, vsa.id`,
      [date],
    );
    validated_activities = vActs.rows || [];
  } else {
    const vShifts = await pool.query(
      `SELECT
          vs.id,
          vs.site,
          vs.date::text as date,
          vs.dn,
          vs.user_email,
          COALESCE(u.name,'') as user_name,
          vs.validated,
          vs.totals_json
        FROM validated_shifts vs
        LEFT JOIN users u ON u.email = vs.user_email
        WHERE vs.site = $1
          AND vs.date = $2::date
        ORDER BY vs.dn, vs.user_email, vs.id`,
      [site, date],
    );
    validated_shifts = vShifts.rows || [];

    const vActs = await pool.query(
      `SELECT
          vsa.id,
          vsa.site,
          vsa.date::text as date,
          vsa.dn,
          vsa.user_email,
          vsa.activity,
          vsa.sub_activity,
          vsa.payload_json
        FROM validated_shift_activities vsa
        WHERE vsa.site = $1
          AND vsa.date = $2::date
        ORDER BY vsa.activity, vsa.sub_activity, vsa.id`,
      [site, date],
    );
    validated_activities = vActs.rows || [];
  }

  // Day status:
  // - green if all validated_shifts rows have validated=1
  // - red if any validated_shifts row has validated=0
  // - none if no validated_shifts rows exist
  let status: any = 'none';
  if (validated_shifts.length) {
    const minv = Math.min(...validated_shifts.map((r: any) => Number(r.validated ?? 0)));
    const maxv = Math.max(...validated_shifts.map((r: any) => Number(r.validated ?? 0)));
    status = minv === 1 && maxv === 1 ? 'green' : 'red';
  }

  return res.json({
    date,
    site,
    status,
    source_hash,
    shifts,
    activities,
    validated_shifts,
    validated_activities,
  });
});



// --- VALIDATE ---
// --- UPDATE VALIDATED (edits only; does NOT set validated=1) ---
router.post('/update-validated', siteAdminMiddleware, async (req: any, res) => {
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });

  const site = String(req.body.site || '').trim() || '*';
  assertSiteAccess(req, site);

  const edits = Array.isArray(req.body.edits) ? req.body.edits : []; // [{ id, payload_json }]
  if (!edits.length) return res.json({ ok: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Apply edits to validated_shift_activities rows (only within this site/date)
    for (const e of edits) {
      const id = Number(e?.id);
      if (!id) continue;
      const payload_json = e?.payload_json ?? {};
      await client.query(
        `UPDATE validated_shift_activities
            SET payload_json=$3::jsonb
          WHERE id=$1 AND site=$2 AND date=$4::date`,
        [id, site, JSON.stringify(payload_json), date],
      );
    }

    // Any edit makes the day require re-validation again
    await client.query(
      `UPDATE validated_shifts
          SET validated=0
        WHERE site=$1 AND date=$2::date`,
      [site, date],
    );


    // Recompute validated_shifts.totals_json from validated_shift_activities so both layers stay in sync
    const vs = await client.query(
      `SELECT dn, user_email
         FROM validated_shifts
        WHERE site=$1 AND date=$2::date
        ORDER BY dn, user_email`,
      [site, date],
    );
    for (const row of vs.rows || []) {
      const dn = String(row.dn || '');
      const user_email = String(row.user_email || '');
      const actsR = await client.query(
        `SELECT payload_json
           FROM validated_shift_activities
          WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          ORDER BY id ASC`,
        [site, date, dn, user_email],
      );
      const payloads = (actsR.rows || []).map((x: any) => x.payload_json);
      const totals = computeTotalsBySubFromPayloads(payloads);
      await client.query(
        `UPDATE validated_shifts
            SET totals_json=$5::jsonb
          WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [site, date, dn, user_email, JSON.stringify(totals)],
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('update-validated failed', err);
    return res.status(500).json({ error: 'update-validated failed' });
  } finally {
    client.release();
  }
});

// --- VALIDATE (flag only) ---
router.post('/validate', siteAdminMiddleware, async (req: any, res) => {
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });

  const site = String(req.body.site || '').trim() || '*';
  assertSiteAccess(req, site);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (site === '*') {
      await client.query(`UPDATE validated_shifts SET validated=1 WHERE date=$1::date`, [date]);
    } else {
      await client.query(`UPDATE validated_shifts SET validated=1 WHERE site=$1 AND date=$2::date`, [site, date]);
    }


    // Recompute validated_shifts.totals_json from validated_shift_activities so both layers stay in sync
    const vs = await client.query(
      `SELECT dn, user_email
         FROM validated_shifts
        WHERE site=$1 AND date=$2::date
        ORDER BY dn, user_email`,
      [site, date],
    );
    for (const row of vs.rows || []) {
      const dn = String(row.dn || '');
      const user_email = String(row.user_email || '');
      const actsR = await client.query(
        `SELECT payload_json
           FROM validated_shift_activities
          WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          ORDER BY id ASC`,
        [site, date, dn, user_email],
      );
      const payloads = (actsR.rows || []).map((x: any) => x.payload_json);
      const totals = computeTotalsBySubFromPayloads(payloads);
      await client.query(
        `UPDATE validated_shifts
            SET totals_json=$5::jsonb
          WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [site, date, dn, user_email, JSON.stringify(totals)],
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true, site, date });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('validate failed', err);
    return res.status(500).json({ error: 'validate failed' });
  } finally {
    client.release();
  }
});



export default router;