import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../lib/pg.js';
import { siteAdminMiddleware } from '../lib/auth.js';
import { auditLog } from '../lib/audit.js';

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

function makeJoinCode(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  // group for readability: ABCD-EFGH-IJ
  return out.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function b64urlEncode(buf: Buffer) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJoinToken(payload: any) {
  const payloadJson = Buffer.from(JSON.stringify(payload), 'utf-8');
  const payloadB64 = b64urlEncode(payloadJson);
  // ESM-safe: use imported crypto (no `require` on Render)
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}
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

// ---- admin_sites schema compatibility ----
// Some earlier databases have admin_sites.site (TEXT) instead of admin_sites.name (TEXT).
// We avoid referencing a non-existent column by detecting which column exists and then
// using dynamic SQL with a safe, whitelisted column name.
let _adminSitesNameCol: 'name' | 'site' | null = null;

async function detectAdminSitesNameColumn(): Promise<'name' | 'site'> {
  if (_adminSitesNameCol) return _adminSitesNameCol;
  const hasName = await hasColumn('admin_sites', 'name');
  if (hasName) {
    _adminSitesNameCol = 'name';
    return _adminSitesNameCol;
  }
  const hasSite = await hasColumn('admin_sites', 'site');
  _adminSitesNameCol = hasSite ? 'site' : 'name';
  return _adminSitesNameCol;
}

async function adminSitesSelectNameByIdSafe(site_id: number): Promise<string> {
  const col = await detectAdminSitesNameColumn();
  const r = await pool.query(`SELECT ${col} AS name FROM admin_sites WHERE id=$1`, [site_id]);
  return String(r.rows?.[0]?.name || '').trim();
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

function isValidator(req: any) {
  return !!req.site_admin?.is_validator;
}

function assertValidator(req: any) {
  if (!isValidator(req)) {
    const e: any = new Error('forbidden');
    e.status = 403;
    throw e;
  }
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
    await auditLog('site.powerbi_token.revoke', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { token_id: id, site: String(row.site || '') },
    });
    return res.json({ ok: true });
  } catch (e: any) {
    const status = e?.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || 'Failed to revoke token' });
  }
});


// --- Presence / Engagement (SUPER ADMIN ONLY: users.is_admin=true) ---
router.get('/engagement', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertSuperAdmin(req);

    // NOTE: presence tables store a single integer site_id. For users who are NOT
    // subscribed to an official admin site, we write site_id = -work_site_id to
    // avoid collisions with admin_sites.id.
    const siteIdRaw = String(req.query.site_id || '').trim();
    const siteId = siteIdRaw ? Number(siteIdRaw) : null;
    const workOnly = siteId === 0;
    if (siteIdRaw && !Number.isFinite(siteId as any)) {
      return res.status(400).json({ ok: false, error: 'Invalid site_id' });
    }

    // Human label for UI.
    let site_label: string | null = null;
    if (siteId !== null) {
      if (workOnly) {
        site_label = 'Work-site users (all)';
      } else if (siteId > 0) {
        const sr = await pool.query(`SELECT name FROM admin_sites WHERE id=$1 LIMIT 1`, [siteId]);
        site_label = sr.rows?.[0]?.name ? String(sr.rows[0].name) : null;
      } else {
        const wsid = Math.abs(siteId);
        try {
          const wr = await pool.query(`SELECT name_display FROM work_sites WHERE id=$1 LIMIT 1`, [wsid]);
          site_label = wr.rows?.[0]?.name_display ? String(wr.rows[0].name_display) : null;
        } catch {
          site_label = null;
        }
      }
      if (!site_label) return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const staleMins = Math.max(1, Number(process.env.PRESENCE_STALE_MINUTES || 5));

    const onlineQ = await pool.query(
      `
      SELECT pc.user_id,
             COALESCE(pc.admin_site_id, pc.work_site_id) AS site_id,
             pc.admin_site_id,
             pc.work_site_id,
             pc.last_seen,
             u.name,
             COALESCE(NULLIF(u.name,''), split_part(u.email,'@',1), u.email) AS display_name,
             u.email,
             pc.country_code,
             pc.region_code
      FROM presence_current pc
      JOIN users u ON u.id = pc.user_id
      WHERE pc.last_seen >= now() - ($1::text || ' minutes')::interval
        AND (
          $2::int IS NULL OR
          ($2::int = 0 AND pc.work_site_id IS NOT NULL) OR
          pc.admin_site_id = $2::int
        )
      ORDER BY pc.last_seen DESC
      `,
      [String(staleMins), siteId],
    );

    let dailyRows: any[] = [];
    let weeklyRows: any[] = [];

    if (workOnly) {
      // Aggregate across ALL work-site-only users (site_id < 0).
      const dailyQ = await pool.query(
        `
        WITH days AS (
          SELECT (CURRENT_DATE - gs)::date AS day
          FROM generate_series(0, 35) AS gs
        )
        SELECT
          d.day,
          COALESCE((
            SELECT COUNT(DISTINCT pe.user_id)
            FROM presence_events pe
            WHERE pe.site_id < 0
              AND pe.ts::date = d.day
          ), 0) AS dau,
          COALESCE((
            SELECT COUNT(*)
            FROM presence_sessions ps
            WHERE ps.site_id < 0
              AND ps.started_at::date = d.day
          ), 0) AS sessions,
          COALESCE((
            SELECT ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ps.ended_at, ps.last_seen) - ps.started_at)) / 60.0)::numeric, 2)
            FROM presence_sessions ps
            WHERE ps.site_id < 0
              AND ps.started_at::date = d.day
          ), 0) AS minutes
        FROM days d
        ORDER BY d.day DESC
        LIMIT 35
        `,
      );

      const weeklyQ = await pool.query(
        `
        WITH weeks AS (
          SELECT (date_trunc('week', CURRENT_DATE)::date - (gs * 7))::date AS week_start
          FROM generate_series(0, 26) AS gs
        )
        SELECT
          w.week_start,
          COALESCE((
            SELECT COUNT(DISTINCT pe.user_id)
            FROM presence_events pe
            WHERE pe.site_id < 0
              AND pe.ts >= w.week_start
              AND pe.ts < (w.week_start + INTERVAL '7 days')
          ), 0) AS wau,
          COALESCE((
            SELECT COUNT(*)
            FROM presence_sessions ps
            WHERE ps.site_id < 0
              AND ps.started_at >= w.week_start
              AND ps.started_at < (w.week_start + INTERVAL '7 days')
          ), 0) AS sessions,
          COALESCE((
            SELECT ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ps.ended_at, ps.last_seen) - ps.started_at)) / 60.0)::numeric, 2)
            FROM presence_sessions ps
            WHERE ps.site_id < 0
              AND ps.started_at >= w.week_start
              AND ps.started_at < (w.week_start + INTERVAL '7 days')
          ), 0) AS minutes
        FROM weeks w
        ORDER BY w.week_start DESC
        LIMIT 26
        `,
      );

      dailyRows = dailyQ.rows || [];
      weeklyRows = weeklyQ.rows || [];
    } else {
      const today = await pool.query(
        `
        SELECT *
        FROM presence_daily_stats
        WHERE day >= CURRENT_DATE - 35
          AND ($1::int IS NULL OR site_id = $1::int)
        ORDER BY day DESC
        LIMIT 35
        `,
        [siteId],
      );

      const weekly = await pool.query(
        `
        SELECT *
        FROM presence_weekly_stats
        WHERE week_start >= (CURRENT_DATE - 120)
          AND ($1::int IS NULL OR site_id = $1::int)
        ORDER BY week_start DESC
        LIMIT 26
        `,
        [siteId],
      );

      dailyRows = today.rows || [];
      weeklyRows = weekly.rows || [];
    }

    return res.json({
      ok: true,
      site_id: siteId,
      site: site_label,
      online_now: onlineQ.rows || [],
      daily: dailyRows,
      weekly: weeklyRows,
      stale_minutes: staleMins,
    });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'Failed to load engagement' });
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
    // Include work sites too so super-admin can inspect engagement for users
    // who only have a work_site_id (not subscribed to an official admin site).
    let work_site_rows: Array<{ id: number; name_display: string; is_official?: boolean | null; official_site_id?: number | null }> = [];
    if (sites.includes('*')) {
      const r = await pool.query(`SELECT id, name, state FROM admin_sites ORDER BY name ASC`);
      site_rows = r.rows || [];
      try {
        const wr = await pool.query(`SELECT id, name_display, is_official, official_site_id FROM work_sites ORDER BY name_display ASC`);
        work_site_rows = wr.rows || [];
      } catch {
        work_site_rows = [];
      }
    } else if (sites.length) {
      const r = await pool.query(
        `SELECT id, name, state FROM admin_sites WHERE name = ANY($1::text[]) ORDER BY name ASC`,
        [sites],
      );
      site_rows = r.rows || [];
    }
    return res.json({ ok: true, sites, site_rows, work_site_rows, is_super: sites.includes('*'), can_manage: !!req.site_admin?.can_manage });
  } catch {
    const sites = allowedSites(req);
    return res.json({ ok: true, sites, site_rows: [], work_site_rows: [], is_super: sites.includes('*'), can_manage: !!req.site_admin?.can_manage });
  }
});


/**
 * Join code management (per admin site)
 * - Site admins (and super admin) can rotate/disable join codes
 * - Join codes are stored hashed; raw code is only returned once on rotate
 * - QR is a signed token URL (short-lived)
 */
