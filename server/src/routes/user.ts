import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

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
      'SELECT id, email, site, is_admin, name, terms_accepted_at, terms_version FROM users WHERE id=$1',
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
      const mr = await pool.query(
        `SELECT m.id,
                m.site_id,
                COALESCE(m.site_name, m.site, '') AS site,
                COALESCE(NULLIF(m.role, ''), 'member') AS role,
                COALESCE(NULLIF(m.status, ''), 'requested') AS status
           FROM site_memberships m
          WHERE m.user_id=$1
          ORDER BY COALESCE(m.site_name, m.site, '') ASC`,
        [user_id],
      );
      memberships = mr.rows || [];
    } catch {
      memberships = [];
    }

    if (!memberships.length && row.site) {
      memberships = [
        {
          id: 0,
          site_id: null,
          site: String(row.site),
          role: 'member',
          status: 'active',
        },
      ];
    }
    return res.json({
      id: row.id,
      email: row.email,
      site: row.site || null,
      name: row.name || null,
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


// Set current active site (drives filtering / dashboards)
router.post('/active-site', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const site_id = Number(req.body?.site_id || 0);

    // allow clearing
    if (!site_id) {
      // users.site is NOT NULL in our schema; treat "Personal" as the default site.
      await pool.query("UPDATE users SET site='default' WHERE id=$1", [user_id]);
      return res.json({ ok: true, site: null });
    }

    // must be an active membership for this site
    const mr = await pool.query(
      `SELECT COALESCE(m.site_name, m.site) AS name
         FROM site_memberships m
        WHERE m.user_id=$1 AND m.site_id=$2 AND COALESCE(NULLIF(m.status,''),'requested')='active'
        LIMIT 1`,
      [user_id, site_id],
    );
    const name = String(mr.rows?.[0]?.name || '').trim();
    if (!name) return res.status(403).json({ error: 'not_a_member' });

    await pool.query('UPDATE users SET site=$1 WHERE id=$2', [name, user_id]);
    return res.json({ ok: true, site: name });
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
    const site = String(req.query?.site || '').trim();
    if (!site) return res.json({ equipment: [], locations: [] });
    if (site === 'default') return res.json({ equipment: [], locations: [] });

    // verify user has an active membership for this site name (or legacy users.site)
    const vr = await pool.query(
      `SELECT 1
         FROM users u
        WHERE u.id=$1 AND COALESCE(NULLIF(u.site,''),'')=$2
        LIMIT 1`,
      [user_id, site],
    );
    if (!vr.rows?.length) {
      const mr = await pool.query(
        `SELECT 1
           FROM site_memberships m
          WHERE m.user_id=$1
            AND COALESCE(NULLIF(m.status,''),'requested')='active'
            AND COALESCE(m.site_name, m.site)=$2
          LIMIT 1`,
        [user_id, site],
      );
      if (!mr.rows?.length) return res.status(403).json({ error: 'not_a_member' });
    }

    // admin_equipment uses equipment_id (not name). Alias it to name for client-side consistency.
    const er = await pool.query(
      `SELECT id, equipment_id AS name, type
         FROM admin_equipment
        WHERE site=$1
        ORDER BY equipment_id ASC`,
      [site],
    );
    const lr = await pool.query(
      `SELECT id, name, type
         FROM admin_locations
        WHERE site=$1
        ORDER BY name ASC`,
      [site],
    );

    return res.json({ equipment: er.rows || [], locations: lr.rows || [] });
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
    const roleRaw = String(req.body?.role || 'member').toLowerCase();
    const role = roleRaw === 'admin' || roleRaw === 'validator' ? roleRaw : 'member';
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const siteName = await adminSitesSelectNameById(site_id);
    if (!siteName) return res.status(400).json({ error: 'site_not_found' });


    await pool.query(
      `INSERT INTO site_memberships (user_id, site_id, site, site_name, role, status, requested_at)
       VALUES ($1, $2, $3, $3, $4, 'requested', now())
       ON CONFLICT (user_id, site_id)
       DO UPDATE SET role=EXCLUDED.role, status='requested', requested_at=now()`,
      [user_id, site_id, siteName, role],
    );

    // Best-effort: set primary_site_id if empty
    try {
      await pool.query(
        'UPDATE users SET primary_site_id = COALESCE(primary_site_id, $2) WHERE id=$1',
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
    if (newPassword) {
      updates.push(`password_hash=$${i++}`);
      params.push(bcrypt.hashSync(newPassword, 10));
    }

    if (updates.length > 0) {
      params.push(user_id);
      await client.query(`UPDATE users SET ${updates.join(', ')} WHERE id=$${i}`, params);
    }

    const fresh = await client.query('SELECT id, email, site, is_admin FROM users WHERE id=$1', [
      user_id,
    ]);
    await client.query('COMMIT');

    const f = fresh.rows[0];
    const token = tokenFor(f);
    return res.json({ ok: true, token, me: { email: f.email, site: f.site || null } });
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
    const r = await pool.query(
      `SELECT
         m.id,
         COALESCE(m.site_name, m.site, '') as site,
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
      await pool.query(
        `UPDATE site_memberships
            SET status='active', approved_at=NOW(), approved_by=NULL
          WHERE id=$1 AND user_id=$2`,
        [membership_id, user_id],
      );
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