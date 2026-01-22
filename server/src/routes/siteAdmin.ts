import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../lib/pg.js';
import { siteAdminMiddleware } from '../lib/auth.js';

async function hasLegacySiteColumn(pool: any) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'site_memberships'
      AND column_name = 'site'
    LIMIT 1
  `;
  const r = await pool.query(q);
  return r.rowCount > 0;
}
const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// ---- schema helpers (support older DB variants) ----
// Some local/dev DBs still use the legacy `site_memberships.site` column (sometimes NOT NULL).
// If we insert/update memberships without also setting `site`, Postgres will throw:
//   null value in column "site" of relation "site_memberships" violates not-null constraint
let _colsCache: Record<string, Set<string>> = {};

async function tableColumns(table: string): Promise<Set<string>> {
  if (_colsCache[table]) return _colsCache[table];
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1`,
    [table],
  );
  const set = new Set<string>((r.rows || []).map((x: any) => String(x.column_name)));
  _colsCache[table] = set;
  return set;
}

function normWorkSiteName(s: any): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  const cols = await tableColumns(table);
  return cols.has(col);
}

function makePowerBiToken() {
  // Short, URL-safe token.
  const rand = crypto.randomBytes(18).toString('base64url');
  const year = new Date().getFullYear();
  return `spectatore-powerbi-${year}-${rand}`;
}

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

// Super-admin only (legacy: users.is_admin=true).
// In siteAdminMiddleware this maps to req.site_admin.sites = ['*'].
function assertSuperAdmin(req: any) {
  const sites = allowedSites(req);
  if (!sites.includes('*')) {
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

// -----------------------------
// Power BI site tokens (per-site)
// -----------------------------
// Site-admin managers can create and revoke tokens for their allowed sites.

router.get('/powerbi-tokens', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const site = normalizeSiteParam(req);
    if (site !== '*') assertSiteAccess(req, site);

    const params: any[] = [];
    let where = 'WHERE revoked_at IS NULL';
    if (site !== '*') {
      params.push(site);
      where += ` AND site = $${params.length}`;
    }

    const r = await pool.query(
      `
      SELECT id, site, label, token, created_at, revoked_at
      FROM powerbi_site_tokens
      ${where}
      ORDER BY site ASC, created_at DESC, id DESC
      `,
      params,
    );

    return res.json({ ok: true, site: site === '*' ? null : site, tokens: r.rows || [] });
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || 'Failed to load tokens' });
  }
});

router.post('/powerbi-tokens', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    const label = String(req.body?.label || '').trim() || null;
    if (!site || site === '*') {
      return res.status(400).json({ ok: false, error: 'Site is required' });
    }
    assertSiteAccess(req, site);

    // Generate a unique token (retry a couple times on the unlikely chance of collision)
    let token = makePowerBiToken();
    for (let i = 0; i < 3; i++) {
      try {
        const r = await pool.query(
          `
          INSERT INTO powerbi_site_tokens(site, label, token, created_by_user_id)
          VALUES ($1, $2, $3, $4)
          RETURNING id, site, label, token, created_at, revoked_at
          `,
          [site, label, token, req.site_admin?.user_id || null],
        );
        return res.json({ ok: true, token: r.rows?.[0] });
      } catch (e: any) {
        // Unique violation
        if (String(e?.code || '') === '23505') {
          token = makePowerBiToken();
          continue;
        }
        throw e;
      }
    }

    return res.status(500).json({ ok: false, error: 'Failed to generate unique token' });
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || 'Failed to create token' });
  }
});

