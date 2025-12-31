import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../lib/pg.js';
import { siteAdminMiddleware } from '../lib/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

function isManager(req: any) {
  const sites = allowedSites(req);
  if (sites.includes('*')) return true;
  return !!req.site_admin?.can_manage;
}

function assertManager(req: any) {
  if (!isManager(req)) {
    const e: any = new Error('forbidden');
    e.status = 403;
    throw e;
  }
}


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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  try {
    const sites = allowedSites(req);
    let site_rows: Array<{ id: number; name: string; state?: string | null }> = [];
    if (sites.includes('*')) {
      const r = await pool.query(`SELECT id, name, state FROM admin_sites ORDER BY name ASC`);
      site_rows = r.rows || [];
    } else if (sites.length) {
      const r = await pool.query(
        `SELECT id, name, state FROM admin_sites WHERE name = ANY($1::text[]) ORDER BY name ASC`,
        [sites],
      );
      site_rows = r.rows || [];
    }
    return res.json({ ok: true, sites, site_rows, is_super: sites.includes('*'), can_manage: !!req.site_admin?.can_manage });
  } catch {
    const sites = allowedSites(req);
    return res.json({ ok: true, sites, site_rows: [], is_super: sites.includes('*'), can_manage: !!req.site_admin?.can_manage });
  }
});

// List operators for a given site (used by validation "Add Activity" so operator is selectable, not free-typed)
router.get('/site-users', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const r = await pool.query(
      `SELECT id, name, email, site
         FROM users
        WHERE site=$1
        ORDER BY name ASC, email ASC`,
      [site],
    );
    return res.json({ ok: true, users: r.rows || [] });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to load users' });
  }
});
// ---- site admin accounts (legacy: users.is_admin=true) ----
// These endpoints power the "Site Admins" page in the SiteAdmin UI.
// Note: validators/memberships are managed separately via /members/* endpoints.

// List site admin user accounts
router.get('/site-admins', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const sites = allowedSites(req);
    if (sites.includes('*')) {
      const r = await pool.query(
        `SELECT id, name, email, site
           FROM users
          WHERE is_admin=TRUE
          ORDER BY site ASC, name ASC, email ASC`,
      );
      return res.json({ ok: true, admins: r.rows || [] });
    }

    const r = await pool.query(
      `SELECT id, name, email, site
         FROM users
        WHERE is_admin=TRUE AND site = ANY($1)
        ORDER BY site ASC, name ASC, email ASC`,
      [sites],
    );
    return res.json({ ok: true, admins: r.rows || [] });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to load admins' });
  }
});

// Create a new site admin user account
router.post('/create-site-admin', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    if (!name || !email || !password || !site) return res.status(400).json({ ok: false, error: 'Missing fields' });

    // Scope check: non-super admins can only create admins for their scoped site
    assertSiteAccess(req, site);

    const hash = bcrypt.hashSync(password, 10);

    const r = await pool.query(
      `INSERT INTO users (email, password_hash, name, site, is_admin, email_confirmed)
       VALUES ($1,$2,$3,$4,TRUE,TRUE)
       ON CONFLICT (email) DO UPDATE
         SET password_hash=EXCLUDED.password_hash,
             name=EXCLUDED.name,
             site=EXCLUDED.site,
             is_admin=TRUE,
             email_confirmed=TRUE
       RETURNING id, name, email, site`,
      [email, hash, name, site],
    );

    const userId = Number(r.rows?.[0]?.id || 0);

    // Also ensure membership exists for auditing / future role unification.
    if (userId) {
      await pool.query(
        `INSERT INTO site_memberships (user_id, site_id, site_name, role, status, approved_at, approved_by)
         VALUES ($1,(SELECT id FROM admin_sites WHERE name=$2),$2,'admin','active',NOW(),$3)
         ON CONFLICT (user_id, site_id)
         DO UPDATE SET role='admin', status='active', approved_at=NOW(), approved_by=EXCLUDED.approved_by`,
        [userId, site, req.user_id || null],
      );
    }

    return res.json({ ok: true, admin: r.rows?.[0] });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to create admin' });
  }
});

// Delete a site admin user account (and their data)
router.delete('/site-admins', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const id = Number(req.body?.id || 0);
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

    // Load user to enforce scope
    const ur = await pool.query('SELECT id, site, is_admin FROM users WHERE id=$1', [id]);
    const u = ur.rows?.[0];
    if (!u?.id) return res.status(404).json({ ok: false, error: 'not found' });
    if (!u.is_admin) return res.status(400).json({ ok: false, error: 'not a site admin' });

    assertSiteAccess(req, String(u.site));

    await pool.query('BEGIN');
    // Cascade will remove shifts/activities etc due to FK, but be explicit about memberships.
    await pool.query('DELETE FROM site_memberships WHERE user_id=$1', [id]);
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    await pool.query('COMMIT');

    return res.json({ ok: true });
  } catch (e) {
    try {
      await pool.query('ROLLBACK');
    } catch {
      // ignore
    }
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to delete admin' });
  }
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
  } catch (e) {
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
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to update feedback' });
  }
});

