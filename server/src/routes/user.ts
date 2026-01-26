import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// ---- schema helpers (support older DB variants) ----
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

async function hasColumn(table: string, col: string): Promise<boolean> {
  const cols = await tableColumns(table);
  return cols.has(col);
}

// ---- admin_sites schema compatibility ----
// Some earlier databases have admin_sites.site (TEXT) instead of admin_sites.name (TEXT).
// We avoid referencing a non-existent column by trying the newer schema first and falling
// back to the legacy column.

async function adminSitesSelectAll(): Promise<Array<{ id: number; name: string }>> {
  try {
    const r = await pool.query('SELECT id, name FROM admin_sites ORDER BY name ASC');
    return (r.rows || []).map((x: any) => ({ id: Number(x.id), name: String(x.name) }));
  } catch (e: any) {
    // legacy column
    const r = await pool.query('SELECT id, site AS name FROM admin_sites ORDER BY site ASC');
    return (r.rows || []).map((x: any) => ({ id: Number(x.id), name: String(x.name) }));
  }
}

async function adminSitesSelectNameById(site_id: number): Promise<string> {
  try {
    const r = await pool.query('SELECT name FROM admin_sites WHERE id=$1', [site_id]);
    return String(r.rows?.[0]?.name || '').trim();
  } catch (e: any) {
    const r = await pool.query('SELECT site AS name FROM admin_sites WHERE id=$1', [site_id]);
    return String(r.rows?.[0]?.name || '').trim();
  }
}

async function adminSitesInsertNames(names: string[]): Promise<void> {
  const cleaned = Array.from(
    new Set(names.map((s) => String(s || '').trim()).filter((s) => s.length > 0)),
  );
  if (!cleaned.length) return;
  // Try new schema first
  try {
    await pool.query(
      `INSERT INTO admin_sites (name)
       SELECT * FROM UNNEST($1::text[])
       ON CONFLICT (name) DO NOTHING`,
      [cleaned],
    );
    return;
  } catch (e: any) {
    // Legacy schema
    await pool.query(
      `INSERT INTO admin_sites (site)
       SELECT * FROM UNNEST($1::text[])
       ON CONFLICT (site) DO NOTHING`,
      [cleaned],
    );
  }
}
async function getAdminSiteNameById(site_id: number): Promise<string> {
  try {
    const r = await pool.query('SELECT name FROM admin_sites WHERE id=$1', [site_id]);
    return String(r.rows?.[0]?.name || '').trim();
  } catch (e: any) {
    if (String(e?.code) !== '42703') throw e; // not a "missing column" error
    const r = await pool.query('SELECT site AS name FROM admin_sites WHERE id=$1', [site_id]);
    return String(r.rows?.[0]?.name || '').trim();
  }
}

async function listAdminSites(): Promise<Array<{ id: number; name: string }>> {
  try {
    const r = await pool.query('SELECT id, name FROM admin_sites ORDER BY name ASC');
    return (r.rows || []).map((x: any) => ({ id: Number(x.id || 0), name: String(x.name || '').trim() }));
  } catch (e: any) {
    if (String(e?.code) !== '42703') throw e;
    const r = await pool.query('SELECT id, site AS name FROM admin_sites ORDER BY site ASC');
    return (r.rows || []).map((x: any) => ({ id: Number(x.id || 0), name: String(x.name || '').trim() }));
  }
}

async function ensureAdminSitesFromKnownNames(): Promise<void> {
  // Insert discovered site names into admin_sites, for databases where admin_sites is empty.
  // Works for both schemas (name vs site).
  const namesSql = `
    SELECT DISTINCT TRIM(name) AS name
    FROM (
      SELECT site AS name FROM users WHERE site IS NOT NULL AND TRIM(site) <> ''
      UNION
      SELECT site_name AS name FROM site_memberships WHERE site_name IS NOT NULL AND TRIM(site_name) <> ''
      UNION
      SELECT site AS name FROM site_memberships WHERE site IS NOT NULL AND TRIM(site) <> ''
    ) t
    WHERE TRIM(name) <> ''
  `;

  // Try newer schema first
  try {
    await pool.query(
      `INSERT INTO admin_sites (name)
       ${namesSql}
       ON CONFLICT (name) DO NOTHING`,
    );
  } catch (e: any) {
    if (String(e?.code) !== '42703') throw e;
    // Legacy schema
    await pool.query(
      `INSERT INTO admin_sites (site)
       ${namesSql}
       ON CONFLICT (site) DO NOTHING`,
    );
  }
}

