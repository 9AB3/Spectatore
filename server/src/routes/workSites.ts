import express from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

function tryGetUserId(req: any): number | null {
  try {
    const h = String(req.headers?.authorization || '');
    if (!h.toLowerCase().startsWith('bearer ')) return null;
    const token = h.slice(7).trim();
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const id = Number(decoded?.user_id || decoded?.id || 0);
    return id || null;
  } catch {
    return null;
  }
}


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

    let r;
    if (q) {
      // Authenticated users can search all work sites; unauthenticated only see official/synced ones.
      const where = authedUserId
        ? `WHERE (is_official = true OR created_by_user_id = $2) AND (name_normalized LIKE $1 || '%' OR name_normalized LIKE '%' || $1 || '%')`
        : `WHERE (is_official = true OR official_site_id IS NOT NULL)
             AND (name_normalized LIKE $1 || '%' OR name_normalized LIKE '%' || $1 || '%')`;
      r = await pool.query(
        `SELECT id, name_display, is_official, official_site_id, created_by_user_id
           FROM work_sites
          ${where}
          ORDER BY is_official DESC, name_display ASC
          LIMIT 200`,
        authedUserId ? [q, authedUserId] : [q],
      );
    } else {
      // No query: authenticated users get broader list; unauthenticated get curated official list.
      const where = authedUserId
        ? 'WHERE (is_official = true OR created_by_user_id = $1)'
        : 'WHERE (is_official = true OR official_site_id IS NOT NULL)';
      r = await pool.query(
        `SELECT id, name_display, is_official, official_site_id, created_by_user_id
           FROM work_sites
          ${where}
          ORDER BY is_official DESC, name_display ASC
          LIMIT 200`,
      );
    }
    return res.json({ sites: (r.rows || []).map((x: any) => ({ id: Number(x.id), name: String(x.name_display), is_official: !!x.is_official })) });
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