router.post('/powerbi-tokens/:id/revoke', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

    // Ensure the token belongs to a site the requester can manage
    const r0 = await pool.query('SELECT id, site FROM powerbi_site_tokens WHERE id=$1', [id]);
    const row = r0.rows?.[0];
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    assertSiteAccess(req, String(row.site));

    await pool.query('UPDATE powerbi_site_tokens SET revoked_at = now() WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || 'Failed to revoke token' });
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
    try {
      const siteRow = r.rows?.[0];
      const siteId = Number(siteRow?.id || 0);
      const siteName = String(siteRow?.name || name).trim();
      if (siteId && siteName) {
        const normalized = normWorkSiteName(siteName);
        // Ensure the Work Sites directory contains this Subscribed Site as an official Work Site.
        await pool.query(
          `INSERT INTO work_sites (name_display, name_normalized, is_official, official_site_id)
           VALUES ($1, $2, true, $3)
           ON CONFLICT (name_normalized)
           DO UPDATE SET name_display = EXCLUDED.name_display,
                         is_official = true,
                         official_site_id = EXCLUDED.official_site_id`,
          [siteName, normalized, siteId],
        );
      }
    } catch {
      // non-fatal (older DBs may not have work_sites yet)
    }

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

    const sr = await pool.query('SELECT id, name FROM admin_sites WHERE name=$1 LIMIT 1', [name]);
    const site_id = Number(sr.rows?.[0]?.id || 0);
    if (!site_id) return res.status(404).json({ ok: false, error: 'site_not_found' });
    const usersR = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE COALESCE(primary_admin_site_id, primary_site_id)=$1', [site_id]);
    const shiftsR = await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE admin_site_id=$1', [site_id]);
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
    await pool.query('DELETE FROM admin_equipment WHERE admin_site_id=$1', [site_id]);
    await pool.query('DELETE FROM admin_locations WHERE admin_site_id=$1', [site_id]);

    // Remove shift data for the site (shift_activities cascades via FK)
    await pool.query('DELETE FROM shifts WHERE admin_site_id=$1', [site_id]);

    // Move any users from the deleted site back to default
    await pool.query('UPDATE users SET primary_admin_site_id=NULL, primary_site_id=NULL WHERE COALESCE(primary_admin_site_id, primary_site_id)=$1', [site_id]);

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


// --- DASHBOARD SUMMARY ---
// Provides site-scoped, admin-relevant counts for the Site Admin home dashboard.
router.get('/dashboard-summary', siteAdminMiddleware, async (req: any, res) => {
  const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
  if (!site || site === '*') return res.status(400).json({ ok: false, error: 'site required' });

  try {
    assertSiteAccess(req, site);

    const monthYmRaw = String(req.query?.month_ym || '').trim();
    const now = new Date();
    const monthYm = /^\d{4}-\d{2}$/.test(monthYmRaw)
      ? monthYmRaw
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [yyS, mmS] = monthYm.split('-');
    const yy = Number(yyS);
    const mm = Number(mmS);
    const startDate = new Date(Date.UTC(yy, mm - 1, 1));
    const nextMonth = new Date(Date.UTC(yy, mm, 1));
    const start = startDate.toISOString().slice(0, 10);
    const end = nextMonth.toISOString().slice(0, 10);

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'site not found' });

      const shiftsAgg = await client.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN validated THEN 1 ELSE 0 END)::int AS validated
           FROM validated_shifts
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date`,
        [adminSiteId, start, end],
      );
      const total = Number(shiftsAgg.rows?.[0]?.total || 0);
      const validated = Number(shiftsAgg.rows?.[0]?.validated || 0);
      const unvalidated = Math.max(0, total - validated);

      const pendingDaysQ = await client.query(
        `SELECT COUNT(*)::int AS pending_days
           FROM (
             SELECT date, BOOL_AND(validated) AS all_valid
               FROM validated_shifts
              WHERE admin_site_id=$1
                AND date >= $2::date AND date < $3::date
              GROUP BY date
           ) t
          WHERE t.all_valid=FALSE`,
        [adminSiteId, start, end],
      );
      const pending_days = Number(pendingDaysQ.rows?.[0]?.pending_days || 0);

      // Days with data vs days fully validated (used for dashboard fractions)
      const daysAgg = await client.query(
        `SELECT COUNT(*)::int AS with_data,
                SUM(CASE WHEN all_valid THEN 1 ELSE 0 END)::int AS validated_days
           FROM (
             SELECT date, BOOL_AND(validated) AS all_valid
               FROM validated_shifts
              WHERE admin_site_id=$1
                AND date >= $2::date AND date < $3::date
              GROUP BY date
           ) t`,
        [adminSiteId, start, end],
      );
      const days_with_data = Number(daysAgg.rows?.[0]?.with_data || 0);
      const days_validated = Number(daysAgg.rows?.[0]?.validated_days || 0);

      const crewQ = await client.query(
        `SELECT COUNT(DISTINCT user_email)::int AS active_users,
                MAX(date)::text AS last_shift_date
           FROM validated_shifts
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date`,
        [adminSiteId, start, end],
      );
      const active_users = Number(crewQ.rows?.[0]?.active_users || 0);
      const last_shift_date = crewQ.rows?.[0]?.last_shift_date || null;

      return res.json({
        ok: true,
        site,
        month_ym: monthYm,
        pending_days,
        days: { with_data: days_with_data, validated: days_validated },
        shifts: { total, validated, unvalidated },
        crew: { active_users, last_shift_date },
      });
    } finally {
      client.release();
    }
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// List operators for a given site (used by validation "Add Activity" so operator is selectable, not free-typed)
router.get('/site-users', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.json({ ok: true, users: [] });

    // NOTE: users table stores membership to a subscribed Site Admin tenant via
    // primary_admin_site_id / primary_site_id (legacy compatibility).
    // Some older seeded DBs may still only have users.site populated.
    const r = await pool.query(
      `SELECT id, name, email, site
         FROM users
        WHERE COALESCE(primary_admin_site_id, primary_site_id)=$1
           OR site=$2
        ORDER BY name ASC, email ASC`,
      [siteId, site],
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });
    const admin_site_id = await resolveAdminSiteId(pool, site);
    if (!admin_site_id) return res.status(400).json({ error: 'unknown site' });

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
       WHERE s.name=$1
         AND LOWER(COALESCE(m.status,'')) <> 'declined'`,
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
       LEFT JOIN site_memberships m ON m.user_id=u.id AND m.site_id=(SELECT id FROM admin_sites WHERE lower(name)=lower($1))
       WHERE u.site=$1
         AND m.id IS NULL
         AND u.id NOT IN (
           SELECT user_id FROM site_memberships
            WHERE site_id=(SELECT id FROM admin_sites WHERE lower(name)=lower($1))
              AND LOWER(COALESCE(status,''))='declined'
         )`,
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

    const user_id = Number(req.body?.user_id || 0);
    const role = String(req.body?.role || 'member').trim();
    if (!user_id) return res.status(400).json({ ok: false, error: 'missing user_id' });
    if (!['member', 'validator', 'admin'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid role' });
    }

    // Ensure site exists, then resolve site_id
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE lower(name)=lower($1)`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    const hasLegacySiteCol = await hasLegacySiteColumn(pool);

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
    const updSql = hasLegacySiteCol
      ? `UPDATE site_memberships
          SET role=$3,
              status='active',
              approved_at=NOW(),
              approved_by=$4,
              site_name=COALESCE(site_name,$2),
              site=COALESCE(site,$2)
        WHERE user_id=$1 AND site_id=$5`
      : `UPDATE site_memberships
          SET role=$3,
              status='active',
              approved_at=NOW(),
              approved_by=$4,
              site_name=COALESCE(site_name,$2)
        WHERE user_id=$1 AND site_id=$5`;

    const upd = await pool.query(updSql, [user_id, site, role, req.user_id || null, site_id]);

    if ((upd.rowCount || 0) === 0) {
      if (hasLegacySiteCol) {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, site, role, status, approved_at, approved_by)
           VALUES ($1,$2,$3,$3,$4,'active',NOW(),$5)`,
          [user_id, site_id, site, role, req.user_id || null],
        );
      } else {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, role, status, approved_at, approved_by)
           VALUES ($1,$2,$3,$4,'active',NOW(),$5)`,
          [user_id, site_id, site, role, req.user_id || null],
        );
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Decline a membership request so it disappears from the pending list.
// This is only for admin-side declination of a user's "requested" access.
router.post('/members/decline', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const user_id = Number(req.body?.user_id || 0);
    if (!user_id) return res.status(400).json({ ok: false, error: 'missing user_id' });

    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE lower(name)=lower($1)`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    // If there's an existing membership row, mark it declined. Otherwise, create a declined row
    // so legacy "users.site" requests don't keep re-appearing.
    const hasLegacySiteCol = await hasLegacySiteColumn(pool);
    const upd = await pool.query(
      `UPDATE site_memberships
          SET status='declined'
        WHERE user_id=$1 AND site_id=$2 AND LOWER(COALESCE(status,'')) IN ('requested','')`,
      [user_id, site_id],
    );
    if ((upd.rowCount || 0) === 0) {
      if (hasLegacySiteCol) {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, site, role, status, requested_at)
           VALUES ($1,$2,$3,$3,'member','declined',NOW())
           ON CONFLICT DO NOTHING`,
          [user_id, site_id, site],
        );
      } else {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, role, status, requested_at)
           VALUES ($1,$2,$3,'member','declined',NOW())
           ON CONFLICT DO NOTHING`,
          [user_id, site_id, site],
        );
      }
    }

    // For legacy users where users.site was used as the request source, clear it so it doesn't keep showing.
    try {
      await pool.query(`UPDATE users SET site='default' WHERE id=$1 AND site=$2`, [user_id, site]);
    } catch {
      // ignore
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });
    const admin_site_id = await resolveAdminSiteId(pool, site);
    if (!admin_site_id) return res.status(400).json({ error: 'unknown site' });

    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, rows: [] });
    const like = `%${q.toLowerCase()}%`;

    // Resolve site_id (create if missing)
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE lower(name)=lower($1)`, [site]);
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });
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
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE lower(name)=lower($1)`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    const hasLegacySiteCol = await hasLegacySiteColumn(pool);

    const updSql = hasLegacySiteCol
      ? `UPDATE site_memberships
          SET role=$3,
              status='invited',
              requested_at=NOW(),
              approved_at=NULL,
              approved_by=NULL,
              site_name=COALESCE(site_name,$2),
              site=COALESCE(site,$2)
        WHERE user_id=$1 AND site_id=$4 AND status <> 'active'`
      : `UPDATE site_memberships
          SET role=$3,
              status='invited',
              requested_at=NOW(),
              approved_at=NULL,
              approved_by=NULL,
              site_name=COALESCE(site_name,$2)
        WHERE user_id=$1 AND site_id=$4 AND status <> 'active'`;

    const upd = await pool.query(updSql, [user_id, site, role, site_id]);
    if ((upd.rowCount || 0) === 0) {
      if (hasLegacySiteCol) {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, site, role, status, requested_at)
           VALUES ($1,$2,$3,$3,$4,'invited',NOW())`,
          [user_id, site_id, site, role],
        );
      } else {
        await pool.query(
          `INSERT INTO site_memberships (user_id, site_id, site_name, role, status, requested_at)
           VALUES ($1,$2,$3,$4,'invited',NOW())`,
          [user_id, site_id, site, role],
        );
      }
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });
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