// ---- site memberships (members / validators / site admins) ----
// List memberships for a site
router.get('/members', siteAdminMiddleware, async (req: any, res) => {
  try {
    // Validators can view the validate UI; member management should be manager-only.
    assertManager(req);
    const site = String(req.query.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    // NOTE: Avoid UNION + ORDER BY inside compound selects.
    // SQLite is strict about ORDER BY with UNION, and some local/dev setups still use SQLite.
    // We do 2 simple queries and merge/sort in JS (portable across SQLite/Postgres).
    const memberships = await pool.query(
      `SELECT
         m.id,
         m.user_id,
         COALESCE(u.name,'') as name,
         COALESCE(u.email,'') as email,
         s.name as site,
         m.role,
         m.status,
         m.requested_at as requested_at,
         m.approved_at as approved_at
       FROM site_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN admin_sites s ON s.id = m.site_id
       WHERE s.name=$1`,
      [site],
    );

    // Include legacy users who have users.site set but do not yet have a membership row.
    // These should appear as "requested" so the admin can approve/assign roles.
    const legacy = await pool.query(
      `SELECT
         -u.id as id,
         u.id as user_id,
         COALESCE(u.name,'') as name,
         COALESCE(u.email,'') as email,
         $1 as site,
         'member' as role,
         'requested' as status,
         NULL as requested_at,
         NULL as approved_at
       FROM users u
       LEFT JOIN site_memberships m ON m.user_id=u.id AND m.site_id=(SELECT id FROM admin_sites WHERE name=$1)
       WHERE u.site=$1 AND m.id IS NULL`,
      [site],
    );

    const rows = [...(memberships.rows || []), ...(legacy.rows || [])];
    const statusRank = (s: any) => (s === 'requested' || s === 'invited' ? 0 : s === 'active' ? 1 : 2);
    const roleRank = (r: any) => (r === 'admin' ? 0 : r === 'validator' ? 1 : 2);
    rows.sort((a: any, b: any) => {
      const ds = statusRank(a.status) - statusRank(b.status);
      if (ds) return ds;
      const dr = roleRank(a.role) - roleRank(b.role);
      if (dr) return dr;
      const an = String(a.name || '');
      const bn = String(b.name || '');
      const dn = an.localeCompare(bn);
      if (dn) return dn;
      return String(a.email || '').localeCompare(String(b.email || ''));
    });

    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to load members' });
  }
});

// Approve / change role for a membership request
router.post('/members/approve', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const user_id = Number(req.body?.user_id || 0);
    const role = String(req.body?.role || 'member').trim();
    if (!user_id) return res.status(400).json({ ok: false, error: 'missing user_id' });
    if (!['member', 'validator', 'admin'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid role' });
    }

    // Ensure site exists, then resolve site_id
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE name=$1`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    // Guardrail: "invited" memberships must only transition via the user's accept/deny (or revoke).
    // Admins should NOT be able to approve an invited row (that would bypass user acceptance).
    try {
      const cur = await pool.query(
        `SELECT LOWER(COALESCE(status,'')) as status
           FROM site_memberships
          WHERE user_id=$1 AND site_id=$2
          LIMIT 1`,
        [user_id, site_id],
      );
      const curStatus = String(cur.rows?.[0]?.status || '');
      if (curStatus === 'invited') {
        return res.status(400).json({ ok: false, error: 'cannot approve invited membership (awaiting user response)' });
      }
    } catch {
      // If lookup fails, continue; update/insert will still be the source of truth.
    }


    // Update first (works even if there is no UNIQUE constraint for ON CONFLICT)
    const upd = await pool.query(
      `UPDATE site_memberships
          SET role=$3, status='active', approved_at=NOW(), approved_by=$4, site=COALESCE(site,$2), site_name=COALESCE(site_name,$2)
        WHERE user_id=$1 AND site_id=$5`,
      [user_id, site, role, req.user_id || null, site_id],
    );

    if ((upd.rowCount || 0) === 0) {
      await pool.query(
        `INSERT INTO site_memberships (user_id, site_id, site, site_name, role, status, approved_at, approved_by)
         VALUES ($1,$2,$3,$3,$4,'active',NOW(),$5)`,
        [user_id, site_id, site, role, req.user_id || null],
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Search users by name/email for manual add/move
router.get('/members/search', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.query.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, rows: [] });
    const like = `%${q.toLowerCase()}%`;

    // Resolve site_id (create if missing)
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE name=$1`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    const r = await pool.query(
      `SELECT u.id, COALESCE(u.name,'') as name, COALESCE(u.email,'') as email
         FROM users u
        WHERE (LOWER(COALESCE(u.name,'')) LIKE $1 OR LOWER(COALESCE(u.email,'')) LIKE $1)
          AND NOT EXISTS (
            SELECT 1
              FROM site_memberships m
             WHERE m.user_id=u.id
               AND m.site_id=$2
               AND m.status='active'
          )
        ORDER BY COALESCE(u.name,''), COALESCE(u.email,'')
        LIMIT 20`,
      [like, site_id],
    );
    return res.json({ ok: true, rows: r.rows || [] });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

router.post('/members/add', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);

    const user_id_raw = Number(req.body?.user_id || 0);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'member').trim();

    if (!['member', 'validator', 'admin'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid role' });
    }

    let user_id = user_id_raw;
    if (!user_id) {
      if (!email) return res.status(400).json({ ok: false, error: 'missing user' });
      const ur = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
      user_id = Number(ur.rows?.[0]?.id || 0);
    }

    if (!user_id) return res.status(404).json({ ok: false, error: 'user not found' });

    // Manual add is now an INVITE that requires the user to accept.
    // We avoid ON CONFLICT here so it also works on older DBs that don't yet have a unique constraint.
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE name=$1`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    const upd = await pool.query(
      `UPDATE site_memberships
          SET role=$3,
              status='invited',
              requested_at=NOW(),
              approved_at=NULL,
              approved_by=NULL,
              site=COALESCE(site,$2),
              site_name=COALESCE(site_name,$2)
        WHERE user_id=$1 AND site_id=$4 AND status <> 'active'`,
      [user_id, site, role, site_id],
    );
    if ((upd.rowCount || 0) === 0) {
      await pool.query(
        `INSERT INTO site_memberships (user_id, site_id, site, site_name, role, status, requested_at)
         VALUES ($1,$2,$3,$3,$4,'invited',NOW())`,
        [user_id, site_id, site, role],
      );
    }

    return res.json({ ok: true, user_id });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

router.post('/members/revoke', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    const user_id = Number(req.body?.user_id);
    if (!user_id) return res.status(400).json({ ok: false, error: 'missing user_id' });
    await pool.query(
      `UPDATE site_memberships
          SET status='revoked'
        WHERE user_id=$1 AND site_id=(SELECT id FROM admin_sites WHERE name=$2)`,
      [user_id, site],
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
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
  const loads = Array.isArray((p as any).loads) ? (p as any).loads : null;
  const trucks = loads ? loads.length : n((p.values || {})['Trucks']);
  const dist = n((p.values || {})['Distance']);
  const totalW = loads
    ? loads.reduce((acc: number, l: any) => acc + n(l?.weight ?? l?.Weight), 0)
    : trucks * n((p.values || {})['Weight']);

  // Weight is stored as total tonnes (sum of loads)
  totals[activity][subActivity]['Weight'] =
    (totals[activity][subActivity]['Weight'] || 0) + totalW;
  // Distance is stored as sum of distance per load (trucks × distance)
  totals[activity][subActivity]['Distance'] =
    (totals[activity][subActivity]['Distance'] || 0) + trucks * dist;
  // Trucks count
  totals[activity][subActivity]['Trucks'] =
    (totals[activity][subActivity]['Trucks'] || 0) + trucks;
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
  const loads = Array.isArray((p as any).loads) ? (p as any).loads : null;
  const trucks = loads ? loads.length : n((p.values || {})['Trucks']);
  const dist = n((p.values || {})['Distance']);
  const totalW = loads
    ? loads.reduce((acc: number, l: any) => acc + n(l?.weight ?? l?.Weight), 0)
    : trucks * n((p.values || {})['Weight']);
  const tkms = totalW * dist;
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

  // Super-admins can see all official sites (admin_sites).
  // Fallback to shifts-derived sites if admin_sites is empty (older DBs).
  if (tokenSites.includes('*')) {
    const r = await pool.query(`SELECT name AS site FROM admin_sites WHERE name IS NOT NULL AND TRIM(name) <> '' ORDER BY name ASC`);
    const sites = (r.rows || []).map((x: any) => String(x.site || '').trim()).filter(Boolean);
    if (sites.length) return res.json({ sites });

    const rr = await pool.query(
      `SELECT DISTINCT site as site FROM shifts WHERE site IS NOT NULL AND site != '' ORDER BY site`,
    );
    return res.json({ sites: (rr.rows || []).map((x: any) => x.site).filter(Boolean) });
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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



// --- Validation layer: add / delete activities & create shifts ---
// These endpoints are the ONLY way validated data changes once a shift/day is validated.
// We intentionally avoid relying on UNIQUE/ON CONFLICT so this works against older local DBs too.

async function markValidatedDayUnvalidated(client: any, site: string, date: string, ctx: string) {
  try {
    // If table doesn't exist yet, skip (keeps app usable for old DBs)
    await client.query(
      `CREATE TABLE IF NOT EXISTS validated_days (
        site TEXT NOT NULL,
        date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'unvalidated',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (site, date)
      )`,
    );

    const u = await client.query(
      `UPDATE validated_days
          SET status='unvalidated', updated_at=NOW()
        WHERE site=$1 AND date=$2::date`,
      [site, date],
    );
    if ((u.rowCount || 0) === 0) {
      await client.query(
        `INSERT INTO validated_days (site, date, status) VALUES ($1,$2::date,'unvalidated')`,
        [site, date],
      );
    }
  } catch (e: any) {
    console.error(`validated_days mark unvalidated failed (${ctx})`, e?.message || e);
  }
}

// Create an empty validated shift row (used when operator did not upload)
router.post('/validated/create-shift', siteAdminMiddleware, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const site = String(req.body?.site || '').trim();
    const date = String(req.body?.date || '').trim();
    const dn = String(req.body?.dn || '').trim() || 'DS';
    const user_email = String(req.body?.user_email || '').trim();

    if (!site || !date || !dn || !user_email) return res.status(400).json({ ok: false, error: 'missing fields' });
    assertSiteAccess(req, site);

    // Friendly name (optional)
    let user_name = '';
    try {
      const ur = await client.query(`SELECT name FROM users WHERE email=$1 LIMIT 1`, [user_email]);
      user_name = String(ur.rows?.[0]?.name || '').trim();
    } catch {
      // ignore
    }
    if (!user_name) user_name = user_email;

    await client.query('BEGIN');

    // Ensure shift row exists without ON CONFLICT
    const ex = await client.query(
      `SELECT 1 FROM validated_shifts
        WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
        LIMIT 1`,
      [site, date, dn, user_email],
    );

    if ((ex.rowCount || 0) === 0) {
      await client.query(
        `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
         VALUES ($1,$2::date,$3,COALESCE($4,''),$5,0,'{}'::jsonb)`,
        [site, date, dn, user_email, user_name],
      );
    }

    await markValidatedDayUnvalidated(client, site, date, 'create-shift');

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('validated/create-shift failed', {
      message: e?.message,
      detail: e?.detail,
      where: e?.where,
      code: e?.code,
      stack: e?.stack,
    });
    try {
      await client.query('ROLLBACK');
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  } finally {
    client.release();
  }
});

// Add a validated activity row and recompute totals for that validated shift
router.post('/validated/add-activity', siteAdminMiddleware, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const site = String(req.body?.site || '').trim();
    const date = String(req.body?.date || '').trim();
    const dn = String(req.body?.dn || '').trim() || 'DS';
    const user_email = String(req.body?.user_email || '').trim();
    const activity = String(req.body?.activity || '').trim();
    const sub_activity = String(req.body?.sub_activity || '').trim();
    const payload_json = req.body?.payload_json;

    if (!site || !date || !dn || !user_email || !activity) return res.status(400).json({ ok: false, error: 'missing fields' });
    assertSiteAccess(req, site);

    let user_name = '';
    try {
      const ur = await client.query(`SELECT name FROM users WHERE email=$1 LIMIT 1`, [user_email]);
      user_name = String(ur.rows?.[0]?.name || '').trim();
    } catch {}
    if (!user_name) user_name = user_email;

    await client.query('BEGIN');

    // Ensure validated_shifts exists (same as create-shift)
    const ex = await client.query(
      `SELECT 1 FROM validated_shifts
        WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
        LIMIT 1`,
      [site, date, dn, user_email],
    );
    if ((ex.rowCount || 0) === 0) {
      await client.query(
        `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
         VALUES ($1,$2::date,$3,COALESCE($4,''),$5,0,'{}'::jsonb)`,
        [site, date, dn, user_email, user_name],
      );
    }

    await client.query(
      `INSERT INTO validated_shift_activities (site, date, dn, user_email, user_name, activity, sub_activity, payload_json)
       VALUES ($1,$2::date,$3,COALESCE($4,''),$5,$6,$7,$8::jsonb)`,
      [site, date, dn, user_email, user_name, activity, sub_activity, JSON.stringify(payload_json || {})],
    );

    // Recompute totals for this validated shift only
    const rr = await client.query(
  `SELECT payload_json
     FROM validated_shift_activities
    WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
    ORDER BY id ASC`,
  [site, date, dn, user_email],
);
const payloads = (rr.rows || []).map((x: any) => x.payload_json);
const totals = computeTotalsBySubFromPayloads(payloads);

const up = await client.query(
  `UPDATE validated_shifts
      SET totals_json=$5::jsonb, validated=0
    WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
  [site, date, dn, user_email, JSON.stringify(totals)],
);
if ((up.rowCount || 0) === 0) {
  await client.query(
    `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
     VALUES ($1,$2::date,$3,COALESCE($4,''),$5,0,$6::jsonb)`,
    [site, date, dn, user_email, user_name, JSON.stringify(totals)],
  );
}

await markValidatedDayUnvalidated(client, site, date, 'add-activity');

await client.query('COMMIT');
return res.json({ ok: true, totals });

  } catch (e: any) {
    console.error('validated/add-activity failed', {
      message: e?.message,
      detail: e?.detail,
      where: e?.where,
      code: e?.code,
      stack: e?.stack,
    });
    try {
      await client.query('ROLLBACK');
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  } finally {
    client.release();
  }
});

