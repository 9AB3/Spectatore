import express from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

const router = express.Router();

// ---- schema helpers (support older DB variants) ----
let _colsCache: Record<string, Set<string>> = {};
let _adminSitesNameCol: 'name' | 'site' | null = null;

async function tableColumns(table: string): Promise<Set<string>> {
  if (_colsCache[table]) return _colsCache[table];
  let set = new Set<string>();
  try {
    const r = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name=$1`,
      [table],
    );
    set = new Set<string>((r.rows || []).map((x: any) => String(x.column_name)));
  } catch {
    // fail soft
    set = new Set<string>();
  }
  _colsCache[table] = set;
  return set;
}

async function adminSitesNameColumn(): Promise<'name' | 'site'> {
  if (_adminSitesNameCol) return _adminSitesNameCol;
  const cols = await tableColumns('admin_sites');
  // Default to 'name' if unsure.
  _adminSitesNameCol = cols.has('site') && !cols.has('name') ? 'site' : 'name';
  return _adminSitesNameCol;
}

async function tableExists(table: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name=$1
        LIMIT 1`,
      [table],
    );
    return (r.rows || []).length > 0;
  } catch {
    return false;
  }
}

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

    // We intentionally do this in 2 simple queries + JS merge.
    // Reason: some deployments have subtle schema differences and SQL errors were being swallowed,
    // leaving the dropdown with only "Not in List".

    // admin_sites may have either `name` (newer) or `site` (legacy) as the display column.
    // Also: some environments may not have the table (or permissions), so fail soft.
    const hasAdminSites = await tableExists('admin_sites');
    const adminNameCol = hasAdminSites ? await adminSitesNameColumn() : 'name';

    let official: any = { rows: [] };
    if (hasAdminSites) {
      try {
        official = await pool.query(
          `SELECT id, ${adminNameCol} AS name
             FROM public.admin_sites
            ORDER BY ${adminNameCol} ASC`,
        );
      } catch (e: any) {
        console.error('[work-sites] admin_sites query failed', e?.message || e);
        official = { rows: [] };
      }
    }

    const userId = authedUserId ? Number(authedUserId) : 0;
    let createdByMe: any = { rows: [] };
    if (userId) {
      try {
        createdByMe = await pool.query(
          `SELECT id, name_display AS name
             FROM public.work_sites
            WHERE created_by_user_id = $1
            ORDER BY name_display ASC`,
          [userId],
        );
      } catch (e: any) {
        console.error('[work-sites] work_sites(created_by_user_id) query failed', e?.message || e);
        createdByMe = { rows: [] };
      }
    }

    let legacyOfficial: any = { rows: [] };
    try {
      legacyOfficial = await pool.query(
        `SELECT id, name_display AS name
           FROM public.work_sites
          WHERE (is_official = true OR official_site_id IS NOT NULL)
          ORDER BY name_display ASC`,
      );
    } catch (e: any) {
      console.error('[work-sites] work_sites(legacy official) query failed', e?.message || e);
      legacyOfficial = { rows: [] };
    }

    // Merge + dedupe by normalized name
    const seen = new Set<string>();
    const out: Array<{ id: number; name: string; is_official: boolean }> = [];

    function add(rows: any[], is_official: boolean) {
      for (const r of rows || []) {
        const name = String(r?.name || '').trim();
        if (!name) continue;
        const key = normName(name);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: Number(r.id) || 0, name, is_official });
      }
    }

    add(official.rows, true);
    add(legacyOfficial.rows, true);
    add(createdByMe.rows, false);

    // Optional search filter
    const filtered = q
      ? out.filter((x) => normName(x.name).includes(q))
      : out;

    // Ensure official sites appear first
    filtered.sort((a, b) => {
      if (a.is_official !== b.is_official) return a.is_official ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return res.json({ sites: filtered.slice(0, 400) });
  } catch (e: any) {
    // Fail-soft: the UI can still function with manual entry.
    console.error('[work-sites] failed', e?.message || e);
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
