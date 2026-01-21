import express from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = express.Router();

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

    let r;
    if (q) {
      // Prefer prefix match on normalized name, then substring match.
      r = await pool.query(
        `SELECT id, name_display, is_official, official_site_id
           FROM work_sites
          WHERE (is_official = true OR official_site_id IS NOT NULL)
            AND (name_normalized LIKE $1 || '%' OR name_normalized LIKE '%' || $1 || '%')
          ORDER BY is_official DESC, name_display ASC
          LIMIT 25`,
        [q],
      );
    } else {
      // No query: return a small curated list (official first, then alphabetical).
      r = await pool.query(
        `SELECT id, name_display, is_official, official_site_id
           FROM work_sites
          WHERE (is_official = true OR official_site_id IS NOT NULL)
          ORDER BY is_official DESC, name_display ASC
          LIMIT 50`,
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
