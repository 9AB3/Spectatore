import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// NOTE: The DB schema stores preferences in a single JSONB column (prefs_json)
// to keep upgrades simple. The API exposes normalized boolean fields.
const DEFAULT_PREFS = {
  // in-app list (bell)
  in_app_milestones: true,
  in_app_crew_requests: true,
  // web-push
  push_milestones: false,
  push_crew_requests: false,
};

function mergePrefs(prefs_json: any) {
  const pj = prefs_json && typeof prefs_json === 'object' ? prefs_json : {};
  const out: any = { ...DEFAULT_PREFS, ...pj };
  // hard boolean normalize (avoid surprises if prefs_json has strings/nulls)
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof typeof DEFAULT_PREFS)[]) {
    out[k] = typeof out[k] === 'boolean' ? out[k] : DEFAULT_PREFS[k];
  }
  return out as typeof DEFAULT_PREFS;
}

// GET /api/notification-preferences/me
router.get('/me', authMiddleware, async (req: any, res) => {
  try {
    const user_id = Number(req.user_id || req.user?.id);
    if (!user_id) return res.status(401).json({ error: 'unauthorized' });

    const r = await pool.query('SELECT user_id, prefs_json FROM notification_preferences WHERE user_id=$1', [user_id]);
    if (r.rows?.[0]) {
      const merged = mergePrefs(r.rows[0].prefs_json);
      return res.json(merged);
    }

    // Create default row if missing
    const ins = await pool.query(
      `INSERT INTO notification_preferences (user_id, prefs_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET prefs_json=notification_preferences.prefs_json
       RETURNING user_id, prefs_json`,
      [user_id, JSON.stringify(DEFAULT_PREFS)],
    );
    return res.json(mergePrefs(ins.rows?.[0]?.prefs_json));
  } catch (err) {
    console.error('notification-preferences me failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// PATCH /api/notification-preferences/me
router.patch('/me', authMiddleware, async (req: any, res) => {
  try {
    const user_id = Number(req.user_id || req.user?.id);
    if (!user_id) return res.status(401).json({ error: 'unauthorized' });

    const allowed = [
      'in_app_milestones',
      'in_app_crew_requests',
      'push_milestones',
      'push_crew_requests',
    ] as const;

    // Load current
    const cur = await pool.query('SELECT prefs_json FROM notification_preferences WHERE user_id=$1', [user_id]);
    const currentMerged = mergePrefs(cur.rows?.[0]?.prefs_json);

    let dirty = false;
    const next: any = { ...currentMerged };
    for (const k of allowed) {
      if (typeof req.body?.[k] === 'boolean') {
        next[k] = Boolean(req.body[k]);
        dirty = true;
      }
    }

    if (!dirty) return res.status(400).json({ error: 'No valid fields' });

    const q = `INSERT INTO notification_preferences (user_id, prefs_json, updated_at)
               VALUES ($1, $2::jsonb, NOW())
               ON CONFLICT (user_id)
               DO UPDATE SET prefs_json=$2::jsonb, updated_at=NOW()
               RETURNING prefs_json`;
    const r = await pool.query(q, [user_id, JSON.stringify(next)]);
    return res.json(mergePrefs(r.rows?.[0]?.prefs_json));
  } catch (err) {
    console.error('notification-preferences patch failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

export default router;