// Delete a validated activity row by id
router.post('/validated/delete-activity', siteAdminMiddleware, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const site = String(req.body?.site || '').trim();
    const date = String(req.body?.date || '').trim();
    const id = Number(req.body?.id || 0);

    if (!site || !date || !id) return res.status(400).json({ ok: false, error: 'missing fields' });
    assertSiteAccess(req, site);

    await client.query('BEGIN');

    const r = await client.query(
      `SELECT dn, COALESCE(user_email,'') AS user_email
         FROM validated_shift_activities
        WHERE id=$1 AND site=$2 AND date=$3::date
        LIMIT 1`,
      [id, site, date],
    );
    if (!r.rows?.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not found' });
    }
    const dn = String(r.rows[0].dn || '');
    const user_email = String(r.rows[0].user_email || '');

    const del = await client.query(
      `DELETE FROM validated_shift_activities
        WHERE id=$1 AND site=$2 AND date=$3::date`,
      [id, site, date],
    );
    if (!del.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    // Recompute totals after deletion
    const rr = await client.query(
      `SELECT payload_json
         FROM validated_shift_activities
        WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
        ORDER BY id ASC`,
      [site, date, dn, user_email],
    );
    const payloads = (rr.rows || []).map((x: any) => x.payload_json);
    const totals = computeTotalsBySubFromPayloads(payloads);

    // Update shift totals (no ON CONFLICT)
    const up = await client.query(
      `UPDATE validated_shifts
          SET totals_json=$5::jsonb, validated=0
        WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
      [site, date, dn, user_email, JSON.stringify(totals)],
    );
    if ((up.rowCount || 0) === 0) {
      await client.query(
        `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
         VALUES ($1,$2::date,$3,COALESCE($4,''),$5,0,$6::jsonb)`,
        [site, date, dn, user_email, user_email, JSON.stringify(totals)],
      );
    }

    await markValidatedDayUnvalidated(client, site, date, 'delete-activity');

    await client.query('COMMIT');
    return res.json({ ok: true, totals });
  } catch (e: any) {
    console.error('validated/delete-activity failed', {
      message: e?.message,
      detail: e?.detail,
      where: e?.where,
      code: e?.code,
      stack: e?.stack,
    });
    try {
      await client.query('ROLLBACK');
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  } finally {
    client.release();
  }
});

// Delete an entire validated shift (and all its activities) - only via validation page
router.post('/validated/delete-shift', siteAdminMiddleware, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const site = String(req.body?.site || '').trim();
    const date = String(req.body?.date || '').trim();
    const dn = String(req.body?.dn || '').trim();
    const user_email = String(req.body?.user_email || '').trim();

    if (!site || !date || !dn) return res.status(400).json({ ok: false, error: 'missing fields' });
    assertSiteAccess(req, site);

    await client.query('BEGIN');
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

    await markValidatedDayUnvalidated(client, site, date, 'delete-shift');

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('validated/delete-shift failed', {
      message: e?.message,
      detail: e?.detail,
      where: e?.where,
      code: e?.code,
      stack: e?.stack,
    });
    try {
      await client.query('ROLLBACK');
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
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