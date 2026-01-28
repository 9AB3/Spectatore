import express from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

const router = express.Router();

function getOptionalUserId(req: any): number | null {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(String(h));
  if (!m) return null;
  try {
    const payload: any = jwt.verify(m[1], JWT_SECRET);
    const id = Number(payload?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function normName(s: any): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// GET /api/work-sites?q=
// Public (no auth) so the Register page can offer suggestions.
router.get('/', async (req, res) => {
  try {
    const qRaw = String(req.query?.q || '').trim();
    const q = normName(qRaw);
    const authedUserId = getOptionalUserId(req);

    // IMPORTANT:
    // - "Official" sites live in admin_sites.
    // - User-created (non-official) sites live in work_sites (created_by_user_id).
    // - We also include any legacy official entries stored in work_sites (is_official / official_site_id).
    // The dropdowns only really need names, but we still return a numeric id.

    const like = q ? q : '';
    const params: any[] = [];
    let where = '';

    if (q) {
      // Use LIKE against a normalized expression for admin_sites, and name_normalized for work_sites.
      where = `WHERE (name_normalized LIKE $1 || '%' OR name_normalized LIKE '%' || $1 || '%')`;
      params.push(like);
    }

    // Note: admin_sites doesn't have name_normalized in all DBs; we derive it on the fly.
    // We de-duplicate by normalized name so the same site doesn't appear twice.
    const userId = authedUserId ? Number(authedUserId) : 0;
    const includeUser = !!authedUserId;

    const r = await pool.query(
      `WITH all_sites AS (
          -- 1) Official sites
          SELECT (100000000 + a.id)::bigint AS id,
                 a.name AS name_display,
                 LOWER(TRIM(REGEXP_REPLACE(a.name, '\\s+', ' ', 'g'))) AS name_normalized,
                 TRUE AS is_official
            FROM admin_sites a

          UNION ALL

          -- 2) Legacy official/synced work_sites
          SELECT ws.id::bigint AS id,
                 ws.name_display,
                 ws.name_normalized,
                 TRUE AS is_official
            FROM work_sites ws
           WHERE (ws.is_official = true OR ws.official_site_id IS NOT NULL)

          UNION ALL

          -- 3) User-created work sites (only for authenticated users)
          SELECT ws.id::bigint AS id,
                 ws.name_display,
                 ws.name_normalized,
                 FALSE AS is_official
            FROM work_sites ws
           WHERE ($2::int > 0) AND ws.created_by_user_id = $2
        ),
        dedup AS (
          SELECT DISTINCT ON (name_normalized)
                 id, name_display, name_normalized, is_official
            FROM all_sites
           WHERE name_normalized IS NOT NULL AND TRIM(name_normalized) <> ''
           ORDER BY name_normalized, is_official DESC, name_display ASC, id ASC
        )
        SELECT id, name_display, is_official
          FROM dedup
          ${where}
         ORDER BY is_official DESC, name_display ASC
         LIMIT 400`,
      q ? [like, userId] : ['', userId],
    );

    return res.json({
      sites: (r.rows || []).map((x: any) => ({
        id: Number(x.id),
        name: String(x.name_display),
        is_official: !!x.is_official,
      })),
    });
  } catch (e: any) {
    return res.json({ sites: [] });
  }
});

// POST /api/work-sites
// Authenticated creation for signed-in users (Profile/Settings).
router.post('/', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const name = String(req.body?.name || req.body?.name_display || '').trim();
    const state = req.body?.state ? String(req.body.state).trim() : null;
    const country = req.body?.country ? String(req.body.country).trim() : null;
    const company = req.body?.company ? String(req.body.company).trim() : null;

    if (!name) return res.status(400).json({ error: 'name required' });
    const normalized = normName(name);

    const r = await pool.query(
      `INSERT INTO work_sites (name_display, name_normalized, state, country, company, is_official, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6)
       ON CONFLICT (name_normalized) DO UPDATE
         SET name_display = COALESCE(NULLIF(work_sites.name_display,''), EXCLUDED.name_display)
       RETURNING id, name_display, is_official`,
      [name, normalized, state, country, company, user_id],
    );

    const row = r.rows?.[0];
    return res.json({ ok: true, site: { id: Number(row.id), name: String(row.name_display), is_official: !!row.is_official } });
  } catch (e: any) {
    return res.status(500).json({ error: 'failed' });
  }
});

export default router;