router.get('/join-code/status', siteAdminMiddleware, async (req: any, res) => {
  const site_id = Number(req.query?.site_id || 0);
  if (!site_id) return res.status(400).json({ ok: false, error: 'site_id required' });

  try {
    // Determine site name then scope-check
    const siteName = await adminSitesSelectNameByIdSafe(site_id);
    if (!siteName) return res.status(404).json({ ok: false, error: 'site_not_found' });
    assertSiteAccess(req, siteName);

    const r = await pool.query(
      `SELECT (join_code_hash IS NOT NULL AND TRIM(join_code_hash) <> '') AS enabled,
              join_code_plain,
              join_code_updated_at,
              join_code_expires_at
         FROM admin_sites
        WHERE id=$1
        LIMIT 1`,
      [site_id],
    );
    const row = r.rows?.[0] || {};
    return res.json({
      ok: true,
      enabled: !!row.enabled,
      code: row.join_code_plain ? String(row.join_code_plain) : null,
      join_code_updated_at: row.join_code_updated_at ? String(row.join_code_updated_at) : null,
      join_code_expires_at: row.join_code_expires_at ? String(row.join_code_expires_at) : null,
    });
  } catch (e: any) {
    if (String(e?.code) === '42703') {
      // columns not present in this DB
      return res.json({ ok: true, enabled: false, code: null, join_code_updated_at: null, join_code_expires_at: null });
    }
    console.error('GET /site-admin/join-code/status failed', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/join-code/rotate', siteAdminMiddleware, async (req: any, res) => {
  const site_id = Number(req.body?.site_id || 0);
  const expires_days = req.body?.expires_days != null ? Number(req.body.expires_days) : null;

  if (!site_id) return res.status(400).json({ ok: false, error: 'site_id required' });

  try {
    const siteName = await adminSitesSelectNameByIdSafe(site_id);
    if (!siteName) return res.status(404).json({ ok: false, error: 'site_not_found' });
    assertSiteAccess(req, siteName);

    const code = makeJoinCode(10);
	    // bcryptjs is CommonJS; in ESM builds the functions are usually under `.default`.
	    const bcryptMod: any = await import('bcryptjs');
	    const bcrypt: any = bcryptMod?.default || bcryptMod;
	    if (!bcrypt?.hash) {
	      throw new Error('bcryptjs import failed (hash missing)');
	    }
	    const hash = await bcrypt.hash(code, 10);

    const expiresAt =
      expires_days && expires_days > 0
        ? new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000).toISOString()
        : null;

    await pool.query(
      `UPDATE admin_sites
          SET join_code_hash=$1,
              join_code_plain=$4,
              join_code_updated_at=now(),
              join_code_expires_at=$2
        WHERE id=$3`,
      [hash, expiresAt, site_id, code],
    );

    // Return code ONCE so admin can copy it / generate QR
    return res.json({ ok: true, code, join_code_expires_at: expiresAt });
  } catch (e: any) {
    if (String(e?.code) === '42703') {
      return res.status(500).json({ ok: false, error: 'db_missing_join_code_columns' });
    }
    console.error('POST /site-admin/join-code/rotate failed', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.delete('/join-code', siteAdminMiddleware, async (req: any, res) => {
  const site_id = Number(req.body?.site_id || 0);
  if (!site_id) return res.status(400).json({ ok: false, error: 'site_id required' });

  try {
    const siteName = await adminSitesSelectNameByIdSafe(site_id);
    if (!siteName) return res.status(404).json({ ok: false, error: 'site_not_found' });
    assertSiteAccess(req, siteName);

    await pool.query(
      `UPDATE admin_sites
          SET join_code_hash=NULL,
              join_code_plain=NULL,
              join_code_updated_at=now(),
              join_code_expires_at=NULL
        WHERE id=$1`,
      [site_id],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    if (String(e?.code) === '42703') {
      return res.status(500).json({ ok: false, error: 'db_missing_join_code_columns' });
    }
    console.error('DELETE /site-admin/join-code failed', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Signed QR join link (no raw join code in URL)
router.get('/join-qr', siteAdminMiddleware, async (req: any, res) => {
  const site_id = Number(req.query?.site_id || 0);
  if (!site_id) return res.status(400).json({ ok: false, error: 'site_id required' });

  try {
    const siteName = await adminSitesSelectNameByIdSafe(site_id);
    if (!siteName) return res.status(404).json({ ok: false, error: 'site_not_found' });
    assertSiteAccess(req, siteName);

    // Token is short-lived (default 7 days) and signed.
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 7 * 24 * 60 * 60;
	    // `require` is not available in ESM builds on Render; use dynamic import.
	    const { randomBytes } = await import('node:crypto');
	    const nonce = randomBytes(8).toString('hex');
    const token = signJoinToken({ site_id, iat: now, exp, nonce });

    // Prefer the public app URL (so installed PWA opens), else fall back to relative path.
    // IMPORTANT: set APP_PUBLIC_URL to your client origin (e.g. https://spectatore.com or https://app.spectatore.com).
    const appUrl = String(
      process.env.APP_PUBLIC_URL ||
        process.env.PUBLIC_APP_URL ||
        process.env.CLIENT_URL ||
        process.env.WEB_PUBLIC_URL ||
        ''
    ).replace(/\/$/, '');
    const joinUrl = `${appUrl || ''}/join?token=${encodeURIComponent(token)}`;

    return res.json({ ok: true, token, join_url: joinUrl, expires_at: new Date(exp * 1000).toISOString() });
  } catch (e: any) {
    console.error('GET /site-admin/join-qr failed', e);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
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

// Super-admin only: hard delete feedback row
router.delete('/feedback/:id', siteAdminMiddleware, async (req: any, res) => {
  try {
    const sites = allowedSites(req);
    if (!sites.includes('*')) return res.status(403).json({ ok: false, error: 'forbidden' });

    const id = Number(req.params?.id || 0);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });

    await pool.query('DELETE FROM user_feedback WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to delete feedback' });
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

    // Approval always activates as 'member'. Role changes happen via /members/set-role for active members.
    const effectiveRole: 'member' = 'member';

    // Ensure site exists, then resolve site_id
    await pool.query(`INSERT INTO admin_sites (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [site]);
    const sid = await pool.query(`SELECT id FROM admin_sites WHERE lower(name)=lower($1)`, [site]);
    const site_id = Number(sid.rows?.[0]?.id || 0);
    if (!site_id) return res.status(500).json({ ok: false, error: 'failed to resolve site_id' });

    const hasLegacySiteCol = await hasLegacySiteColumn(pool);

    // Decline a pending request/invite. (Role changes happen only after approval on the Active list.)

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

    const upd = await pool.query(updSql, [user_id, site, effectiveRole, req.user_id || null, site_id]);

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

    // Determine current membership status so we can enforce safe transitions.
    const curRow = await pool.query(`SELECT status, role, invite_status FROM site_memberships WHERE user_id=$1 AND site_id=$2 ORDER BY id DESC LIMIT 1`, [user_id, site_id]);
    const curStatus = String(curRow.rows?.[0]?.status || '').toLowerCase();
    const curInvite = String(curRow.rows?.[0]?.invite_status || '').toLowerCase();

    // If this is a *request* approval, we always approve as MEMBER. Admin can promote later from Active list.
    const requestedApprove = curStatus === 'requested';
    const effectiveRole = requestedApprove ? 'member' : role;

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

    await auditLog('site.members.add', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, target_user_id: user_id, role },
    });
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
    await auditLog('site.members.revoke', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, target_user_id: user_id },
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});



router.post('/members/set-role', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);

    if (site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const adminSiteId = await resolveAdminSiteId(pool as any, site);
    if (!adminSiteId) return res.status(404).json({ ok: false, error: 'site not found' });

    const user_id = Number(req.body?.user_id);
    const role = String(req.body?.role || '').trim();

    if (!user_id) return res.status(400).json({ ok: false, error: 'missing user_id' });

    // Keep roles tight and consistent across the app.
    const allowed = new Set(['member', 'validator', 'admin']);
    if (!allowed.has(role)) return res.status(400).json({ ok: false, error: 'invalid role' });

    const r = await pool.query(
      `UPDATE site_memberships
          SET role=$1
        WHERE user_id=$2 AND site_id=$3 AND status='active'`,
      [role, user_id, adminSiteId],
    );

    if (!r.rowCount) {
      // fallback: if status isn't 'active' yet (e.g., invited), still allow updating role
      await pool.query(
        `UPDATE site_memberships
            SET role=$1
          WHERE user_id=$2 AND site_id=$3`,
        [role, user_id, adminSiteId],
      );
    }

    await auditLog('site.members.set_role', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id: adminSiteId, target_user_id: user_id, role },
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// Lightweight audit log view for site admins
router.get('/audit', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertManager(req);
    const site = String(req.query.site || '').trim() || normalizeSiteParam(req);
    if (!site || site === '*') return res.status(400).json({ ok: false, error: 'missing site' });
    assertSiteAccess(req, site);

    const admin_site_id = await resolveAdminSiteId(pool as any, site);
    if (!admin_site_id) return res.json({ ok: true, rows: [] });

    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const r = await pool.query(
      `SELECT a.id, a.ts, a.action, a.user_id,
              COALESCE(u.name,'') AS user_name,
              COALESCE(u.email,'') AS user_email,
              a.meta
         FROM audit_logs a
         LEFT JOIN users u ON u.id=a.user_id
        WHERE (a.meta->>'admin_site_id' = $1::text) OR (LOWER(a.meta->>'site') = LOWER($2))
        ORDER BY a.ts DESC
        LIMIT $3 OFFSET $4`,
      [admin_site_id, site, limit, offset],
    );
    return res.json({ ok: true, rows: r.rows || [] });
  } catch (e: any) {
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
    // Some legacy DBs include admin_locations.site (NOT NULL). Newer schemas derive site label
    // from admin_sites. Support both safely.
    const hasLegacySiteCol = await hasColumn('admin_locations', 'site');
    const r = await pool.query(
      hasLegacySiteCol
        ? `SELECT l.id,
                COALESCE(NULLIF(l.site,''), COALESCE(s.name,'')) AS site,
                l.name,
                l.type
           FROM admin_locations l
           LEFT JOIN admin_sites s ON s.id = l.admin_site_id
          WHERE l.admin_site_id = $1
          ORDER BY l.type, l.name`
        : `SELECT l.id,
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

    const hasLegacySiteCol = await hasColumn('admin_locations', 'site');
    const r = await pool.query(
      hasLegacySiteCol
        ? `UPDATE admin_locations
              SET name=$1,
                  type=$2,
                  site=$3
            WHERE id=$4 AND admin_site_id=$5
            RETURNING id`
        : `UPDATE admin_locations
              SET name=$1,
                  type=$2
            WHERE id=$3 AND admin_site_id=$4
            RETURNING id`,
      hasLegacySiteCol ? [name, type || null, site, id, siteId] : [name, type || null, id, siteId],
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
    const hasLegacySiteCol = await hasColumn('admin_locations', 'site');
    await pool.query(
      hasLegacySiteCol
        ? `INSERT INTO admin_locations (admin_site_id, site, name, type)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (admin_site_id, name)
           DO UPDATE SET type=EXCLUDED.type, site=EXCLUDED.site`
        : `INSERT INTO admin_locations (admin_site_id, name, type)
           VALUES ($1,$2,$3)
           ON CONFLICT (admin_site_id, name)
           DO UPDATE SET type=EXCLUDED.type`,
      hasLegacySiteCol ? [siteId, site, name, type || null] : [siteId, name, type || null],
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


// --- VALIDATION SEARCH (month scope) ---
router.get('/validation/search', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ error: e?.message || 'forbidden' });
  }

  const site = String(req.query.site || '').trim() || '*';
  assertSiteAccess(req, site);
  if (site === '*') return res.status(400).json({ error: 'site required' });

  const month = String(req.query.month || '').trim(); // YYYY-MM
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return res.status(400).json({ error: 'invalid month' });

  const query = String(req.query.query || '').trim();
  if (!query) return res.json({ ok: true, results: [] });

  const scope = String(req.query.scope || 'all').trim().toLowerCase(); // operator|equipment|heading|all
  const q = query.toLowerCase();

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ ok: true, results: [] });

  const client = await pool.connect();
  try {
    const rows = await client.query(
      `SELECT vs.date::text as date,
              COUNT(*)::int as n
         FROM validated_shift_activities vsa
         JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        WHERE vs.admin_site_id=$1
          AND to_char(vs.date, 'YYYY-MM')=$2
          AND (
            $3='all' OR $3='operator' OR $3='equipment' OR $3='heading'
          )
      `,
      [adminSiteId, month, scope],
    );

    // NOTE: We do filtering in JS to avoid brittle SQL across payload schemas.
    // Pull candidate rows for month and filter by payload/user/equipment/location keywords.
    const cand = await client.query(
      `SELECT vs.date::text as date,
              vs.user_name,
              vs.user_email,
              vsa.payload_json
         FROM validated_shift_activities vsa
         JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        WHERE vs.admin_site_id=$1
          AND to_char(vs.date, 'YYYY-MM')=$2`,
      [adminSiteId, month],
    );

    const byDate: Record<string, { date: string; n: number; scopes: Record<string, number> }> = {};

    function asObj(v: any) {
      if (!v) return {};
      if (typeof v === 'object') return v;
      try {
        return JSON.parse(String(v));
      } catch {
        return {};
      }
    }

    for (const r of cand.rows || []) {
      const date = String(r.date);
      const payload = asObj(r.payload_json);
      const values = payload?.values && typeof payload.values === 'object' ? payload.values : payload;

      const userName = String(r.user_name || '').toLowerCase();
      const userEmail = String(r.user_email || '').toLowerCase();

      const equipment = String(
        values?.Equipment ?? values?.equipment ?? values?.equipment_id ?? values?.EquipmentId ?? payload?.equipment_id ?? '',
      ).toLowerCase();

      const heading = String(
        values?.Location ?? values?.location ?? values?.Heading ?? values?.heading ?? values?.To ?? values?.to ?? payload?.location ?? '',
      ).toLowerCase();

      const hitOperator = userName.includes(q) || userEmail.includes(q);
      const hitEquip = equipment.includes(q);
      const hitHeading = heading.includes(q);

      let ok = false;
      if (scope === 'operator') ok = hitOperator;
      else if (scope === 'equipment') ok = hitEquip;
      else if (scope === 'heading') ok = hitHeading;
      else ok = hitOperator || hitEquip || hitHeading;

      if (!ok) continue;

      if (!byDate[date]) byDate[date] = { date, n: 0, scopes: { operator: 0, equipment: 0, heading: 0 } };
      byDate[date].n += 1;
      if (hitOperator) byDate[date].scopes.operator += 1;
      if (hitEquip) byDate[date].scopes.equipment += 1;
      if (hitHeading) byDate[date].scopes.heading += 1;
    }

    const results = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('validation search failed', err);
    return res.status(500).json({ error: 'validation search failed' });
  } finally {
    client.release();
  }
});

// --- VALIDATION BASELINE (stub) ---
router.get('/validation/baseline', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ error: e?.message || 'forbidden' });
  }
  // Stub for future rolling baselines (median/p90). Return empty for now.
  return res.json({ ok: true, baselines: {} });
});




// --- VALIDATE ---
// --- UPDATE VALIDATED (edits only; does NOT set validated=1) ---
router.post('/update-validated', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ error: e?.message || 'forbidden' });
  }
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });

  const site = String(req.body.site || '').trim() || '*';
  assertSiteAccess(req, site);

  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ shifts: [], activities: [], source_hash: '0', validated_shifts: [], validated_activities: [] });

  const edits = Array.isArray(req.body.edits) ? req.body.edits : []; // [{ id, payload_json }]
  if (!edits.length) return res.json({ ok: true });

  const editIds = edits.map((x: any) => Number(x?.id || 0)).filter((x: any) => Number.isFinite(x) && x > 0);
  if (!editIds.length) return res.json({ ok: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validated shifts are immutable. To edit, a validator/admin must first unvalidate the day.
    // Block edits if any targeted activity belongs to a validated shift.
    try {
      const chk = await client.query(
        `SELECT 1
           FROM validated_shift_activities vsa
           JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
          WHERE vsa.id = ANY($1::int[])
            AND vs.admin_site_id=$2
            AND vs.date=$3::date
            AND vs.validated=TRUE
          LIMIT 1`,
        [editIds, adminSiteId, date],
      );
      if (chk.rows?.length) {
        await client.query('ROLLBACK').catch(() => undefined);
        return res.status(409).json({ error: 'validated shifts are immutable; unvalidate the day before editing' });
      }
    } catch {
      // If the DB doesn't support ANY() for some reason, fall back to per-row checks.
      for (const id of editIds) {
        const chk2 = await client.query(
          `SELECT 1
             FROM validated_shift_activities vsa
             JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
            WHERE vsa.id=$1 AND vs.admin_site_id=$2 AND vs.date=$3::date AND vs.validated=TRUE
            LIMIT 1`,
          [id, adminSiteId, date],
        );
        if (chk2.rows?.length) {
          await client.query('ROLLBACK').catch(() => undefined);
          return res.status(409).json({ error: 'validated shifts are immutable; unvalidate the day before editing' });
        }
      }
    }

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

    // Best-effort audit log
    await auditLog('site.update_validated', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id: adminSiteId, date, edit_count: editIds.length, edit_ids: editIds.slice(0, 50) },
    });
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
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ ok: false, error: e?.message || 'forbidden' });
  }
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

    // Immutable guarantee: if this shift is validated, you must unvalidate first.
    try {
      const chk = await client.query(
        `SELECT validated
           FROM validated_shifts
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          LIMIT 1`,
        [admin_site_id, date, dn, user_email],
      );
      if (chk.rows?.[0]?.validated) {
        return res.status(409).json({ ok: false, error: 'validated shifts are immutable; unvalidate the day before editing' });
      }
    } catch {
      // ignore
    }

    // Immutable guarantee: if this shift row is already validated, it cannot be recreated/overwritten.
    try {
      const chk = await client.query(
        `SELECT validated
           FROM validated_shifts
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          LIMIT 1`,
        [admin_site_id, date, dn, user_email],
      );
      if (chk.rows?.[0]?.validated) {
        return res.status(409).json({ ok: false, error: 'validated shifts are immutable; unvalidate the day before editing' });
      }
    } catch {
      // ignore
    }

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
    await auditLog('site.validated.create_shift', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id, date, dn, user_email, shift_key: shiftKey },
    });
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
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ ok: false, error: e?.message || 'forbidden' });
  }
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

    // Immutable guarantee: if this shift is validated, you must unvalidate first.
    try {
      const chk = await client.query(
        `SELECT validated
           FROM validated_shifts
          WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          LIMIT 1`,
        [admin_site_id, date, dn, user_email],
      );
      if (chk.rows?.[0]?.validated) {
        return res.status(409).json({ ok: false, error: 'validated shifts are immutable; unvalidate the day before editing' });
      }
    } catch {
      // ignore
    }

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
    await auditLog('site.validated.add_activity', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id, date, dn, user_email, shift_key: shiftKey, inserted_activity_id, activity, sub_activity },
    });
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
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ ok: false, error: e?.message || 'forbidden' });
  }
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

    // Immutable guarantee: if this shift is validated, you must unvalidate first.
    const vchk = await client.query(
      `SELECT 1 FROM validated_shifts
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'') AND validated=TRUE
        LIMIT 1`,
      [admin_site_id, date, dn, user_email],
    );
    if (vchk.rows?.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'validated shifts are immutable; unvalidate the day before editing' });
    }

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
    await auditLog('site.validated.delete_activity', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id, date, dn, user_email, activity_id: id },
    });
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
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ ok: false, error: e?.message || 'forbidden' });
  }
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

    // Immutable guarantee: validated shifts cannot be deleted; unvalidate first.
    const vchk = await client.query(
      `SELECT 1 FROM validated_shifts
        WHERE admin_site_id=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')
          AND validated=TRUE
        LIMIT 1`,
      [adminSiteId, date, dn, user_email],
    );
    if (vchk.rows?.length) {
      return res.status(409).json({ ok: false, error: 'validated shifts are immutable; unvalidate the day before deleting' });
    }


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
    await auditLog('site.validated.delete_shift', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id: adminSiteId, date, dn, user_email },
    });
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
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ error: e?.message || 'forbidden' });
  }
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

    await auditLog('site.validate', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id: adminSiteId, date },
    });
    return res.json({ ok: true, site, date });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('validate failed', err);
    return res.status(500).json({ error: 'validate failed' });
  } finally {
    client.release();
  }
});