function normaliseEmail(raw: any): string {
  return String(raw || '').trim().toLowerCase();
}

function tokenFor(user: any) {
  return jwt.sign(
    { id: user.id, email: user.email, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

router.get('/me', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const r = await pool.query(
      `SELECT u.id, u.email, u.site, u.is_admin, u.name, u.terms_accepted_at, u.terms_version,
              u.work_site_id,
              u.community_state,
              ws.name_display AS work_site_name,
              COALESCE(u.primary_admin_site_id, u.primary_site_id) AS primary_site_id,
              s.name AS subscribed_site_name
         FROM users u
         LEFT JOIN work_sites ws ON ws.id = u.work_site_id
         LEFT JOIN admin_sites s ON s.id = COALESCE(u.primary_admin_site_id, u.primary_site_id)
        WHERE u.id=$1`,
      [user_id],
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'user not found' });

    // Memberships are authoritative for roles (member/validator/admin) per site.
    // Some legacy accounts may still only have users.site; in that case we expose
    // an implicit active member record so the UI can show the user's role.
    let memberships: any[] = [];
    try {
      // Don't depend on admin_sites columns here; membership rows already carry the site name.
      const cols = await tableColumns('site_memberships');
      const siteExpr = cols.has('site_name')
        ? 'm.site_name'
        : cols.has('site')
          ? 'm.site'
          : "''";
      const mr = await pool.query(
        `SELECT m.id,
                m.site_id,
                COALESCE(${siteExpr}, '') AS site,
                COALESCE(NULLIF(m.role, ''), 'member') AS role,
                COALESCE(NULLIF(m.status, ''), 'requested') AS status
           FROM site_memberships m
          WHERE m.user_id=$1
          ORDER BY COALESCE(${siteExpr}, '') ASC`,
        [user_id],
      );
      memberships = mr.rows || [];
    } catch {
      memberships = [];
    }

    return res.json({
      id: row.id,
      email: row.email,
      // Legacy field kept for old clients; represents current Work Site display.
      site: row.site || null,
      workSite: row.work_site_id
        ? { id: Number(row.work_site_id), name: String(row.work_site_name || row.site || '') }
        : (row.site ? { id: 0, name: String(row.site) } : null),
      subscribedSite: row.primary_site_id
        ? { id: Number(row.primary_site_id), name: String(row.subscribed_site_name || '') }
        : null,
      name: row.name || null,
      community_state: row.community_state || null,
      is_admin: !!row.is_admin,
      memberships,
      termsAccepted: !!row.terms_accepted_at,
      termsAcceptedAt: row.terms_accepted_at || null,
      termsVersion: row.terms_version || null,
    });
  } catch (err) {
    console.error('GET /user/me failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function normWorkSiteName(s: any): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Get current Work Site + history
router.get('/work-site', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const ur = await pool.query(
      `SELECT u.work_site_id,
              u.community_state, ws.name_display AS work_site_name
         FROM users u
         LEFT JOIN work_sites ws ON ws.id=u.work_site_id
        WHERE u.id=$1`,
      [user_id],
    );
    const current = ur.rows?.[0]?.work_site_id
      ? { id: Number(ur.rows[0].work_site_id), name: String(ur.rows[0].work_site_name || '') }
      : null;

    const hr = await pool.query(
      `SELECT h.id, h.start_date::text AS start_date, h.end_date::text AS end_date, ws.name_display AS name
         FROM user_work_site_history h
         JOIN work_sites ws ON ws.id=h.work_site_id
        WHERE h.user_id=$1
        ORDER BY h.start_date DESC, h.id DESC
        LIMIT 100`,
      [user_id],
    );
    return res.json({ current, history: hr.rows || [] });
  } catch {
    return res.json({ current: null, history: [] });
  }
});

// Set current Work Site (and write history). This does NOT change Subscribed Site.
router.post('/work-site', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  try {
    let work_site_id = Number(req.body?.work_site_id || 0) || null;
    const name = String(req.body?.work_site_name || req.body?.name || '').trim();
    const state = req.body?.state ? String(req.body.state).trim() : null;

    if (!work_site_id && !name) return res.status(400).json({ error: 'work_site_id or work_site_name required' });

    // Allow creating/selecting by name
    if (!work_site_id && name) {
      const normalized = normWorkSiteName(name);
      const r = await pool.query(
        `INSERT INTO work_sites (name_display, name_normalized, state, is_official, created_by_user_id)
         VALUES ($1,$2,$3,FALSE,$4)
         ON CONFLICT (name_normalized) DO UPDATE
           SET name_display = COALESCE(NULLIF(work_sites.name_display,''), EXCLUDED.name_display)
         RETURNING id, name_display, is_official`,
        [name, normalized, state, user_id],
      );
      work_site_id = Number(r.rows?.[0]?.id || 0) || null;
    }

    // Fetch display name
    const ws = await pool.query('SELECT id, name_display FROM work_sites WHERE id=$1', [work_site_id]);
    const display = String(ws.rows?.[0]?.name_display || '').trim();
    if (!display) return res.status(400).json({ error: 'work_site_not_found' });

    // Close any open history segment
    await pool.query(
      `UPDATE user_work_site_history
          SET end_date = CURRENT_DATE - 1
        WHERE user_id=$1 AND end_date IS NULL AND work_site_id <> $2`,
      [user_id, work_site_id],
    );
    // Ensure an open segment for this site
    await pool.query(
      `INSERT INTO user_work_site_history (user_id, work_site_id, start_date)
       SELECT $1,$2,CURRENT_DATE
        WHERE NOT EXISTS (
          SELECT 1 FROM user_work_site_history
           WHERE user_id=$1 AND work_site_id=$2 AND end_date IS NULL
        )`,
      [user_id, work_site_id],
    );

    // Update user record. We also mirror the display into legacy users.site for existing reports.
    await pool.query('UPDATE users SET work_site_id=$1, site=$2 WHERE id=$3', [work_site_id, display, user_id]);

    return res.json({ ok: true, workSite: { id: work_site_id, name: display } });
  } catch (e: any) {
    console.error('POST /user/work-site failed', e?.message || e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// List of official sites (for request-to-join dropdown)
router.get('/sites', authMiddleware, async (_req: any, res) => {
  try {
    let rows = await listAdminSites();
    // Fallback for older DBs where admin_sites is empty: backfill it from distinct
    // site names seen in users / site_memberships so returned IDs are real FK targets.
    if (!rows.length) {
      const seed = await pool.query(
        `SELECT DISTINCT TRIM(name) AS name
           FROM (
             SELECT site AS name FROM users WHERE site IS NOT NULL AND TRIM(site) <> ''
             UNION
             SELECT COALESCE(site_name, site) AS name FROM site_memberships WHERE COALESCE(site_name, site) IS NOT NULL AND TRIM(COALESCE(site_name, site)) <> ''
           ) t
          WHERE TRIM(name) <> ''`,
      );
      await adminSitesInsertNames((seed.rows || []).map((x: any) => String(x.name || '').trim()));
      rows = await listAdminSites();
    }
    return res.json({ sites: rows.map((x: any) => ({ id: Number(x.id || 0), name: String(x.name) })) });
  } catch {
    return res.json({ sites: [] });
  }
});


// Set current active Subscribed Site (drives site-level assets / dashboards).
// NOTE: This is NOT the user's Work Site.
router.post('/active-site', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const site_id = Number(req.body?.site_id || 0);

    // allow clearing
    if (!site_id) {
      await pool.query('UPDATE users SET primary_admin_site_id = NULL, primary_site_id = NULL WHERE id=$1', [user_id]);
      return res.json({ ok: true, subscribedSite: null });
    }

    // must be an active membership for this site
    const cols = await tableColumns('site_memberships');
    const siteExpr = cols.has('site_name')
      ? 'm.site_name'
      : cols.has('site')
        ? 'm.site'
        : "''";
    const mr = await pool.query(
      `SELECT ${siteExpr} AS name
         FROM site_memberships m
        WHERE m.user_id=$1 AND m.site_id=$2 AND COALESCE(NULLIF(m.status,''),'requested')='active'
        LIMIT 1`,
      [user_id, site_id],
    );
    const name = String(mr.rows?.[0]?.name || '').trim();
    if (!name) return res.status(403).json({ error: 'not_a_member' });

    await pool.query('UPDATE users SET primary_admin_site_id=$1, primary_site_id=$1 WHERE id=$2', [site_id, user_id]);
    return res.json({ ok: true, subscribedSite: { id: site_id, name } });
  } catch (err) {
    console.error('POST /user/active-site failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get site equipment/locations for the user's active site membership.
// This is merged on the client with the user's personal lists so non-members still have their own.
router.get('/site-assets', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    // Prefer numeric site_id when available, because some DBs do not store admin_* rows
    // with a text "site" column.
    const siteIdFromQuery = Number(req.query?.site_id || 0) || null;
    let siteId: number | null = siteIdFromQuery;
    let site = String(req.query?.site || '').trim();

    if (!siteId && !site) {
      // Default to current active Subscribed Site (users.primary_site_id)
      const ur = await pool.query(
        `SELECT COALESCE(u.primary_admin_site_id, u.primary_site_id) AS id, s.name AS name
           FROM users u
           LEFT JOIN admin_sites s ON s.id=COALESCE(u.primary_admin_site_id, u.primary_site_id)
          WHERE u.id=$1`,
        [user_id],
      );
      siteId = ur.rows?.[0]?.id ? Number(ur.rows[0].id) : null;
      site = String(ur.rows?.[0]?.name || '').trim();
    }

    // If the user has no primary subscribed site set yet, fall back to their most recent ACTIVE membership.
    // This protects new DBs where users.primary_site_id isn't being set consistently.
    if (!siteId && !site) {
      try {
        const mr = await pool.query(
          `SELECT m.site_id, s.name
             FROM site_memberships m
             JOIN admin_sites s ON s.id=m.site_id
            WHERE m.user_id=$1
              AND COALESCE(NULLIF(m.status,''),'requested')='active'
            ORDER BY COALESCE(m.updated_at, m.created_at, m.requested_at) DESC NULLS LAST, m.id DESC
            LIMIT 1`,
          [user_id],
        );
        siteId = mr.rows?.[0]?.site_id ? Number(mr.rows[0].site_id) : null;
        site = String(mr.rows?.[0]?.name || '').trim();
      } catch {
        // ignore
      }
    }

    if (!siteId && !site) return res.json({ equipment: [], locations: [] });
    if (site === 'default') return res.json({ equipment: [], locations: [] });

    // verify user has an active membership for this Subscribed Site.
    // Different schemas store the site name differently (or not at all).
    const cols = await tableColumns('site_memberships');
    let mr;
    if (siteId && cols.has('site_id')) {
      // Most reliable: validate by numeric site_id.
      mr = await pool.query(
        `SELECT 1
           FROM site_memberships m
          WHERE m.user_id=$1
            AND m.site_id=$2
            AND COALESCE(NULLIF(m.status,''),'requested')='active'
          LIMIT 1`,
        [user_id, siteId],
      );
    } else if (cols.has('site_name') || cols.has('site')) {
      const siteExpr = cols.has('site_name') ? 'm.site_name' : 'm.site';
      mr = await pool.query(
        `SELECT 1
           FROM site_memberships m
          WHERE m.user_id=$1
            AND COALESCE(NULLIF(m.status,''),'requested')='active'
            AND ${siteExpr}=$2
          LIMIT 1`,
        [user_id, site],
      );
    } else {
      // Older schema: site_memberships has site_id but no site name column.
      // Join to admin_sites to validate membership by site name.
      mr = await pool.query(
        `SELECT 1
           FROM site_memberships m
           JOIN admin_sites s ON s.id=m.site_id
          WHERE m.user_id=$1
            AND COALESCE(NULLIF(m.status,''),'requested')='active'
            AND s.name=$2
          LIMIT 1`,
        [user_id, site],
      );
    }
    if (!mr?.rows?.length) {
      // Fallback: if the user is currently scoped to this site (users.primary_site_id),
      // allow access even if the membership row is missing/mis-shaped in older DBs.
      // This fixes local/dev DBs that were reset mid-migration where primary_site_id is
      // correctly set but site_memberships is missing/incorrect.
      const scoped = await pool.query(
        `SELECT 1
           FROM users u
           JOIN admin_sites s ON s.id=COALESCE(u.primary_admin_site_id, u.primary_site_id)
          WHERE u.id=$1 AND s.name=$2
          LIMIT 1`,
        [user_id, site],
      );
      if (!scoped.rows?.length) return res.json({ equipment: [], locations: [], restricted: true });
    }

    // admin_equipment uses equipment_id (not name). Alias it to name for client-side consistency.
    // admin_equipment may be equipment_id (newer) or name (older). Also, the site scoping column
    // differs between DBs (site/admin_site_id/site_id). We detect it at runtime.
    const aecols = await tableColumns('admin_equipment');
    const eqWhere = siteId && (aecols.has('admin_site_id') || aecols.has('site_id'))
      ? (aecols.has('admin_site_id') ? 'admin_site_id=$1' : 'site_id=$1')
      : 'site=$1';
    const eqArg = siteId && eqWhere !== 'site=$1' ? siteId : site;

    let er;
    try {
      er = await pool.query(
        `SELECT id, equipment_id AS name, type
           FROM admin_equipment
          WHERE ${eqWhere}
          ORDER BY equipment_id ASC`,
        [eqArg],
      );
    } catch (e: any) {
      if (String(e?.code) !== '42703') throw e;
      er = await pool.query(
        `SELECT id, name, type
           FROM admin_equipment
          WHERE ${eqWhere}
          ORDER BY name ASC`,
        [eqArg],
      );
    }

    // admin_locations may be name (newer) or location_id (older). Site scoping column differs too.
    const alcols = await tableColumns('admin_locations');
    const locWhere = siteId && (alcols.has('admin_site_id') || alcols.has('site_id'))
      ? (alcols.has('admin_site_id') ? 'admin_site_id=$1' : 'site_id=$1')
      : 'site=$1';
    const locArg = siteId && locWhere !== 'site=$1' ? siteId : site;

    let lr;
    try {
      lr = await pool.query(
        `SELECT id, name, type
           FROM admin_locations
          WHERE ${locWhere}
          ORDER BY name ASC`,
        [locArg],
      );
    } catch (e: any) {
      if (String(e?.code) !== '42703') throw e;
      lr = await pool.query(
        `SELECT id, location_id AS name, type
           FROM admin_locations
          WHERE ${locWhere}
          ORDER BY location_id ASC`,
        [locArg],
      );
    }

    return res.json({ site: siteId ? { id: siteId, name: site } : site ? { id: null, name: site } : null, equipment: er.rows || [], locations: lr.rows || [] });
  } catch (err) {
    console.error('GET /user/site-assets failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// Request to join a site (member by default)
router.post('/site-requests', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const site_id = Number(req.body?.site_id || 0);
    // Requests to join a site are always "member".
    // Role promotion (validator/admin) is managed by the site's admins after approval.
    const role = 'member';
    const consentVersion = String(req.body?.site_consent_version || '').trim();
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const siteName = await adminSitesSelectNameById(site_id);
    if (!siteName) return res.status(400).json({ error: 'site_not_found' });

    const mcols = await tableColumns('site_memberships');
    // Note: different DBs have different columns on site_memberships.
    // We always write user_id/site_id/role and set status/requested_at via literals.
    const cols: string[] = ['user_id', 'site_id', 'role', 'status', 'requested_at'];
    const vals: any[] = [user_id, site_id, role];

    // optional columns depending on schema
    if (mcols.has('site_name')) {
      cols.splice(2, 0, 'site_name');
      vals.splice(2, 0, siteName);
    }
    if (mcols.has('site')) {
      cols.splice(2, 0, 'site');
      vals.splice(2, 0, siteName);
    }


    if (consentVersion && mcols.has('site_consent_version')) {
      cols.push('site_consent_version');
      vals.push(consentVersion);
    }
    if (consentVersion && mcols.has('site_consent_accepted_at')) {
      cols.push('site_consent_accepted_at');
      // accepted_at uses now() literal in the values builder
    }

    // rebuild placeholders in order
    const valueParts: string[] = [];
    let idx = 1;
    for (const c of cols) {
      if (c === 'status') valueParts.push(`'requested'`);
      else if (c === 'requested_at') valueParts.push('now()');
      else if (c === 'site_consent_accepted_at') valueParts.push('now()');
      else {
        valueParts.push(`$${idx}`);
        idx++;
      }
    }

    const insertSql = `INSERT INTO site_memberships (${cols.join(', ')})\n       VALUES (${valueParts.join(', ')})`;

    // Prefer upsert if a suitable unique constraint exists. If not, fall back to delete+insert.
    try {
      const updateSets: string[] = ["role=EXCLUDED.role", "status='requested'", 'requested_at=now()'];

      if (consentVersion) {
        if (mcols.has('site_consent_version')) {
          updateSets.push('site_consent_version=EXCLUDED.site_consent_version');
        }
        if (mcols.has('site_consent_accepted_at')) {
          updateSets.push('site_consent_accepted_at=COALESCE(EXCLUDED.site_consent_accepted_at, site_memberships.site_consent_accepted_at)');
        }
      }

      await pool.query(
        `${insertSql}
       ON CONFLICT (user_id, site_id)
       DO UPDATE SET ${updateSets.join(', ')}`,
        vals,
      );
    } catch (e: any) {
      if (String(e?.code) === '42P10') {
        // no unique constraint matching the ON CONFLICT, do a deterministic replace
        await pool.query('DELETE FROM site_memberships WHERE user_id=$1 AND site_id=$2', [user_id, site_id]);
        await pool.query(insertSql, vals);
      } else if (String(e?.code) === '42703') {
        // schema mismatch: retry without site/site_name columns and let the DB defaults handle it
        const basicCols = ['user_id', 'site_id', 'role', 'status', 'requested_at'];
        const basicSql = `INSERT INTO site_memberships (${basicCols.join(', ')}) VALUES ($1,$2,$3,'requested',now())`;
        await pool.query(basicSql, [user_id, site_id, role]);
      } else {
        throw e;
      }
    }

    // Best-effort: set primary_site_id if empty
    try {
      await pool.query(
        'UPDATE users SET primary_admin_site_id = COALESCE(primary_admin_site_id, $2), primary_site_id = COALESCE(primary_site_id, $2) WHERE id=$1',
        [user_id, site_id],
      );
    } catch {
      // ignore
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /user/site-requests failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Leave a site (revokes membership)
router.post('/memberships/leave', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const site_id = Number(req.body?.site_id || 0);
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const siteName = await adminSitesSelectNameById(site_id);
    if (!siteName) return res.status(400).json({ error: 'site_not_found' });


    await pool.query(
      `UPDATE site_memberships
          SET status='left'
        WHERE user_id=$1 AND site_id=$2`,
      [user_id, site_id],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /user/memberships/leave failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/me', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  const nextEmail = req.body?.email != null ? normaliseEmail(req.body.email) : null;
  const nextSite = req.body?.site != null ? String(req.body.site).trim() : null;
  const nextCommunityState = req.body?.community_state != null ? String(req.body.community_state).trim().toUpperCase() : null;
  const currentPassword = req.body?.current_password ? String(req.body.current_password) : '';
  const newPassword = req.body?.new_password ? String(req.body.new_password) : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      'SELECT id, email, site, password_hash, is_admin FROM users WHERE id=$1 FOR UPDATE',
      [user_id],
    );
    const user = u.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }

    if (newPassword) {
      if (!currentPassword) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'current password required' });
      }
      if (!bcrypt.compareSync(currentPassword, String(user.password_hash || ''))) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'current password incorrect' });
      }
      if (newPassword.length < 6) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'password too short' });
      }
    }


    // Validate community_state (AU state) if provided. This is used for public Community stats fallback
    // when geo region headers are unavailable.
    const allowedStates = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT', 'UNK']);
    const cleanedState =
      nextCommunityState && nextCommunityState !== '' ? nextCommunityState.replace(/[^A-Z]/g, '') : null;
    if (cleanedState && !allowedStates.has(cleanedState)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid community_state' });
    }
    if (nextEmail && nextEmail !== user.email) {
      const check = await client.query('SELECT id FROM users WHERE email=$1 AND id<>$2', [
        nextEmail,
        user_id,
      ]);
      if (check.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'email already in use' });
      }
    }

    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (nextEmail && nextEmail !== user.email) {
      updates.push(`email=$${i++}`);
      params.push(nextEmail);
    }
    if (nextSite !== null) {
      updates.push(`site=$${i++}`);
      params.push(nextSite || null);
    }

    if (cleanedState !== null) {
      updates.push(`community_state=$${i++}`);
      params.push(cleanedState === 'UNK' ? null : cleanedState);
    }
    if (newPassword) {
      updates.push(`password_hash=$${i++}`);
      params.push(bcrypt.hashSync(newPassword, 10));
    }

    if (updates.length > 0) {
      params.push(user_id);
      await client.query(`UPDATE users SET ${updates.join(', ')} WHERE id=$${i}`, params);
    }

    const fresh = await client.query('SELECT id, email, site, is_admin, community_state FROM users WHERE id=$1', [
      user_id,
    ]);
    await client.query('COMMIT');

    const f = fresh.rows[0];
    const token = tokenFor(f);
    return res.json({ ok: true, token, me: { email: f.email, site: f.site || null, community_state: f.community_state || null } });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (String(err?.code) === '23505') {
      return res.status(400).json({ error: 'email already in use' });
    }
    console.error('PATCH /user/me failed', err);
    return res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