async function resolveAdminSiteId(client: any, raw: any): Promise<number | null> {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  try {
    // Prefer the canonical column (admin_sites.name). Some older DBs used admin_sites.site.
    // We try name first, then fall back to site if needed.
    const r1 = await client.query('SELECT id FROM admin_sites WHERE lower(name)=lower($1)', [s]);
    const id1 = Number(r1.rows?.[0]?.id);
    if (Number.isFinite(id1) && id1 > 0) return id1;

    // Fallback for older schemas
    try {
      const r2 = await client.query('SELECT id FROM admin_sites WHERE lower(site)=lower($1)', [s]);
      const id2 = Number(r2.rows?.[0]?.id);
      return Number.isFinite(id2) && id2 > 0 ? id2 : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
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
    const siteId = await resolveAdminSiteId(pool as any, site);
    // If the caller passed an unknown site name, return an empty snapshot (prevents 500s)
    if (!siteId) return { shifts: [], activities: [], source_hash: '0' };
    siteJoin = ' AND s.admin_site_id = $2 ';
    params.push(siteId);
  }

  const shiftsR = await pool.query(
    `
    SELECT
      s.id as shift_id,
      s.user_id,
      u.name as user_name,
      u.email as user_email,
      COALESCE(asite.name, '') as site,
      s.date::text as date,
      s.dn,
      s.totals_json,
      s.finalized_at
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN admin_sites asite ON asite.id = s.admin_site_id
    WHERE s.date = $1::date ${siteJoin}
    ORDER BY COALESCE(asite.name,''), s.dn, u.name, s.user_id
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
      COALESCE(asite.name, '') as site,
      s.dn,
      a.activity,
      a.sub_activity,
      a.payload_json
    FROM shift_activities a
    JOIN shifts s ON s.id = a.shift_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN admin_sites asite ON asite.id = s.admin_site_id
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

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ rows: [] });
    // NOTE: admin_equipment does not have a "site" column. Join admin_sites to return a stable site label.
    const r = await pool.query(
      `SELECT e.id,
              COALESCE(s.name, '') AS site,
              e.type,
              e.equipment_id
         FROM admin_equipment e
         JOIN admin_sites s ON s.id = e.admin_site_id
        WHERE e.admin_site_id = $1
        ORDER BY e.type, e.equipment_id`,
      [siteId],
    );
    return res.json({ rows: r.rows || [] });
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

// True edit endpoint (supports renaming equipment_id)
router.patch('/admin-equipment/:id', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });

    const id = Number(req.params?.id);
    const type = String(req.body?.type || '').trim();
    const equipment_id = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!id || !type || !equipment_id) return res.status(400).json({ error: 'missing id, type or equipment_id' });

    const r = await pool.query(
      `UPDATE admin_equipment
          SET type=$1,
              equipment_id=$2
        WHERE id=$3 AND admin_site_id=$4
        RETURNING id`,
      [type, equipment_id, id, siteId],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, id: r.rows[0]?.id || id });
  } catch (e: any) {
    if (String(e?.code) === '23505') return res.status(409).json({ error: 'equipment_id already exists' });
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.post('/admin-equipment', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });
    const type = String(req.body?.type || '').trim();
    const equipment_id = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!site || !type || !equipment_id) return res.status(400).json({ error: 'missing site, type or equipment_id' });
    await pool.query(
      `INSERT INTO admin_equipment (admin_site_id, type, equipment_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (admin_site_id, equipment_id) DO NOTHING`,
      [siteId, type, equipment_id],
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

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });
    const equipment_id = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!site || !equipment_id) return res.status(400).json({ error: 'missing site or equipment_id' });
    await pool.query(`DELETE FROM admin_equipment WHERE admin_site_id=$1 AND equipment_id=$2`, [siteId, equipment_id]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.get('/admin-locations', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ rows: [] });
    // NOTE: admin_locations does not have a "site" column. Join admin_sites to return a stable site label.
    const r = await pool.query(
      `SELECT l.id,
              COALESCE(s.name, '') AS site,
              l.name,
              l.type
         FROM admin_locations l
         JOIN admin_sites s ON s.id = l.admin_site_id
        WHERE l.admin_site_id = $1
        ORDER BY l.type, l.name`,
      [siteId],
    );
    return res.json({ rows: r.rows || [] });
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

// True edit endpoint (supports renaming location name)
router.patch('/admin-locations/:id', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });

    const id = Number(req.params?.id);
    const name = String(req.body?.name || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!id || !name) return res.status(400).json({ error: 'missing id or name' });

    const r = await pool.query(
      `UPDATE admin_locations
          SET name=$1,
              type=$2
        WHERE id=$3 AND admin_site_id=$4
        RETURNING id`,
      [name, type || null, id, siteId],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, id: r.rows[0]?.id || id });
  } catch (e: any) {
    if (String(e?.code) === '23505') return res.status(409).json({ error: 'location already exists' });
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

router.post('/admin-locations', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });
    const name = String(req.body?.name || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!site || !name) return res.status(400).json({ error: 'missing site or name' });
    await pool.query(
      `INSERT INTO admin_locations (admin_site_id, name, type)
       VALUES ($1,$2,$3)
       ON CONFLICT (admin_site_id, name)
       DO UPDATE SET type=EXCLUDED.type`,
      [siteId, name, type || null],
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

    if (site === '*') return res.status(400).json({ error: 'site required' });
    const siteId = await resolveAdminSiteId(pool as any, site);
    if (!siteId) return res.status(404).json({ error: 'site not found' });
    const name = String(req.body?.name || '').trim();
    if (!site || !name) return res.status(400).json({ error: 'missing site or name' });
    await pool.query(`DELETE FROM admin_locations WHERE admin_site_id=$1 AND name=$2`, [siteId, name]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || 'failed' });
  }
});

// --- CALENDAR STATUS ---
router.get('/calendar', siteAdminMiddleware, async (req: any, res) => {
  try {
  const year = parseInt(String(req.query.year || ''), 10) || new Date().getFullYear();
  const site = normalizeSiteParam(req);
  assertSiteAccess(req, site);

  // Calendar status is site-specific. Force a concrete site to avoid accidental "all-sites" queries.
  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ year, site, days: [] });
  const siteId = adminSiteId; // keep naming consistent with other handlers

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  // We base calendar status purely on validated_shifts.validated flags:
  // - green if at least 1 validated_shifts row exists AND all rows for that (site,date) are validated=1
  // - red if at least 1 validated_shifts row exists AND any row is validated=0
  // - none if no validated_shifts rows exist (even if shifts exist)
  const out: any[] = [];

  const agg = await pool.query(
    `SELECT date::text AS date,
            BOOL_AND(validated) AS all_valid,
            BOOL_OR(validated)  AS any_valid
       FROM validated_shifts
      WHERE admin_site_id=$1 AND date >= $2::date AND date <= $3::date
      GROUP BY date
      ORDER BY date ASC`,
    [siteId, from, to],
  );

  for (const r of agg.rows) {
    const d = String(r.date);
    const allValid = Boolean(r.all_valid);
    const anyValid = Boolean(r.any_valid);
    const status = anyValid && allValid ? 'green' : 'red';
    out.push({ date: d, status });
  }

  return res.json({ year, site, days: out });
  } catch (err) {
    console.error('[site-admin] calendar failed', err);
    return res.status(500).json({ error: 'calendar_failed' });
  }
});

router.get('/day', siteAdminMiddleware, async (req: any, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }

  const site = normalizeSiteParam(req);
  assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

  // Live snapshot (from shifts/shift_activities) — your helper already supports site='*'
  const { shifts, activities, source_hash } = await loadDaySnapshot(site, date);

  // Validation-layer rows (created automatically on finalize)
  // IMPORTANT:
  //  - qualify columns using aliases (vs.admin_site_id, vs.date, etc.)
  //  - if site === '*', do NOT filter by site
  let validated_shifts: any[] = [];
  let validated_activities: any[] = [];

  if (site === '*') {
    const vShifts = await pool.query(
      `SELECT
          vs.id,
          COALESCE(asite.name, '') as site,
          vs.date::text as date,
          vs.dn,
          vs.user_email,
          COALESCE(u.name,'') as user_name,
          vs.validated,
          vs.totals_json
        FROM validated_shifts vs
        LEFT JOIN admin_sites asite ON asite.id = vs.admin_site_id
        LEFT JOIN users u ON u.email = vs.user_email
        WHERE vs.date = $1::date
        ORDER BY COALESCE(asite.name,''), vs.dn, vs.user_email, vs.id`,
      [date],
    );
    validated_shifts = vShifts.rows || [];

    const vActs = await pool.query(
      `SELECT
          vsa.id,
          COALESCE(asite.name, '') as site,
          vsa.date::text as date,
          vsa.dn,
          vsa.user_email,
          vsa.activity,
          vsa.sub_activity,
          vsa.payload_json
        FROM validated_shift_activities vsa
        LEFT JOIN admin_sites asite ON asite.id = vsa.admin_site_id
        WHERE vsa.date = $1::date
        ORDER BY COALESCE(asite.name,''), vsa.activity, vsa.sub_activity, vsa.id`,
      [date],
    );
    validated_activities = vActs.rows || [];
  } else {
    const vShifts = await pool.query(
      `SELECT
          vs.id,
          COALESCE(asite.name, '') as site,
          vs.date::text as date,
          vs.dn,
          vs.user_email,
          COALESCE(u.name,'') as user_name,
          vs.validated,
          vs.totals_json
        FROM validated_shifts vs
        LEFT JOIN admin_sites asite ON asite.id = vs.admin_site_id
        LEFT JOIN users u ON u.email = vs.user_email
        WHERE vs.admin_site_id = $1
          AND vs.date = $2::date
        ORDER BY vs.dn, vs.user_email, vs.id`,
      [adminSiteId, date],
    );
    validated_shifts = vShifts.rows || [];

    const vActs = await pool.query(
      `SELECT
          vsa.id,
          COALESCE(asite.name, '') as site,
          vsa.date::text as date,
          vsa.dn,
          vsa.user_email,
          vsa.activity,
          vsa.sub_activity,
          vsa.payload_json
        FROM validated_shift_activities vsa
        LEFT JOIN admin_sites asite ON asite.id = vsa.admin_site_id
        WHERE vsa.admin_site_id = $1
          AND vsa.date = $2::date
        ORDER BY vsa.activity, vsa.sub_activity, vsa.id`,
      [adminSiteId, date],
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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

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
            SET payload_json=$2::jsonb
          WHERE id=$1 AND admin_site_id=$3 AND date=$4::date`,
        [id, JSON.stringify(payload_json), adminSiteId, date],
      );
    }

    // Any edit makes the day require re-validation again
    await client.query(
      `UPDATE validated_shifts
          SET validated=FALSE
        WHERE admin_site_id=$1 AND date=$2::date`,
      [adminSiteId, date],
    );


    // Recompute validated_shifts.totals_json from validated_shift_activities so both layers stay in sync
    const vs = await client.query(
      `SELECT dn, user_email
         FROM validated_shifts
        WHERE admin_site_id=$1 AND date=$2::date
        ORDER BY dn, user_email`,
      [adminSiteId, date],
    );
    for (const row of vs.rows || []) {
      const dn = String(row.dn || '');
      const user_email = String(row.user_email || '');
      const actsR = await client.query(
        `SELECT payload_json
           FROM validated_shift_activities
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          ORDER BY id ASC`,
        [adminSiteId, date, dn, user_email],
      );
      const payloads = (actsR.rows || []).map((x: any) => x.payload_json);
      const totals = computeTotalsBySubFromPayloads(payloads);
      await client.query(
        `UPDATE validated_shifts
            SET totals_json=$5::jsonb
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [adminSiteId, date, dn, user_email, JSON.stringify(totals)],
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

async function markValidatedDayUnvalidated(client: any, admin_site_id: number, date: string, ctx: string) {
  try {
    // validated_days schema differs across older local DBs.
    // Some have a TEXT status column, others only a boolean validated flag.
    // We handle both, and fall back to deleting any row if neither column exists.

    const colsR = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='validated_days'`,
    );
    const cols = new Set<string>((colsR.rows || []).map((r: any) => String(r.column_name || '').toLowerCase()));

    // Some older / drifted databases have a legacy validated_days table keyed differently
    // (e.g. work_site_id/site_id/site text) and therefore do not contain admin_site_id.
    // This helper is best-effort only (we can always recompute day status from validated_shifts),
    // so if admin_site_id is not present, skip rather than failing the calling flow.
    if (cols.size > 0 && !cols.has('admin_site_id')) return;

    if (cols.size === 0) {
      // Create a minimal compatible table using status (newer behavior)
      await client.query(
        `CREATE TABLE IF NOT EXISTS validated_days (
          admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'unvalidated',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (admin_site_id, date)
        )`,
      );
      cols.add('status');
    }

    if (cols.has('status')) {
      const u = await client.query(
        `UPDATE validated_days
            SET status='unvalidated', updated_at=NOW()
          WHERE admin_site_id=$1 AND date=$2::date`,
        [admin_site_id, date],
      );
      if ((u.rowCount || 0) === 0) {
        await client.query(
          `INSERT INTO validated_days (admin_site_id, date, status) VALUES ($1,$2::date,'unvalidated')`,
          [admin_site_id, date],
        );
      }
      return;
    }

    if (cols.has('validated')) {
      // Older schema: boolean validated
      const u = await client.query(
        `UPDATE validated_days
            SET validated=FALSE
          WHERE admin_site_id=$1 AND date=$2::date`,
        [admin_site_id, date],
      );
      if ((u.rowCount || 0) === 0) {
        await client.query(
          `INSERT INTO validated_days (admin_site_id, date, validated) VALUES ($1,$2::date,FALSE)`,
          [admin_site_id, date],
        );
      }
      return;
    }

    // Fallback: just remove any row so calendar can recompute from validated_shifts.
    await client.query(`DELETE FROM validated_days WHERE admin_site_id=$1 AND date=$2::date`, [admin_site_id, date]);
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

    const admin_site_id = await resolveAdminSiteId(client, site);
    if (!admin_site_id) return res.status(400).json({ ok: false, error: 'unknown site' });

    // Friendly name (optional)
    let user_name = '';
    let user_id: number | null = null;
    try {
      const ur = await client.query(`SELECT id, name FROM users WHERE email=$1 LIMIT 1`, [user_email]);
      user_id = (ur.rows?.[0]?.id as number | undefined) ?? null;
      user_name = String(ur.rows?.[0]?.name || '').trim();
    } catch {}
    if (!user_name) user_name = user_email;

    // Optional work_site_id (best effort)
    let work_site_id: number | null = null;
    if (user_id) {
      try {
        const wr = await client.query('SELECT work_site_id FROM users WHERE id=$1', [user_id]);
        const ws = Number(wr.rows?.[0]?.work_site_id);
        work_site_id = Number.isFinite(ws) && ws > 0 ? ws : null;
      } catch {
        work_site_id = null;
      }
    }
    if (!work_site_id) {
      try {
        const sr = await client.query(
          `SELECT work_site_id
             FROM shifts
            WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
            ORDER BY id DESC
            LIMIT 1`,
          [admin_site_id, date, dn, user_email],
        );
        const ws = Number(sr.rows?.[0]?.work_site_id);
        work_site_id = Number.isFinite(ws) && ws > 0 ? ws : null;
      } catch {
        // ignore
      }
    }

    const shiftKey = `${admin_site_id}|${date}|${dn}|${(user_email || '').trim()}`;

    await client.query('BEGIN');

    // Create a validated_shifts row even if the operator never uploaded a shift.
    // This enables SiteAdmin to add activities as the source of truth for that day.
	    try {
	      await client.query(
	        `INSERT INTO validated_shifts (shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, validated, totals_json)
	         VALUES ($1,$2,$3,$4::date,$5,COALESCE($6,''),$7,$8,FALSE,'{}'::jsonb)
	         ON CONFLICT (shift_key) DO NOTHING`,
	        [shiftKey, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id],
	      );
	    } catch (e: any) {
	      // Older local DBs may not have the UNIQUE index needed for ON CONFLICT.
	      const msg = String(e?.message || '');
	      if (msg.includes('no unique') && msg.includes('ON CONFLICT')) {
	        const exists = await client.query(`SELECT id FROM validated_shifts WHERE shift_key=$1 LIMIT 1`, [shiftKey]);
	        if ((exists.rowCount || 0) === 0) {
	          await client.query(
	            `INSERT INTO validated_shifts (shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, validated, totals_json)
	             VALUES ($1,$2,$3,$4::date,$5,COALESCE($6,''),$7,$8,FALSE,'{}'::jsonb)`,
	            [shiftKey, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id],
	          );
	        }
	      } else {
	        throw e;
	      }
	    }

    await markValidatedDayUnvalidated(client, admin_site_id, date, 'create-shift');
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch {}
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

    const admin_site_id = await resolveAdminSiteId(client, site);
    if (!admin_site_id) return res.status(400).json({ ok: false, error: 'unknown site' });

    let user_name = '';
    let user_id: number | null = null;
    try {
      const ur = await client.query(`SELECT id, name FROM users WHERE email=$1 LIMIT 1`, [user_email]);
      user_id = (ur.rows?.[0]?.id as number | undefined) ?? null;
      user_name = String(ur.rows?.[0]?.name || '').trim();
    } catch {}
    if (!user_name) user_name = user_email;

    let work_site_id: number | null = null;
    if (user_id) {
      try {
        const wr = await client.query('SELECT work_site_id FROM users WHERE id=$1', [user_id]);
        const ws = Number(wr.rows?.[0]?.work_site_id);
        work_site_id = Number.isFinite(ws) && ws > 0 ? ws : null;
      } catch {
        work_site_id = null;
      }
    }
    if (!work_site_id) {
      try {
        const sr = await client.query(
          `SELECT work_site_id
             FROM shifts
            WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
            ORDER BY id DESC
            LIMIT 1`,
          [admin_site_id, date, dn, user_email],
        );
        const ws = Number(sr.rows?.[0]?.work_site_id);
        work_site_id = Number.isFinite(ws) && ws > 0 ? ws : null;
      } catch {
        // ignore
      }
    }

    const shiftKey = `${admin_site_id}|${date}|${dn}|${(user_email || '').trim()}`;

    await client.query('BEGIN');

    // Ensure validated_shifts exists and get id (works even if there is no operator-uploaded shift)
	    let validated_shift_id: number | null = null;
	    try {
	      const vs = await client.query(
	        `INSERT INTO validated_shifts (shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, validated, totals_json)
	         VALUES ($1,$2,$3,$4::date,$5,COALESCE($6,''),$7,$8,FALSE,'{}'::jsonb)
	         ON CONFLICT (shift_key) DO UPDATE
	           SET work_site_id=COALESCE(EXCLUDED.work_site_id, validated_shifts.work_site_id),
	               user_name=COALESCE(EXCLUDED.user_name, validated_shifts.user_name),
	               user_id=COALESCE(EXCLUDED.user_id, validated_shifts.user_id)
	         RETURNING id`,
	        [shiftKey, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id],
	      );
	      validated_shift_id = Number(vs.rows?.[0]?.id);
	    } catch (e: any) {
	      const msg = String(e?.message || '');
	      if (msg.includes('no unique') && msg.includes('ON CONFLICT')) {
	        // Deterministic fallback for older DBs without UNIQUE indexes.
	        const existing = await client.query(`SELECT id FROM validated_shifts WHERE shift_key=$1 LIMIT 1`, [shiftKey]);
	        if ((existing.rowCount || 0) > 0) {
	          validated_shift_id = Number(existing.rows?.[0]?.id);
	          await client.query(
	            `UPDATE validated_shifts
	                SET work_site_id=COALESCE($2, work_site_id),
	                    user_name=COALESCE(NULLIF($3,''), user_name),
	                    user_id=COALESCE($4, user_id)
	              WHERE id=$1`,
	            [validated_shift_id, work_site_id, user_name, user_id],
	          );
	        } else {
	          const ins = await client.query(
	            `INSERT INTO validated_shifts (shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, validated, totals_json)
	             VALUES ($1,$2,$3,$4::date,$5,COALESCE($6,''),$7,$8,FALSE,'{}'::jsonb)
	             RETURNING id`,
	            [shiftKey, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id],
	          );
	          validated_shift_id = Number(ins.rows?.[0]?.id);
	        }
	      } else {
	        throw e;
	      }
	    }
	    if (!validated_shift_id || !Number.isFinite(validated_shift_id)) throw new Error('failed to resolve validated_shift_id');

    const insAct = await client.query(
      `INSERT INTO validated_shift_activities (validated_shift_id, shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, activity, sub_activity, payload_json)
       VALUES ($1,$2,$3,$4,$5::date,$6,COALESCE($7,''),$8,$9,$10,$11,$12::jsonb) RETURNING id`,
      [validated_shift_id, shiftKey, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, activity, sub_activity, JSON.stringify(payload_json || {})],
    );

    const rr = await client.query(
      `SELECT payload_json
         FROM validated_shift_activities
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
        ORDER BY id ASC`,
      [admin_site_id, date, dn, user_email],
    );
    const payloads = (rr.rows || []).map((x: any) => x.payload_json);
    const totals = computeTotalsBySubFromPayloads(payloads);

    await client.query(
      `UPDATE validated_shifts
          SET totals_json=$2::jsonb, validated=FALSE
        WHERE shift_key=$1`,
      [shiftKey, JSON.stringify(totals)],
    );

    await markValidatedDayUnvalidated(client, admin_site_id, date, 'add-activity');
    await client.query('COMMIT');
    const inserted_activity_id = Number(insAct.rows?.[0]?.id || 0) || null;
    return res.json({ ok: true, inserted_activity_id, totals });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch {}
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

    const admin_site_id = await resolveAdminSiteId(client, site);
    if (!admin_site_id) return res.status(400).json({ ok: false, error: 'unknown site' });

    await client.query('BEGIN');

    const r = await client.query(
      `SELECT dn,
              COALESCE(user_email,'') AS user_email,
              COALESCE(shift_key,'') AS shift_key,
              admin_site_id
         FROM validated_shift_activities
        WHERE id=$1 AND date=$2::date
        LIMIT 1`,
      [id, date],
    );
    if (!r.rows?.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    // Ownership check: prefer admin_site_id when present; fallback to shift_key prefix.
    const rowAdminSiteId = Number(r.rows[0].admin_site_id || 0) || null;
    const rowShiftKey = String(r.rows[0].shift_key || '');
    if (rowAdminSiteId && rowAdminSiteId !== admin_site_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (!rowAdminSiteId && rowShiftKey && !rowShiftKey.startsWith(`${admin_site_id}|`)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const dn = String(r.rows[0].dn || '');
    const user_email = String(r.rows[0].user_email || '');

    const del = await client.query(
      `DELETE FROM validated_shift_activities
        WHERE id=$1 AND date=$2::date
        RETURNING id`,
      [id, date],
    );
    if (!del.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    // Recompute totals after deletion
    const rr = await client.query(
      `SELECT payload_json
         FROM validated_shift_activities
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
        ORDER BY id ASC`,
      [admin_site_id, date, dn, user_email],
    );
    const payloads = (rr.rows || []).map((x: any) => x.payload_json);
    const totals = computeTotalsBySubFromPayloads(payloads);

    const shiftKey = `${admin_site_id}|${date}|${dn}|${(user_email || '').trim()}`;
    await client.query(
      `INSERT INTO validated_shifts (shift_key, admin_site_id, work_site_id, date, dn, user_email, user_name, user_id, validated, totals_json)
       VALUES ($1,$2,NULL,$3::date,$4,COALESCE($5,''),$6,NULL,FALSE,$7::jsonb)
       ON CONFLICT (shift_key) DO UPDATE
         SET totals_json=EXCLUDED.totals_json,
             validated=FALSE`,
      [shiftKey, admin_site_id, date, dn, user_email, user_email, JSON.stringify(totals)],
    );

    await markValidatedDayUnvalidated(client, admin_site_id, date, 'delete-activity');

    await client.query('COMMIT');
    return res.json({ ok: true, deleted: del.rowCount || 0, totals });
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch {}
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

    // Delete-shift must be site-specific
    if (site === "*") return res.status(400).json({ ok: false, error: "site required" });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: "site not found" });


    await client.query('BEGIN');
    await client.query(
      `DELETE FROM validated_shift_activities
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
      [adminSiteId, date, dn, user_email],
    );
    await client.query(
      `DELETE FROM validated_shifts
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
      [adminSiteId, date, dn, user_email],
    );

    await markValidatedDayUnvalidated(client, adminSiteId, date, 'delete-shift');

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

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (site === '*') {
      await client.query(`UPDATE validated_shifts SET validated=TRUE WHERE date=$1::date`, [date]);
    } else {
      await client.query(`UPDATE validated_shifts SET validated=TRUE WHERE admin_site_id=$1 AND date=$2::date`, [adminSiteId, date]);
    }

// Recompute validated_shifts.totals_json from validated_shift_activities so both layers stay in sync
    const vs = await client.query(
      `SELECT dn, user_email
         FROM validated_shifts
        WHERE admin_site_id=$1 AND date=$2::date
        ORDER BY dn, user_email`,
      [adminSiteId, date],
    );
    for (const row of vs.rows || []) {
      const dn = String(row.dn || '');
      const user_email = String(row.user_email || '');
      const actsR = await client.query(
        `SELECT payload_json
           FROM validated_shift_activities
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          ORDER BY id ASC`,
        [adminSiteId, date, dn, user_email],
      );
      const payloads = (actsR.rows || []).map((x: any) => x.payload_json);
      const totals = computeTotalsBySubFromPayloads(payloads);
      await client.query(
        `UPDATE validated_shifts
            SET totals_json=$5::jsonb
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
        [adminSiteId, date, dn, user_email, JSON.stringify(totals)],
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

// =============================
// RECONCILIATION (Option A)
// =============================
// Note:
// - Reconciliation does NOT create synthetic validated_shifts/activities.
// - It stores month-level targets and pre-computed daily allocations.

type ReconMetric = {
  key: string;
  label: string;
  unit: string;
};

const RECON_METRICS: ReconMetric[] = [
  {
    key: 'firing|development|cut_length',
    label: 'Firing → Development → Cut Length',
    unit: 'm',
  },
];

function isYm(s: string) {
  return /^\d{4}-\d{2}$/.test(s);
}

function monthBounds(ym: string) {
  const [yStr, mStr] = ym.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) throw Object.assign(new Error('invalid month'), { status: 400 });
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1)); // exclusive
  const daysInMonth = Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000));
  const fromYmd = from.toISOString().slice(0, 10);
  const toYmd = to.toISOString().slice(0, 10);
  return { fromYmd, toYmd, daysInMonth, y, m };
}

function roundTo(v: number, dp: number) {
  const p = Math.pow(10, dp);
  return Math.round(v * p) / p;
}

async function computeActualForMetric(opts: {
  site: string;
  month_ym: string;
  metric_key: string;
  basis: 'validated_only' | 'captured_all';
}) {
  const { site, month_ym, metric_key, basis } = opts;
  const { fromYmd, toYmd } = monthBounds(month_ym);

  if (metric_key !== 'firing|development|cut_length') {
    throw Object.assign(new Error('unsupported metric_key'), { status: 400 });
  }

  // Actual = sum(Cut Length) for validated_shift_activities where activity='Firing' and sub_activity='Development'.
  // If basis=validated_only, include only rows tied to validated_shifts.validated=1.
  const siteId = await resolveAdminSiteId(pool as any, site);
  if (!siteId) return 0;

  const r = await pool.query(
    `WITH base AS (
        SELECT
          vsa.date,
          vsa.dn,
          COALESCE(vsa.user_email,'') AS user_email,
          vsa.payload_json,
          vs.validated AS v_validated
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs
          ON vs.id = vsa.validated_shift_id
        WHERE vsa.admin_site_id = $1
          AND vsa.date >= $2::date
          AND vsa.date <  $3::date
          AND vsa.activity = 'Firing'
          AND vsa.sub_activity = 'Development'
      )
      SELECT
        COALESCE(SUM(
          NULLIF((payload_json->'values'->>'Cut Length')::text, '')::numeric
        ), 0) AS total
      FROM base
      WHERE (
        $4::text = 'captured_all'
        OR COALESCE(v_validated, false) = true
      )`,
    [siteId, fromYmd, toYmd, basis],
  );

  const total = Number(r.rows?.[0]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

// List supported metrics
router.get('/reconciliation/metrics', siteAdminMiddleware, async (req: any, res) => {
  try {
    // Reconciliation is available to SiteAdmin-authorized users (validators + admins).
    return res.json({ ok: true, metrics: RECON_METRICS });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Quick month status (used by dashboard)
// GET /api/site-admin/reconciliation/status?site=...&month_ym=YYYY-MM
router.get('/reconciliation/status', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const month_ym = String(req.query?.month_ym || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client as any, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });

      const r = await client.query(
        `SELECT COUNT(*)::int AS metrics,
                SUM(CASE WHEN is_locked=TRUE THEN 1 ELSE 0 END)::int AS locked
           FROM validated_reconciliations
          WHERE admin_site_id=$1 AND month_ym=$2`,
        [adminSiteId, month_ym],
      );

      const metrics = Number(r.rows?.[0]?.metrics || 0);
      const locked = Number(r.rows?.[0]?.locked || 0);

      const state = locked > 0 ? 'closed' : metrics > 0 ? 'in_progress' : 'open';
      return res.json({ ok: true, site, month_ym, state, metrics });
    } finally {
      client.release();
    }
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Get month summary (actual + existing reconciliation)
router.get('/reconciliation/month-summary', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });
    const month_ym = String(req.query?.month_ym || '').trim();
    const metric_key = String(req.query?.metric_key || '').trim();
    const basis = (String(req.query?.basis || 'validated_only').trim() as any) as 'validated_only' | 'captured_all';

    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });
    if (!metric_key) return res.status(400).json({ ok: false, error: 'missing metric_key' });
    if (basis !== 'validated_only' && basis !== 'captured_all') return res.status(400).json({ ok: false, error: 'invalid basis' });

    const actual_total = await computeActualForMetric({ site, month_ym, metric_key, basis });

    const hdr = await pool.query(
      `SELECT id, reconciled_total, basis, method, notes, is_locked, actual_total_snapshot, delta_snapshot, computed_at
         FROM validated_reconciliations
        WHERE admin_site_id=$1 AND month_ym=$2 AND metric_key=$3`,
      [adminSiteId, month_ym, metric_key],
    );
    const row = hdr.rows?.[0] || null;
    const reconciled_total = row ? Number(row.reconciled_total ?? 0) : null;
    const delta = reconciled_total == null ? null : reconciled_total - actual_total;

    let allocations: any[] = [];
    if (row?.id) {
      const d = await pool.query(
        `SELECT date::text AS date, allocated_value
           FROM validated_reconciliation_days
          WHERE reconciliation_id=$1
          ORDER BY date ASC`,
        [row.id],
      );
      allocations = d.rows || [];
    }

    return res.json({
      ok: true,
      site,
      month_ym,
      metric_key,
      basis,
      actual_total,
      reconciliation: row
        ? {
            id: row.id,
            reconciled_total: Number(row.reconciled_total ?? 0),
            basis: row.basis,
            method: row.method,
            notes: row.notes,
            is_locked: !!row.is_locked,
            actual_total_snapshot: row.actual_total_snapshot == null ? null : Number(row.actual_total_snapshot),
            delta_snapshot: row.delta_snapshot == null ? null : Number(row.delta_snapshot),
            computed_at: row.computed_at,
          }
        : null,
      delta,
      allocations,
    });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

async function upsertReconciliationAndCompute(opts: {
  site: string;
  month_ym: string;
  metric_key: string;
  basis: 'validated_only' | 'captured_all';
  method: 'spread_daily' | 'month_end' | 'custom';
  reconciled_total: number;
  notes?: string | null;
  created_by_user_id?: number | null;
}) {
  const { site, month_ym, metric_key, basis, method, reconciled_total, notes, created_by_user_id } = opts;
  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) throw Object.assign(new Error('unknown site'), { status: 404 });
  const { fromYmd, daysInMonth, y, m } = monthBounds(month_ym);

  const actual_total = await computeActualForMetric({ site, month_ym, metric_key, basis });
  const delta = reconciled_total - actual_total;

  // Compute per-day allocations.
  // For now only spread_daily and month_end are supported.
  const allocations: Array<{ date: string; allocated_value: number }> = [];
  if (method === 'month_end') {
    // Allocate everything to last calendar day of the month.
    const lastDay = new Date(Date.UTC(y, m, 0));
    allocations.push({ date: lastDay.toISOString().slice(0, 10), allocated_value: delta });
  } else {
    // spread_daily (default)
    const perDayRaw = daysInMonth ? delta / daysInMonth : 0;
    // Keep 4dp internal for smoothness; ensure exact month sum by adjusting last day.
    const perDay = roundTo(perDayRaw, 4);
    let running = 0;
    for (let i = 0; i < daysInMonth; i++) {
      const d = new Date(Date.UTC(y, m - 1, 1 + i));
      const ymd = d.toISOString().slice(0, 10);
      const v = i === daysInMonth - 1 ? roundTo(delta - running, 4) : perDay;
      allocations.push({ date: ymd, allocated_value: v });
      running = roundTo(running + v, 4);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const up = await client.query(
      `INSERT INTO validated_reconciliations (
          admin_site_id, month_ym, metric_key, reconciled_total, basis, method, notes,
          created_by_user_id, actual_total_snapshot, delta_snapshot, computed_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
       ON CONFLICT (admin_site_id, month_ym, metric_key)
       DO UPDATE SET
         reconciled_total=EXCLUDED.reconciled_total,
         basis=EXCLUDED.basis,
         method=EXCLUDED.method,
         notes=EXCLUDED.notes,
         created_by_user_id=COALESCE(EXCLUDED.created_by_user_id, validated_reconciliations.created_by_user_id),
         actual_total_snapshot=EXCLUDED.actual_total_snapshot,
         delta_snapshot=EXCLUDED.delta_snapshot,
         computed_at=now(),
         updated_at=now()
       RETURNING id, is_locked`,
      [adminSiteId, month_ym, metric_key, reconciled_total, basis, method, notes || null, created_by_user_id || null, actual_total, delta],
    );

    const reconId = Number(up.rows?.[0]?.id);
    const is_locked = !!up.rows?.[0]?.is_locked;
    if (!reconId) throw new Error('failed to upsert reconciliation');
    if (is_locked) throw Object.assign(new Error('reconciliation is locked'), { status: 400 });

    // Replace day allocations
    await client.query(`DELETE FROM validated_reconciliation_days WHERE reconciliation_id=$1`, [reconId]);
    for (const a of allocations) {
      await client.query(
        `INSERT INTO validated_reconciliation_days (reconciliation_id, admin_site_id, month_ym, metric_key, date, allocated_value)
         VALUES ($1,$2,$3,$4,$5::date,$6)`,
        [reconId, adminSiteId, month_ym, metric_key, a.date, a.allocated_value],
      );
    }

    await client.query('COMMIT');
    return { reconId, actual_total, delta, allocations };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// Upsert reconciliation (set reconciled_total) and compute allocations
router.post('/reconciliation/upsert', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });
    const month_ym = String(req.body?.month_ym || '').trim();
    const metric_key = String(req.body?.metric_key || '').trim();
    const basis = (String(req.body?.basis || 'validated_only').trim() as any) as 'validated_only' | 'captured_all';
    const method = (String(req.body?.method || 'spread_daily').trim() as any) as 'spread_daily' | 'month_end' | 'custom';
    const notes = String(req.body?.notes || '').trim() || null;
    const reconciled_total = Number(req.body?.reconciled_total);

    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });
    if (!metric_key) return res.status(400).json({ ok: false, error: 'missing metric_key' });
    if (basis !== 'validated_only' && basis !== 'captured_all') return res.status(400).json({ ok: false, error: 'invalid basis' });
    if (!['spread_daily', 'month_end', 'custom'].includes(method)) return res.status(400).json({ ok: false, error: 'invalid method' });
    if (!Number.isFinite(reconciled_total)) return res.status(400).json({ ok: false, error: 'invalid reconciled_total' });

    const out = await upsertReconciliationAndCompute({
      site,
      month_ym,
      metric_key,
      basis,
      method,
      reconciled_total,
      notes,
      created_by_user_id: req?.site_admin?.user_id || req?.user_id || null,
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Recalculate allocations based on current "actual" totals (keeps reconciled_total)
router.post('/reconciliation/recalculate', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });
    const month_ym = String(req.body?.month_ym || '').trim();
    const metric_key = String(req.body?.metric_key || '').trim();

    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });
    if (!metric_key) return res.status(400).json({ ok: false, error: 'missing metric_key' });

    const hdr = await pool.query(
      `SELECT reconciled_total, basis, method, is_locked
         FROM validated_reconciliations
        WHERE admin_site_id=$1 AND month_ym=$2 AND metric_key=$3`,
      [adminSiteId, month_ym, metric_key],
    );
    const row = hdr.rows?.[0];
    if (!row) return res.status(404).json({ ok: false, error: 'reconciliation not found' });
    if (row.is_locked) return res.status(400).json({ ok: false, error: 'reconciliation is locked' });

    const out = await upsertReconciliationAndCompute({
      site,
      month_ym,
      metric_key,
      basis: row.basis,
      method: row.method,
      reconciled_total: Number(row.reconciled_total ?? 0),
      notes: null,
      created_by_user_id: req?.site_admin?.user_id || req?.user_id || null,
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

router.post('/reconciliation/lock', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });
    const month_ym = String(req.body?.month_ym || '').trim();
    const metric_key = String(req.body?.metric_key || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });
    if (!metric_key) return res.status(400).json({ ok: false, error: 'missing metric_key' });

    await pool.query(
      `UPDATE validated_reconciliations
          SET is_locked=true, updated_at=now()
        WHERE admin_site_id=$1 AND month_ym=$2 AND metric_key=$3`,
      [adminSiteId, month_ym, metric_key],
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

router.post('/reconciliation/unlock', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });
    const month_ym = String(req.body?.month_ym || '').trim();
    const metric_key = String(req.body?.metric_key || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });
    if (!metric_key) return res.status(400).json({ ok: false, error: 'missing metric_key' });

    await pool.query(
      `UPDATE validated_reconciliations
          SET is_locked=false, updated_at=now()
        WHERE admin_site_id=$1 AND month_ym=$2 AND metric_key=$3`,
      [adminSiteId, month_ym, metric_key],
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});


// =============================
// POWER BI SITE TOKENS (per-site)
// =============================
// These are used by Power BI Desktop/Service via Web connector URLs.
// Security model:
// - Site Admin managers can create/revoke tokens for their allowed site(s)
// - Tokens are bound to a specific site

router.get('/powerbi-tokens', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const site = normalizeSiteParam(req);
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

    const r = await pool.query(
      `SELECT id, site, label, token, created_at, revoked_at
         FROM powerbi_site_tokens
        WHERE site = $1
        ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      [site],
    );
    return res.json({ ok: true, site, tokens: r.rows });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to load tokens' });
  }
});

router.post('/powerbi-tokens', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    const label = String(req.body?.label || '').trim() || null;
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'Site is required' });
    assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

    // Create token (retry on rare collisions)
    let token = makePowerBiToken();
    for (let i = 0; i < 3; i++) {
      try {
        const r = await pool.query(
          `INSERT INTO powerbi_site_tokens(site, label, token, created_by_user_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id, site, label, token, created_at, revoked_at`,
          [site, label, token, req.site_admin?.user_id || null],
        );
        return res.json({ ok: true, token: r.rows[0] });
      } catch (err: any) {
        if (String(err?.code || '') === '23505') {
          token = makePowerBiToken();
          continue;
        }
        throw err;
      }
    }
    return res.status(500).json({ ok: false, error: 'Failed to create token (collision)' });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to create token' });
  }
});

router.post('/powerbi-tokens/:id/revoke', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });

    const r = await pool.query(
      `SELECT id, site FROM powerbi_site_tokens WHERE id=$1`,
      [id],
    );
    const row = r.rows?.[0];
    if (!row) return res.status(404).json({ ok: false, error: 'Token not found' });
    assertSiteAccess(req, String(row.site));

    await pool.query(
      `UPDATE powerbi_site_tokens SET revoked_at=now() WHERE id=$1`,
      [id],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to revoke token' });
  }
});



export default router;