// --- UNVALIDATE (flag only) ---
// This reopens a day so it can be edited/reconciled, and requires re-validation.
router.post('/unvalidate', siteAdminMiddleware, async (req: any, res) => {
  try {
    assertValidator(req);
  } catch (e: any) {
    return res.status(e?.status || 403).json({ error: e?.message || 'forbidden' });
  }

  const date = String(req.body.date || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });

  const site = String(req.body.site || '').trim() || '*';
  assertSiteAccess(req, site);
  if (site === '*') return res.status(400).json({ error: 'site required' });

  const adminSiteId = await resolveAdminSiteId(pool as any, site);
  if (!adminSiteId) return res.json({ ok: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE validated_shifts SET validated=FALSE WHERE admin_site_id=$1 AND date=$2::date`, [adminSiteId, date]);
    await markValidatedDayUnvalidated(client, adminSiteId, date, 'unvalidate');
    await client.query('COMMIT');

    await auditLog('site.unvalidate', {
      user_id: Number(req.user_id || 0) || null,
      ip: req.ip,
      ua: req.headers?.['user-agent'],
      meta: { site, admin_site_id: adminSiteId, date },
    });
    return res.json({ ok: true, site, date });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('unvalidate failed', err);
    return res.status(500).json({ error: 'unvalidate failed' });
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
  {
    key: 'hauling|ore_tonnes_hauled',
    label: 'Hauling → Ore Tonnes Hauled (Dev + Prod)',
    unit: 't',
  },
  {
    key: 'hauling|production_ore_tonnes_hauled',
    label: 'Hauling → Production Ore Tonnes Hauled',
    unit: 't',
  },
  {
    key: 'hauling|development_ore_tonnes_hauled',
    label: 'Hauling → Development Ore Tonnes Hauled',
    unit: 't',
  },
  {
    key: 'hoisting|ore_tonnes_hoisted',
    label: 'Hoisting → Ore Tonnes Hoisted',
    unit: 't',
  },
  {
    key: 'hoisting|waste_tonnes_hoisted',
    label: 'Hoisting → Waste Tonnes Hoisted',
    unit: 't',
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

  const siteId = await resolveAdminSiteId(pool as any, site);
  if (!siteId) return 0;

  // Helper: include all captured rows, or only those tied to a validated shift
  const basisWhere = `
    WHERE (
      $4::text = 'captured_all'
      OR COALESCE(v_validated, false) = true
    )
  `;

  // NOTE: We parse numbers defensively to handle strings like "1,234" etc.
  // NULLIF(regexp_replace(txt,'[^0-9.\-]','','g'),'')::numeric

  if (metric_key === 'firing|development|cut_length') {
    const r = await pool.query(
      `WITH base AS (
         SELECT
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
           NULLIF(regexp_replace(COALESCE(payload_json->'values'->>'Cut Length',''), '[^0-9.\-]', '', 'g'), '')::numeric
         ), 0) AS total
       FROM base
       ${basisWhere}`,
      [siteId, fromYmd, toYmd, basis],
    );

    const total = Number(r.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  if (metric_key === 'hauling|ore_tonnes_hauled') {
    const r = await pool.query(
      `WITH base AS (
         SELECT
           vsa.payload_json,
           vs.validated AS v_validated
         FROM validated_shift_activities vsa
         LEFT JOIN validated_shifts vs
           ON vs.id = vsa.validated_shift_id
         WHERE vsa.admin_site_id = $1
           AND vsa.date >= $2::date
           AND vsa.date <  $3::date
           AND vsa.activity = 'Hauling'
           AND vsa.sub_activity IN ('Development','Production')
           AND COALESCE(NULLIF(TRIM(vsa.payload_json->'values'->>'Material'), ''), '') ILIKE '%ore%'
       )
       SELECT
         COALESCE(SUM(
           NULLIF(regexp_replace(COALESCE(payload_json->'values'->>'Tonnes Hauled',''), '[^0-9.\-]', '', 'g'), '')::numeric
         ), 0) AS total
       FROM base
       ${basisWhere}`,
      [siteId, fromYmd, toYmd, basis],
    );

    const total = Number(r.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  // Split hauling ore tonnes into Production vs Development.
  // Client ensures Production hauling always sets Material='Ore' even though the dropdown isn't shown.
  if (metric_key === 'hauling|production_ore_tonnes_hauled' || metric_key === 'hauling|development_ore_tonnes_hauled') {
    const sub = metric_key === 'hauling|production_ore_tonnes_hauled' ? 'Production' : 'Development';
    const r = await pool.query(
      `WITH base AS (
         SELECT
           vsa.payload_json,
           vs.validated AS v_validated
         FROM validated_shift_activities vsa
         LEFT JOIN validated_shifts vs
           ON vs.id = vsa.validated_shift_id
         WHERE vsa.admin_site_id = $1
           AND vsa.date >= $2::date
           AND vsa.date <  $3::date
           AND vsa.activity = 'Hauling'
           AND vsa.sub_activity = $5
           AND COALESCE(NULLIF(TRIM(vsa.payload_json->'values'->>'Material'), ''), '') ILIKE '%ore%'
       )
       SELECT
         COALESCE(SUM(
           NULLIF(regexp_replace(COALESCE(payload_json->'values'->>'Tonnes Hauled',''), '[^0-9.\-]', '', 'g'), '')::numeric
         ), 0) AS total
       FROM base
       ${basisWhere}`,
      [siteId, fromYmd, toYmd, basis, sub],
    );

    const total = Number(r.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  if (metric_key === 'hoisting|ore_tonnes_hoisted') {
    const r = await pool.query(
      `WITH base AS (
         SELECT
           vsa.payload_json,
           vs.validated AS v_validated
         FROM validated_shift_activities vsa
         LEFT JOIN validated_shifts vs
           ON vs.id = vsa.validated_shift_id
         WHERE vsa.admin_site_id = $1
           AND vsa.date >= $2::date
           AND vsa.date <  $3::date
           AND vsa.activity = 'Hoisting'
       )
       SELECT
         COALESCE(SUM(
           NULLIF(regexp_replace(COALESCE(payload_json->'values'->>'Ore Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric
         ), 0) AS total
       FROM base
       ${basisWhere}`,
      [siteId, fromYmd, toYmd, basis],
    );

    const total = Number(r.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  if (metric_key === 'hoisting|waste_tonnes_hoisted') {
    const r = await pool.query(
      `WITH base AS (
         SELECT
           vsa.payload_json,
           vs.validated AS v_validated
         FROM validated_shift_activities vsa
         LEFT JOIN validated_shifts vs
           ON vs.id = vsa.validated_shift_id
         WHERE vsa.admin_site_id = $1
           AND vsa.date >= $2::date
           AND vsa.date <  $3::date
           AND vsa.activity = 'Hoisting'
       )
       SELECT
         COALESCE(SUM(
           NULLIF(regexp_replace(COALESCE(payload_json->'values'->>'Waste Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric
         ), 0) AS total
       FROM base
       ${basisWhere}`,
      [siteId, fromYmd, toYmd, basis],
    );

    const total = Number(r.rows?.[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  throw Object.assign(new Error('unsupported metric_key'), { status: 400 });
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
          admin_site_id, site, month_ym, metric_key, reconciled_total, basis, method, notes,
          created_by_user_id, actual_total_snapshot, delta_snapshot, computed_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
       ON CONFLICT (admin_site_id, month_ym, metric_key)
       DO UPDATE SET
         site=EXCLUDED.site,
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
      [adminSiteId, site, month_ym, metric_key, reconciled_total, basis, method, notes || null, created_by_user_id || null, actual_total, delta],
    );

    const reconId = Number(up.rows?.[0]?.id);
    const is_locked = !!up.rows?.[0]?.is_locked;
    if (!reconId) throw new Error('failed to upsert reconciliation');
    if (is_locked) throw Object.assign(new Error('reconciliation is locked'), { status: 400 });

    // Replace day allocations
    // NOTE: live DB has `validated_reconciliation_days.site` as NOT NULL (PowerBI export depends on it)
    await client.query(`DELETE FROM validated_reconciliation_days WHERE reconciliation_id=$1`, [reconId]);
    for (const a of allocations) {
      await client.query(
        `INSERT INTO validated_reconciliation_days (reconciliation_id, admin_site_id, site, month_ym, metric_key, date, allocated_value)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
        [reconId, adminSiteId, site, month_ym, metric_key, a.date, a.allocated_value],
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

// -----------------------------------------------------------------------------
// BUCKET FACTORS (Model 1: shared factor per loader across Prod+Dev)
// -----------------------------------------------------------------------------

type BucketFactorBounds = { min?: number | null; max?: number | null };

function clamp(x: number, lo: number, hi: number) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function solveProjectedGradient(opts: {
  A: number[][]; // m x n
  b: number[]; // m
  bounds: Array<{ lo: number; hi: number }>; // n
  prior: number[]; // n
  lambda?: number;
  iters?: number;
}) {
  const { A, b, bounds, prior } = opts;
  const lambda = Number.isFinite(opts.lambda as any) ? Number(opts.lambda) : 0.05;
  const iters = Number.isFinite(opts.iters as any) ? Number(opts.iters) : 500;
  const m = A.length;
  const n = A[0]?.length || 0;
  if (!m || !n) return { x: [], residual: [], predicted: [] };

  // Compute a conservative step size from Frobenius norm.
  let fro2 = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) fro2 += (A[i][j] || 0) * (A[i][j] || 0);
  const L = 2 * fro2 + 2 * lambda + 1e-9;
  const alpha = 1 / L;

  let x = prior.slice(0, n);
  // Project init
  for (let j = 0; j < n; j++) x[j] = clamp(x[j] || 0, bounds[j].lo, bounds[j].hi);

  const Ax = new Array(m).fill(0);
  for (let k = 0; k < iters; k++) {
    // Ax
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += (A[i][j] || 0) * (x[j] || 0);
      Ax[i] = s;
    }
    // grad = 2 A^T(Ax - b) + 2 lambda (x - prior)
    const grad = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let g = 0;
      for (let i = 0; i < m; i++) g += (A[i][j] || 0) * ((Ax[i] || 0) - (b[i] || 0));
      g = 2 * g + 2 * lambda * ((x[j] || 0) - (prior[j] || 0));
      grad[j] = g;
    }
    // step + project
    let moved = 0;
    for (let j = 0; j < n; j++) {
      const nx = clamp((x[j] || 0) - alpha * (grad[j] || 0), bounds[j].lo, bounds[j].hi);
      moved += Math.abs(nx - (x[j] || 0));
      x[j] = nx;
    }
    if (moved < 1e-6) break;
  }

  // final predicted/residual
  const predicted = new Array(m).fill(0);
  const residual = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += (A[i][j] || 0) * (x[j] || 0);
    predicted[i] = s;
    residual[i] = s - (b[i] || 0);
  }
  return { x, predicted, residual };
}

async function getReconTonnes(client: any, adminSiteId: number, month_ym: string) {
  const prodKey = 'hauling|production_ore_tonnes_hauled';
  const devKey = 'hauling|development_ore_tonnes_hauled';
  const r = await client.query(
    `SELECT metric_key, reconciled_total
       FROM validated_reconciliations
      WHERE admin_site_id=$1 AND month_ym=$2 AND metric_key IN ($3,$4)`,
    [adminSiteId, month_ym, prodKey, devKey],
  );
  let prod = null as null | number;
  let dev = null as null | number;
  for (const row of r.rows || []) {
    if (row.metric_key === prodKey) prod = Number(row.reconciled_total ?? 0);
    if (row.metric_key === devKey) dev = Number(row.reconciled_total ?? 0);
  }
  return { prod, dev };
}

function nNum(v: any) {
  const x = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function valObj(payload_json: any) {
  const v = payload_json?.values;
  return v && typeof v === 'object' ? v : {};
}

// GET /api/site-admin/bucket-factors/month?site=...&month_ym=YYYY-MM

// GET /api/site-admin/bucket-factors/month?site=...&month_ym=YYYY-MM
// Returns per-loader bucket totals (prod/dev), reconciled tonnes (prod/dev), and saved monthly factors.
// Supports per-loader per-month bucket config assignment (groups unknowns by config).
router.get('/bucket-factors/month', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    if (site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const month_ym = String(req.query?.month_ym || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client as any, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });

      const recon = await getReconTonnes(client as any, adminSiteId, month_ym);

      // Pull config defs (site-wide defaults)
      const cfgDefsQ = await client.query(
        `SELECT config_code, estimate_factor, min_factor, max_factor
           FROM bucket_config_defs
          WHERE admin_site_id=$1
          ORDER BY config_code ASC`,
        [adminSiteId],
      );
      const cfgDefs: Record<string, any> = {};
      for (const r of cfgDefsQ.rows || []) {
        const code = String(r.config_code);
        cfgDefs[code] = {
          config_code: code,
          estimate_factor: r.estimate_factor == null ? null : Number(r.estimate_factor),
          min_factor: r.min_factor == null ? null : Number(r.min_factor),
          max_factor: r.max_factor == null ? null : Number(r.max_factor),
        };
      }

      // Monthly assignments (supports bucket swaps)
      const assignQ = await client.query(
        `SELECT loader_id, config_code
           FROM bucket_loader_config_month
          WHERE admin_site_id=$1 AND month_ym=$2
          ORDER BY loader_id ASC`,
        [adminSiteId, month_ym],
      );
      const assignment: Record<string, string> = {};
      for (const r of assignQ.rows || []) assignment[String(r.loader_id)] = String(r.config_code);

      // Loader bucket totals for this month
      const { fromYmd, toYmd } = monthBounds(month_ym);
      const load = await client.query(
        `SELECT payload_json, sub_activity
           FROM validated_shift_activities
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date
            AND activity='Loading'`,
        [adminSiteId, fromYmd, toYmd],
      );

      const agg: Record<string, { prod: number; dev: number }> = {};
      for (const row of load.rows || []) {
        const v = valObj(row.payload_json);
        const loaderId = String(v.Equipment || v.equipment || '').trim();
        if (!loaderId) continue;

        const sub = String(row.sub_activity || '').trim();
        const mat = String(v.Material || v.material || '').trim();
        if (mat && mat.toLowerCase() !== 'ore') continue;

        // Primary bucket fields (as per spec)
        //  - Production primary: Stope to Truck + Stope to SP
        //  - Development primary: Heading to Truck + Heading to SP
        const stopeToTruck = nNum(v['Stope to Truck']);
        const stopeToSP = nNum(v['Stope to SP']);
        const headingToTruck = nNum(v['Heading to Truck']);
        const headingToSP = nNum(v['Heading to SP']);

        if (!agg[loaderId]) agg[loaderId] = { prod: 0, dev: 0 };
        if (sub.toLowerCase().startsWith('production')) agg[loaderId].prod += stopeToTruck + stopeToSP;
        else if (sub.toLowerCase().startsWith('development')) agg[loaderId].dev += headingToTruck + headingToSP;
      }

      const loadersBase = Object.keys(agg)
        .filter((k) => (agg[k].prod || 0) > 0 || (agg[k].dev || 0) > 0)
        .sort()
        .map((k) => ({
          loader_id: k,
          prod_buckets: agg[k].prod || 0,
          dev_buckets: agg[k].dev || 0,
          config_code: assignment[k] || k, // default each loader to its own config
        }));

      // Saved monthly factors (per loader)
      const saved = await client.query(
        `SELECT loader_id, factor, prod_buckets, dev_buckets, prod_tonnes, dev_tonnes, min_factor, max_factor, config_code, config_factor, created_at
           FROM bucket_factors_monthly
          WHERE admin_site_id=$1 AND month_ym=$2
          ORDER BY loader_id ASC`,
        [adminSiteId, month_ym],
      );
      const savedBy: Record<string, any> = {};
      for (const r of saved.rows || []) savedBy[String(r.loader_id)] = r;

      const loaders = loadersBase.map((r) => {
        const s = savedBy[String(r.loader_id)] || null;
        const cfg = cfgDefs[r.config_code] || null;
        const estimate = cfg?.estimate_factor ?? null;
        const min_factor = cfg?.min_factor ?? null;
        const max_factor = cfg?.max_factor ?? null;
        return s
          ? {
              ...r,
              factor: Number(s.factor),
              config_code: String(s.config_code || r.config_code),
              config_factor: s.config_factor == null ? null : Number(s.config_factor),
              estimate_factor: estimate,
              min_factor,
              max_factor,
              prod_tonnes_pred: (r.prod_buckets || 0) * Number(s.factor || 0),
              dev_tonnes_pred: (r.dev_buckets || 0) * Number(s.factor || 0),
            }
          : {
              ...r,
              estimate_factor: estimate,
              min_factor,
              max_factor,
            };
      });

      // Provide config list for UI
      const configs = Object.keys(cfgDefs).map((k) => cfgDefs[k]);

      return res.json({
        ok: true,
        site,
        month_ym,
        reconciled: recon,
        loaders,
        configs,
        assignment,
        saved: saved.rows || [],
      });
    } finally {
      client.release();
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// POST /api/site-admin/bucket-factors/solve
// Body:
//  { site, month_ym, save?:boolean,
//    assignments?: { [loader_id]: config_code },
//    configs?: { [config_code]: { estimate?:number|null, min?:number|null, max?:number|null, lock?:boolean } } }
router.post('/bucket-factors/solve', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    if (site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const month_ym = String(req.body?.month_ym || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });

    const save = req.body?.save === true;
    const assignmentsIn = (req.body?.assignments && typeof req.body.assignments === 'object') ? (req.body.assignments as Record<string, string>) : {};
    const configsIn = (req.body?.configs && typeof req.body.configs === 'object') ? (req.body.configs as Record<string, any>) : {};

    const { fromYmd, toYmd } = monthBounds(month_ym);

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client as any, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });

      const recon = await getReconTonnes(client as any, adminSiteId, month_ym);
      if (!Number.isFinite(recon.prod as any) || !Number.isFinite(recon.dev as any) || recon.prod == null || recon.dev == null) {
        return res.status(400).json({ ok: false, error: 'missing reconciled ore tonnes (production and/or development) for this month' });
      }

      // Load config defs from DB (defaults)
      const cfgDefsQ = await client.query(
        `SELECT config_code, estimate_factor, min_factor, max_factor
           FROM bucket_config_defs
          WHERE admin_site_id=$1`,
        [adminSiteId],
      );
      const cfgDb: Record<string, any> = {};
      for (const r of cfgDefsQ.rows || []) {
        const c = String(r.config_code);
        cfgDb[c] = {
          estimate: r.estimate_factor == null ? null : Number(r.estimate_factor),
          min: r.min_factor == null ? null : Number(r.min_factor),
          max: r.max_factor == null ? null : Number(r.max_factor),
        };
      }

      // Pull loading bucket counts per loader, split by prod/dev.
      const load = await client.query(
        `SELECT payload_json, sub_activity
           FROM validated_shift_activities
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date
            AND activity='Loading'`,
        [adminSiteId, fromYmd, toYmd],
      );

      const loaderAgg: Record<string, { prod: number; dev: number }> = {};
      for (const row of load.rows || []) {
        const v = valObj(row.payload_json);
        const loaderId = String(v.Equipment || v.equipment || '').trim();
        if (!loaderId) continue;

        const sub = String(row.sub_activity || '').trim();

        // If Material exists, filter to Ore
        const mat = String(v.Material || v.material || '').trim();
        if (mat && mat.toLowerCase() !== 'ore') continue;

        // Primary bucket fields
        const stopeToTruck = nNum(v['Stope to Truck']);
        const stopeToSP = nNum(v['Stope to SP']);
        const headingToTruck = nNum(v['Heading to Truck']);
        const headingToSP = nNum(v['Heading to SP']);

        if (!loaderAgg[loaderId]) loaderAgg[loaderId] = { prod: 0, dev: 0 };

        if (sub.toLowerCase().startsWith('production')) loaderAgg[loaderId].prod += stopeToTruck + stopeToSP;
        else if (sub.toLowerCase().startsWith('development')) loaderAgg[loaderId].dev += headingToTruck + headingToSP;
      }

      const loaderIds = Object.keys(loaderAgg).filter((k) => (loaderAgg[k].prod || 0) > 0 || (loaderAgg[k].dev || 0) > 0).sort();
      if (!loaderIds.length) return res.status(400).json({ ok: false, error: 'no loading buckets found for this month (cannot solve)' });

      // Map loader -> config_code (default each loader to itself)
      const loaderToCfg: Record<string, string> = {};
      for (const lid of loaderIds) {
        const raw = String(assignmentsIn[lid] || '').trim();
        loaderToCfg[lid] = raw || lid;
      }

      // Aggregate buckets per config
      const cfgAgg: Record<string, { prod: number; dev: number }> = {};
      for (const lid of loaderIds) {
        const c = loaderToCfg[lid];
        if (!cfgAgg[c]) cfgAgg[c] = { prod: 0, dev: 0 };
        cfgAgg[c].prod += nNum(loaderAgg[lid].prod);
        cfgAgg[c].dev += nNum(loaderAgg[lid].dev);
      }

      const configCodes = Object.keys(cfgAgg).filter((c) => (cfgAgg[c].prod || 0) > 0 || (cfgAgg[c].dev || 0) > 0).sort();
      const m = configCodes.length;
      if (!m) return res.status(400).json({ ok: false, error: 'no config buckets found (cannot solve)' });

      // Build A (2 x m)
      const A: number[][] = [new Array(m).fill(0), new Array(m).fill(0)];
      for (let j = 0; j < m; j++) {
        const c = configCodes[j];
        A[0][j] = nNum(cfgAgg[c].prod);
        A[1][j] = nNum(cfgAgg[c].dev);
      }
      const b = [Number(recon.prod || 0), Number(recon.dev || 0)];

      // Bounds + priors per config
      const bounds = [] as Array<{ lo: number; hi: number }>;
      const prior = [] as number[];
      for (const c of configCodes) {
        const inC = configsIn[c] || {};
        const dbC = cfgDb[c] || {};
        const estRaw = inC.estimate != null ? Number(inC.estimate) : (dbC.estimate != null ? Number(dbC.estimate) : null);

        const minRaw = inC.min != null ? Number(inC.min) : (dbC.min != null ? Number(dbC.min) : 0);
        const maxRaw = inC.max != null ? Number(inC.max) : (dbC.max != null ? Number(dbC.max) : Number.POSITIVE_INFINITY);

        let lo = Number.isFinite(minRaw) ? Math.max(0, minRaw) : 0;
        let hi = Number.isFinite(maxRaw) ? Math.max(lo, maxRaw) : Number.POSITIVE_INFINITY;

        // Optional lock to estimate
        if (inC.lock === true && estRaw != null && Number.isFinite(estRaw)) {
          lo = Math.max(0, estRaw);
          hi = lo;
        }

        bounds.push({ lo, hi });

        // Prior: estimate if provided, else midpoint of bounds
        const p = (estRaw != null && Number.isFinite(estRaw))
          ? Math.max(0, estRaw)
          : (Number.isFinite(hi) ? (lo + hi) / 2 : Math.max(lo, 0));
        prior.push(p);
      }

      const solved = solveProjectedGradient({ A, b, bounds, prior, lambda: 0.05, iters: 800 });
      const x = solved.x;

      // Build per-config results
      const configRows = configCodes.map((c, j) => {
        const factor = nNum(x[j]);
        return {
          config_code: c,
          prod_buckets: nNum(cfgAgg[c].prod),
          dev_buckets: nNum(cfgAgg[c].dev),
          factor,
          min_factor: bounds[j].lo,
          max_factor: Number.isFinite(bounds[j].hi) ? bounds[j].hi : null,
          estimate_factor: prior[j],
          prod_tonnes_pred: nNum(cfgAgg[c].prod) * factor,
          dev_tonnes_pred: nNum(cfgAgg[c].dev) * factor,
        };
      });

      // Per-loader rows (factor assigned by config)
      const factorByCfg: Record<string, number> = {};
      for (const r of configRows) factorByCfg[String(r.config_code)] = Number(r.factor || 0);

      const loaderRows = loaderIds.map((lid) => {
        const c = loaderToCfg[lid];
        const f = factorByCfg[c] || 0;
        const prod_buckets = nNum(loaderAgg[lid].prod);
        const dev_buckets = nNum(loaderAgg[lid].dev);
        return {
          loader_id: lid,
          config_code: c,
          prod_buckets,
          dev_buckets,
          factor: f,
          prod_tonnes_pred: prod_buckets * f,
          dev_tonnes_pred: dev_buckets * f,
        };
      });

      // Totals + residuals
      const prodPred = configRows.reduce((s, r) => s + nNum(r.prod_tonnes_pred), 0);
      const devPred = configRows.reduce((s, r) => s + nNum(r.dev_tonnes_pred), 0);
      const residuals = { prod: prodPred - Number(recon.prod || 0), dev: devPred - Number(recon.dev || 0) };

      if (save) {
        // Persist config defs + assignments for this month, then store monthly factors per loader
        await client.query('BEGIN');

        // Upsert config defs for codes used this month (only those provided/edited)
        for (const c of configCodes) {
          const inC = configsIn[c] || {};
          const est = (inC.estimate != null && Number.isFinite(Number(inC.estimate))) ? Number(inC.estimate) : null;
          const minF = (inC.min != null && Number.isFinite(Number(inC.min))) ? Math.max(0, Number(inC.min)) : null;
          const maxF = (inC.max != null && Number.isFinite(Number(inC.max))) ? Math.max(minF ?? 0, Number(inC.max)) : null;

          // Only upsert if something was provided OR it already exists
          const exists = cfgDb[c] != null;
          if (est == null && minF == null && maxF == null && !exists) continue;

          await client.query(
            `INSERT INTO bucket_config_defs (admin_site_id, site, config_code, estimate_factor, min_factor, max_factor, updated_by_user_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             ON CONFLICT (admin_site_id, config_code)
             DO UPDATE SET estimate_factor=EXCLUDED.estimate_factor,
                           min_factor=EXCLUDED.min_factor,
                           max_factor=EXCLUDED.max_factor,
                           updated_by_user_id=EXCLUDED.updated_by_user_id,
                           updated_at=now()`,
            [adminSiteId, site, c, est, minF, maxF, req.user?.id || null],
          );
        }

        // Upsert loader monthly assignments
        for (const lid of loaderIds) {
          const c = loaderToCfg[lid] || lid;
          await client.query(
            `INSERT INTO bucket_loader_config_month (admin_site_id, site, month_ym, loader_id, config_code, updated_by_user_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())
             ON CONFLICT (admin_site_id, month_ym, loader_id)
             DO UPDATE SET config_code=EXCLUDED.config_code,
                           updated_by_user_id=EXCLUDED.updated_by_user_id,
                           updated_at=now()`,
            [adminSiteId, site, month_ym, lid, c, req.user?.id || null],
          );
        }

        // Upsert per-loader monthly factors snapshot
        for (const lr of loaderRows) {
          const c = String(lr.config_code || lr.loader_id);
          const cfgFactor = factorByCfg[c] || 0;
          // Find bounds for this config for storage convenience
          const cr = configRows.find((r) => String(r.config_code) === c) || null;
          await client.query(
            `INSERT INTO bucket_factors_monthly
              (admin_site_id, site, month_ym, loader_id, factor, prod_buckets, dev_buckets, prod_tonnes, dev_tonnes, min_factor, max_factor, method, created_by_user_id, created_at, config_code, config_factor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'projected_gradient',$12, now(), $13, $14)
             ON CONFLICT (admin_site_id, month_ym, loader_id)
             DO UPDATE SET factor=EXCLUDED.factor,
                           prod_buckets=EXCLUDED.prod_buckets,
                           dev_buckets=EXCLUDED.dev_buckets,
                           prod_tonnes=EXCLUDED.prod_tonnes,
                           dev_tonnes=EXCLUDED.dev_tonnes,
                           min_factor=EXCLUDED.min_factor,
                           max_factor=EXCLUDED.max_factor,
                           config_code=EXCLUDED.config_code,
                           config_factor=EXCLUDED.config_factor,
                           created_by_user_id=EXCLUDED.created_by_user_id,
                           created_at=now()`,
            [
              adminSiteId,
              site,
              month_ym,
              lr.loader_id,
              lr.factor,
              lr.prod_buckets,
              lr.dev_buckets,
              lr.prod_tonnes_pred,
              lr.dev_tonnes_pred,
              cr?.min_factor ?? null,
              cr?.max_factor ?? null,
              req.user?.id || null,
              c,
              cfgFactor,
            ],
          );
        }

        await client.query('COMMIT');
      }

      return res.json({
        ok: true,
        site,
        month_ym,
        reconciled: recon,
        assignment: loaderToCfg,
        configs: configRows,
        loaders: loaderRows,
        totals: { prod_pred: prodPred, dev_pred: devPred },
        residuals,
        underdetermined: m > 2,
        notes: (m > 2)
          ? { warning: `Underdetermined for a single month (2 equations, ${m} configs). Bucket config estimates/bounds are used to select a plausible solution.` }
          : null,
      });
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      return res.status(500).json({ ok: false, error: e?.message || 'failed' });
    } finally {
      client.release();
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});


// ---------------------------------------------------------------------------
// Truck factors (t/truck) - mirrors bucket factors, using Hauling activity
// ---------------------------------------------------------------------------

// GET /api/site-admin/truck-factors/month?site=...&month_ym=YYYY-MM
// Returns per-truck truck totals (prod/dev ore), reconciled tonnes (prod/dev), and saved monthly factors.
// Supports per-truck per-month config assignment (groups unknowns by config).
router.get('/truck-factors/month', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.query?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    if (site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const month_ym = String(req.query?.month_ym || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client as any, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });

      const recon = await getReconTonnes(client as any, adminSiteId, month_ym);

      const cfgDefsQ = await client.query(
        `SELECT config_code, estimate_factor, min_factor, max_factor
           FROM truck_config_defs
          WHERE admin_site_id=$1
          ORDER BY config_code ASC`,
        [adminSiteId],
      );
      const cfgDefs: Record<string, any> = {};
      for (const r of cfgDefsQ.rows || []) {
        const code = String(r.config_code);
        cfgDefs[code] = {
          config_code: code,
          estimate_factor: r.estimate_factor == null ? null : Number(r.estimate_factor),
          min_factor: r.min_factor == null ? null : Number(r.min_factor),
          max_factor: r.max_factor == null ? null : Number(r.max_factor),
        };
      }

      const assignQ = await client.query(
        `SELECT truck_id, config_code
           FROM truck_truck_config_month
          WHERE admin_site_id=$1 AND month_ym=$2
          ORDER BY truck_id ASC`,
        [adminSiteId, month_ym],
      );
      const assignment: Record<string, string> = {};
      for (const r of assignQ.rows || []) assignment[String(r.truck_id)] = String(r.config_code);

      const { fromYmd, toYmd } = monthBounds(month_ym);
      const haul = await client.query(
        `SELECT payload_json, sub_activity
           FROM validated_shift_activities
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date
            AND activity='Hauling'`,
        [adminSiteId, fromYmd, toYmd],
      );

      const agg: Record<string, { prod: number; dev: number }> = {};
      for (const row of haul.rows || []) {
        const v = valObj(row.payload_json);
        const truckId = String(v.Equipment || v.equipment || '').trim();
        if (!truckId) continue;

        const sub = String(row.sub_activity || '').trim().toLowerCase();
        const trucks = nNum(v.Trucks ?? v.trucks);

        if (!agg[truckId]) agg[truckId] = { prod: 0, dev: 0 };
        if (sub.startsWith('production')) {
          agg[truckId].prod += trucks;
        } else if (sub.startsWith('development')) {
          const mat = String(v.Material || v.material || '').trim().toLowerCase();
          if (mat && mat !== 'ore') continue;
          agg[truckId].dev += trucks;
        }
      }

      const trucksBase = Object.keys(agg)
        .filter((k) => (agg[k].prod || 0) > 0 || (agg[k].dev || 0) > 0)
        .sort()
        .map((k) => ({
          truck_id: k,
          prod_trucks: agg[k].prod || 0,
          dev_trucks: agg[k].dev || 0,
          config_code: assignment[k] || k,
        }));

      const saved = await client.query(
        `SELECT truck_id, factor, prod_trucks, dev_trucks, prod_tonnes, dev_tonnes, min_factor, max_factor, config_code, config_factor, created_at
           FROM truck_factors_monthly
          WHERE admin_site_id=$1 AND month_ym=$2
          ORDER BY truck_id ASC`,
        [adminSiteId, month_ym],
      );
      const savedBy: Record<string, any> = {};
      for (const r of saved.rows || []) savedBy[String(r.truck_id)] = r;

      const trucksOut = trucksBase.map((r) => {
        const s = savedBy[String(r.truck_id)] || null;
        const cfg = cfgDefs[r.config_code] || null;
        const estimate = cfg?.estimate_factor ?? null;
        const min_factor = cfg?.min_factor ?? null;
        const max_factor = cfg?.max_factor ?? null;
        return s
          ? {
              ...r,
              factor: Number(s.factor),
              config_code: String(s.config_code || r.config_code),
              config_factor: s.config_factor == null ? null : Number(s.config_factor),
              estimate_factor: estimate,
              min_factor,
              max_factor,
              prod_tonnes_pred: (r.prod_trucks || 0) * Number(s.factor || 0),
              dev_tonnes_pred: (r.dev_trucks || 0) * Number(s.factor || 0),
            }
          : {
              ...r,
              estimate_factor: estimate,
              min_factor,
              max_factor,
            };
      });

      const configs = Object.keys(cfgDefs).map((k) => cfgDefs[k]);

      return res.json({
        ok: true,
        site,
        month_ym,
        reconciled: recon,
        trucks: trucksOut,
        configs,
        assignment,
        saved: saved.rows || [],
      });
    } finally {
      client.release();
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});

// POST /api/site-admin/truck-factors/solve
// Body mirrors bucket-factors/solve but uses Hauling truck counts
router.post('/truck-factors/solve', siteAdminMiddleware, async (req: any, res) => {
  try {
    const site = String(req.body?.site || '').trim() || normalizeSiteParam(req);
    assertSiteAccess(req, site);
    if (site === '*') return res.status(400).json({ ok: false, error: 'site required' });

    const month_ym = String(req.body?.month_ym || '').trim();
    if (!isYm(month_ym)) return res.status(400).json({ ok: false, error: 'invalid month_ym' });

    const save = req.body?.save === true;
    const assignmentsIn = (req.body?.assignments && typeof req.body.assignments === 'object') ? (req.body.assignments as Record<string, string>) : {};
    const configsIn = (req.body?.configs && typeof req.body.configs === 'object') ? (req.body.configs as Record<string, any>) : {};

    const { fromYmd, toYmd } = monthBounds(month_ym);

    const client = await pool.connect();
    try {
      const adminSiteId = await resolveAdminSiteId(client as any, site);
      if (!adminSiteId) return res.status(404).json({ ok: false, error: 'unknown site' });

      const recon = await getReconTonnes(client as any, adminSiteId, month_ym);
      if (!Number.isFinite(recon.prod as any) || !Number.isFinite(recon.dev as any) || recon.prod == null || recon.dev == null) {
        return res.status(400).json({ ok: false, error: 'missing reconciled ore tonnes (production and/or development) for this month' });
      }

      const cfgDefsQ = await client.query(
        `SELECT config_code, estimate_factor, min_factor, max_factor
           FROM truck_config_defs
          WHERE admin_site_id=$1`,
        [adminSiteId],
      );
      const cfgDb: Record<string, any> = {};
      for (const r of cfgDefsQ.rows || []) {
        const c = String(r.config_code);
        cfgDb[c] = {
          estimate: r.estimate_factor == null ? null : Number(r.estimate_factor),
          min: r.min_factor == null ? null : Number(r.min_factor),
          max: r.max_factor == null ? null : Number(r.max_factor),
        };
      }

      const haul = await client.query(
        `SELECT payload_json, sub_activity
           FROM validated_shift_activities
          WHERE admin_site_id=$1
            AND date >= $2::date AND date < $3::date
            AND activity='Hauling'`,
        [adminSiteId, fromYmd, toYmd],
      );

      const truckAgg: Record<string, { prod: number; dev: number }> = {};
      for (const row of haul.rows || []) {
        const v = valObj(row.payload_json);
        const truckId = String(v.Equipment || v.equipment || '').trim();
        if (!truckId) continue;

        const sub = String(row.sub_activity || '').trim().toLowerCase();
        const trucks = nNum(v.Trucks ?? v.trucks);

        if (!truckAgg[truckId]) truckAgg[truckId] = { prod: 0, dev: 0 };

        if (sub.startsWith('production')) {
          truckAgg[truckId].prod += trucks;
        } else if (sub.startsWith('development')) {
          const mat = String(v.Material || v.material || '').trim().toLowerCase();
          if (mat && mat !== 'ore') continue;
          truckAgg[truckId].dev += trucks;
        }
      }

      const truckIds = Object.keys(truckAgg).filter((k) => (truckAgg[k].prod || 0) > 0 || (truckAgg[k].dev || 0) > 0).sort();
      if (!truckIds.length) return res.status(400).json({ ok: false, error: 'no hauling trucks found for this month (cannot solve)' });

      const truckToCfg: Record<string, string> = {};
      for (const tid of truckIds) {
        const raw = String(assignmentsIn[tid] || '').trim();
        truckToCfg[tid] = raw || tid;
      }

      const cfgAgg: Record<string, { prod: number; dev: number }> = {};
      for (const tid of truckIds) {
        const c = truckToCfg[tid];
        if (!cfgAgg[c]) cfgAgg[c] = { prod: 0, dev: 0 };
        cfgAgg[c].prod += nNum(truckAgg[tid].prod);
        cfgAgg[c].dev += nNum(truckAgg[tid].dev);
      }

      const cfgCodes = Object.keys(cfgAgg).sort();

      // Build per-config bounds + priors (non-negative)
      const cfgParams: Record<string, { estimate: number; min: number; max: number; lock: boolean }> = {};
      for (const code of cfgCodes) {
        const db = cfgDb[code] || {};
        const inV = configsIn[code] || {};
        const lock = inV?.lock === true;
        const est = Number.isFinite(inV?.estimate) ? Number(inV.estimate) : (Number.isFinite(db?.estimate) ? Number(db.estimate) : 0);
        const min = Number.isFinite(inV?.min) ? Number(inV.min) : (Number.isFinite(db?.min) ? Number(db.min) : 0);
        const max = Number.isFinite(inV?.max) ? Number(inV.max) : (Number.isFinite(db?.max) ? Number(db.max) : Math.max(est || 0, min || 0, 0) * 10 + 1);
        const lo = Math.max(0, lock ? est : min);
        const hi = Math.max(lo, lock ? est : max);
        cfgParams[code] = { estimate: Math.max(0, est || 0), min: lo, max: hi, lock };
      }

      // Solve 2 equations with projected gradient (same approach as bucket factors)
      const prodTarget = Number(recon.prod || 0);
      const devTarget = Number(recon.dev || 0);
      const n = cfgCodes.length;

      let x = cfgCodes.map((c) => cfgParams[c].estimate || 0);
      // project to bounds
      x = x.map((v, i) => Math.min(Math.max(v, cfgParams[cfgCodes[i]].min), cfgParams[cfgCodes[i]].max));

      const maxIters = 400;
      const lr = 1e-6;
      for (let it = 0; it < maxIters; it++) {
        let prodPred = 0;
        let devPred = 0;
        for (let i = 0; i < n; i++) {
          const c = cfgCodes[i];
          prodPred += cfgAgg[c].prod * x[i];
          devPred += cfgAgg[c].dev * x[i];
        }
        const eP = prodPred - prodTarget;
        const eD = devPred - devTarget;

        // Gradient of squared error
        const grad = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          const c = cfgCodes[i];
          grad[i] = 2 * eP * cfgAgg[c].prod + 2 * eD * cfgAgg[c].dev;
        }

        let moved = 0;
        for (let i = 0; i < n; i++) {
          const c = cfgCodes[i];
          if (cfgParams[c].lock) continue;
          const next = x[i] - lr * grad[i];
          const proj = Math.min(Math.max(next, cfgParams[c].min), cfgParams[c].max);
          moved += Math.abs(proj - x[i]);
          x[i] = proj;
        }
        if (moved < 1e-6) break;
      }

      // Build per-truck rows for UI
      const cfgFactor: Record<string, number> = {};
      for (let i = 0; i < n; i++) cfgFactor[cfgCodes[i]] = x[i];

      const trucks = truckIds.map((tid) => {
        const c = truckToCfg[tid];
        const f = cfgFactor[c] || 0;
        const prod_trucks = nNum(truckAgg[tid].prod);
        const dev_trucks = nNum(truckAgg[tid].dev);
        return {
          truck_id: tid,
          config_code: c,
          prod_trucks,
          dev_trucks,
          factor: f,
          config_factor: f,
          prod_tonnes: prod_trucks * f,
          dev_tonnes: dev_trucks * f,
          min_factor: cfgParams[c].min,
          max_factor: cfgParams[c].max,
        };
      });

      // Totals + residuals
      const totals = trucks.reduce(
        (acc, r) => {
          acc.prod_pred += nNum(r.prod_tonnes);
          acc.dev_pred += nNum(r.dev_tonnes);
          return acc;
        },
        { prod_pred: 0, dev_pred: 0 },
      );

      const residuals = {
        prod: totals.prod_pred - prodTarget,
        dev: totals.dev_pred - devTarget,
      };

      const notes: any = {};
      if (cfgCodes.length > 2) {
        notes.warning = `Underdetermined for a single month (2 equations, ${cfgCodes.length} configs). Estimates/bounds are used to choose a best-fit solution.`;
      }

      if (save) {
        // Save config defs
        for (const code of cfgCodes) {
          const p = cfgParams[code];
          await client.query(
            `INSERT INTO truck_config_defs (admin_site_id, site, config_code, estimate_factor, min_factor, max_factor, updated_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (admin_site_id, config_code) DO UPDATE
               SET estimate_factor=EXCLUDED.estimate_factor,
                   min_factor=EXCLUDED.min_factor,
                   max_factor=EXCLUDED.max_factor,
                   updated_by_user_id=EXCLUDED.updated_by_user_id,
                   updated_at=now()`,
            [adminSiteId, site, code, p.estimate, p.min, p.max, req.user?.id || null],
          );
        }

        // Save monthly assignments
        for (const tid of truckIds) {
          const code = truckToCfg[tid];
          await client.query(
            `INSERT INTO truck_truck_config_month (admin_site_id, site, month_ym, truck_id, config_code, updated_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (admin_site_id, month_ym, truck_id) DO UPDATE
               SET config_code=EXCLUDED.config_code,
                   updated_by_user_id=EXCLUDED.updated_by_user_id,
                   updated_at=now()`,
            [adminSiteId, site, month_ym, tid, code, req.user?.id || null],
          );
        }

        // Save monthly factors (per truck)
        for (const row of trucks) {
          const code = String(row.config_code || row.truck_id);
          const f = Number(row.factor || 0);
          await client.query(
            `INSERT INTO truck_factors_monthly (admin_site_id, site, month_ym, truck_id, factor, prod_trucks, dev_trucks, prod_tonnes, dev_tonnes, min_factor, max_factor, config_code, config_factor, created_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (admin_site_id, month_ym, truck_id) DO UPDATE
               SET factor=EXCLUDED.factor,
                   prod_trucks=EXCLUDED.prod_trucks,
                   dev_trucks=EXCLUDED.dev_trucks,
                   prod_tonnes=EXCLUDED.prod_tonnes,
                   dev_tonnes=EXCLUDED.dev_tonnes,
                   min_factor=EXCLUDED.min_factor,
                   max_factor=EXCLUDED.max_factor,
                   config_code=EXCLUDED.config_code,
                   config_factor=EXCLUDED.config_factor,
                   created_by_user_id=EXCLUDED.created_by_user_id,
                   created_at=now()`,
            [adminSiteId, site, month_ym, row.truck_id, f, row.prod_trucks, row.dev_trucks, row.prod_tonnes, row.dev_tonnes, row.min_factor, row.max_factor, code, f, req.user?.id || null],
          );
        }
      }

      return res.json({
        ok: true,
        site,
        month_ym,
        reconciled: recon,
        trucks,
        totals,
        residuals,
        notes,
      });
    } finally {
      client.release();
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' });
  }
});


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




/**
 * Support Snapshot (Super Admin tool)
 *
 * Returns a single, server-authoritative view of a user's:
 * - subscription + Stripe ids
 * - site memberships / roles
 * - recent presence
 * - latest audit logs
 *
 * Access:
 * - Super admins only (req.site_admin.sites includes '*')
 */
router.get('/support-snapshot', siteAdminMiddleware, async (req, res) => {
  try {
    assertSuperAdmin(req);

    const rawUserId = String(req.query?.user_id || '').trim();
    const rawEmail = String(req.query?.email || '').trim().toLowerCase();
    const rawName = String(req.query?.name || '').trim();

    // We prefer name-based lookup for the Support UI (safer for operators who don’t know the exact email).
    // Behavior:
    // - If user_id provided: load snapshot for that user.
    // - Else if email provided: load snapshot.
    // - Else if name provided:
    //    - If 0 matches: 404
    //    - If >1 matches: return { matches:[...] } for the UI to let support choose
    //    - If 1 match: load snapshot
    if (!rawUserId && !rawEmail && !rawName) {
      return res.status(400).json({ error: 'name (or user_id) required' });
    }

    let targetUserId: number | null = null;
    let targetEmail: string | null = null;

    if (rawUserId) {
      const n = Number(rawUserId);
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid user_id' });
      targetUserId = n;
    } else if (rawEmail) {
      targetEmail = rawEmail;
    } else if (rawName) {
      const like = `%${rawName}%`;
      const mr = await pool.query(
        `SELECT id, email, name
           FROM users
          WHERE name ILIKE $1
          ORDER BY name ASC
          LIMIT 10`,
        [like],
      );
      const matches = mr.rows || [];
      if (!matches.length) return res.status(404).json({ error: 'no users matched that name' });
      if (matches.length > 1) return res.json({ ok: true, matches });
      targetUserId = matches[0].id;
      targetEmail = matches[0].email;
    }

    const ur = await pool.query(
      `SELECT id, email, name, is_admin, billing_exempt,
              stripe_customer_id, stripe_subscription_id,
              subscription_status, subscription_price_id, subscription_interval,
              current_period_end, cancel_at_period_end,
              work_site_id, site
         FROM users
        WHERE ($1::int IS NOT NULL AND id = $1)
           OR ($2::text IS NOT NULL AND LOWER(email)=LOWER($2))
        LIMIT 1`,
      [targetUserId, targetEmail],
    );
    const u = ur.rows?.[0];
    if (!u) return res.status(404).json({ error: 'user not found' });

    // Memberships (admin sites)
    let memberships: any[] = [];
    try {
      const mr = await pool.query(
        `SELECT m.id, m.site_id, COALESCE(s.name, m.site_name) AS site_name,
                m.role, m.status, m.created_at
           FROM site_memberships m
      LEFT JOIN admin_sites s ON s.id = m.site_id
          WHERE m.user_id = $1
          ORDER BY m.created_at DESC NULLS LAST`,
        [u.id],
      );
      memberships = mr.rows || [];
    } catch {
      memberships = [];
    }

    // Presence (current + last session)
    let presence_current: any = null;
    let last_session: any = null;
    try {
      const pr = await pool.query(
        `SELECT user_id, email, name, site_id, site, state, region, is_admin, last_seen, online, meta
           FROM presence_current
          WHERE user_id = $1
          ORDER BY last_seen DESC
          LIMIT 1`,
        [u.id],
      );
      presence_current = pr.rows?.[0] || null;
    } catch {
      presence_current = null;
    }

    try {
      const sr = await pool.query(
        `SELECT id, user_id, email, name, site_id, site, state, region,
                started_at, last_seen, ended_at,
                EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::int AS seconds
           FROM presence_sessions
          WHERE user_id = $1
          ORDER BY started_at DESC
          LIMIT 1`,
        [u.id],
      );
      last_session = sr.rows?.[0] || null;
    } catch {
      last_session = null;
    }

    // Audit logs (last 20)
    let audits: any[] = [];
    try {
      const ar = await pool.query(
        `SELECT ts, action, user_id, ip, ua, meta
           FROM audit_logs
          WHERE user_id = $1
          ORDER BY ts DESC
          LIMIT 20`,
        [u.id],
      );
      audits = ar.rows || [];
    } catch {
      audits = [];
    }

    // Scheduled Stripe change (best effort; matches /billing/status UI behavior)
    let scheduled_change: any = null;
    try {
      if (u.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
        const StripeMod: any = await import('stripe');
        const StripeCtor = StripeMod?.default || StripeMod;
        const stripe = new StripeCtor(String(process.env.STRIPE_SECRET_KEY), { apiVersion: '2023-10-16' } as any);
        const sub: any = await stripe.subscriptions.retrieve(String(u.stripe_subscription_id));
        const scheduleId: string | null = (sub as any).schedule ?? null;
        if (scheduleId) {
          const sched: any = await stripe.subscriptionSchedules.retrieve(String(scheduleId), {
            expand: ['phases.items.price'],
          });
          const phases = Array.isArray(sched?.phases) ? sched.phases : [];
          const nowSec = Math.floor(Date.now() / 1000);
          const currentPhase =
            phases.find((p: any) => p?.start_date && p.start_date <= nowSec && (!p.end_date || p.end_date > nowSec)) ||
            phases[0] ||
            null;

          const nextPhase =
            phases.find((p: any) => p?.start_date && p.start_date > nowSec) ||
            phases.find((p: any) => p?.end_date && p.end_date > nowSec && p?.start_date && p.start_date > nowSec) ||
            null;

          const readPhase = (p: any) => {
            const items = Array.isArray(p?.items) ? p.items : [];
            const price = items?.[0]?.price;
            const interval = price?.recurring?.interval || null;
            const price_id = price?.id || null;
            const amount = typeof price?.unit_amount === 'number' ? price.unit_amount : null;
            const currency = price?.currency || null;
            return { price_id, interval, unit_amount: amount, currency };
          };

          if (nextPhase) {
            scheduled_change = {
              schedule_id: scheduleId,
              current: currentPhase ? readPhase(currentPhase) : null,
              next: readPhase(nextPhase),
              effective_at: nextPhase?.start_date ? new Date(nextPhase.start_date * 1000).toISOString() : null,
            };
          }
        }
      }
    } catch {
      scheduled_change = null;
    }

    return res.json({
      ok: true,
      user: u,
      memberships,
      presence_current,
      last_session,
      audits,
      scheduled_change,
    });
  } catch (e: any) {
    const status = Number(e?.status || 500);
    if (status === 403) return res.status(403).json({ error: 'forbidden' });
    return res.status(status).json({ error: e?.message || 'snapshot failed' });
  }
});


export default router;