router.get('/search', async (req, res) => {
  try {
    const name = String((req.query.name as string) || '').trim();
    if (!name) return res.json({ items: [] });
    const like = `%${name}%`;
    const r = await pool.query(
      'SELECT id, name, email FROM users WHERE name ILIKE $1 ORDER BY name LIMIT 50',
      [like],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('user search failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});


router.post('/terms/accept', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const version = String(req.body?.version || 'v1').trim() || 'v1';
    await pool.query(
      'UPDATE users SET terms_accepted_at=now(), terms_version=$2 WHERE id=$1',
      [user_id, version],
    );
    return res.json({ ok: true, termsAccepted: true, termsVersion: version });
  } catch (err) {
    console.error('POST /user/terms/accept failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Site membership invites (2-way consent) ----
// When a site-admin "adds" a user via /SiteAdmin/People, we create a membership with status='invited'.
// The invited user must accept before it becomes active.
router.get('/site-invites', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const cols = await tableColumns('site_memberships');
    const siteExpr = cols.has('site_name')
      ? 'm.site_name'
      : cols.has('site')
        ? 'm.site'
        : "''";
    const r = await pool.query(
      `SELECT
         m.id,
         COALESCE(${siteExpr}, '') as site,
         COALESCE(m.role,'member') as role,
         COALESCE(m.status,'') as status,
         m.requested_at
       FROM site_memberships m
       WHERE m.user_id=$1 AND m.status='invited'
       ORDER BY m.requested_at DESC NULLS LAST, m.id DESC`,
      [user_id],
    );
    return res.json({ ok: true, invites: r.rows || [] });
  } catch (err) {
    console.error('GET /user/site-invites failed', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/site-invites/respond', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const membership_id = Number(req.body?.membership_id || 0);
    const accept = !!req.body?.accept;
    const consentVersion = String(req.body?.site_consent_version || '').trim();

    if (!membership_id) return res.status(400).json({ ok: false, error: 'missing membership_id' });

    const m = await pool.query(
      `SELECT id, status
         FROM site_memberships
        WHERE id=$1 AND user_id=$2`,
      [membership_id, user_id],
    );
    if (!m.rows?.[0]) return res.status(404).json({ ok: false, error: 'invite not found' });

    const status = String(m.rows[0].status || '');
    if (status !== 'invited') {
      return res.status(400).json({ ok: false, error: 'not_invited' });
    }

    if (accept) {
      const cols = await tableColumns('site_memberships');
      const sets: string[] = ["status='active'", 'approved_at=NOW()', 'approved_by=NULL'];
      const params: any[] = [membership_id, user_id];
      let pidx = 3;

      if (consentVersion) {
        if (cols.has('site_consent_accepted_at')) {
          sets.push('site_consent_accepted_at = COALESCE(site_consent_accepted_at, NOW())');
        }
        if (cols.has('site_consent_version')) {
          sets.push(`site_consent_version = COALESCE(site_consent_version, $${pidx})`);
          params.push(consentVersion);
          pidx++;
        }
      }

      try {
        await pool.query(
          `UPDATE site_memberships
              SET ${sets.join(', ')}
            WHERE id=$1 AND user_id=$2`,
          params,
        );
      } catch (e: any) {
        if (String(e?.code) === '42703') {
          // older schema without consent columns
          await pool.query(
            `UPDATE site_memberships
                SET status='active', approved_at=NOW(), approved_by=NULL
              WHERE id=$1 AND user_id=$2`,
            [membership_id, user_id],
          );
        } else {
          throw e;
        }
      }

      return res.json({ ok: true, status: 'active' });
    }

    await pool.query(
      `UPDATE site_memberships
          SET status='declined'
        WHERE id=$1 AND user_id=$2`,
      [membership_id, user_id],
    );
    return res.json({ ok: true, status: 'declined' });
  } catch (err) {
    console.error('POST /user/site-invites/respond failed', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;