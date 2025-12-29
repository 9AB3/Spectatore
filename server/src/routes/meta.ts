import { Router } from 'express';
import { pool } from '../lib/pg.js';
const router = Router();

router.get('/status', (_req, res) => {
  res.json({ offline_capable: true, version: '1.0.0' });
});

// Public list of known site names (used for signup dropdown).
router.get('/sites', async (_req, res) => {
  try {
    const r = await pool.query('SELECT name FROM admin_sites ORDER BY name ASC');
    return res.json({ sites: (r.rows || []).map((x: any) => String(x.name)).filter(Boolean) });
  } catch {
    return res.json({ sites: [] });
  }
});

export default router;
