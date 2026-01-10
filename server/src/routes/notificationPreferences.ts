import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// GET /api/notification-preferences/me
router.get('/me', authMiddleware, async (req: any, res) => {
  try {
    const user_id = Number(req.user_id || req.user?.id);
    if (!user_id) return res.status(401).json({ error: 'unauthorized' });

    const r = await pool.query('SELECT * FROM notification_preferences WHERE user_id=$1', [user_id]);
    if (r.rows?.[0]) return res.json(r.rows[0]);

    // Create default row if missing
    const ins = await pool.query(
      `INSERT INTO notification_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id
       RETURNING *`,
      [user_id],
    );
    return res.json(ins.rows[0]);
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

    const sets: string[] = [];
    const values: any[] = [user_id];
    let idx = 2;

    for (const k of allowed) {
      if (typeof req.body?.[k] === 'boolean') {
        sets.push(`${k}=$${idx++}`);
        values.push(Boolean(req.body[k]));
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });

    const q = `INSERT INTO notification_preferences (user_id)
               VALUES ($1)
               ON CONFLICT (user_id)
               DO UPDATE SET ${sets.join(', ')}, updated_at=NOW()
               RETURNING *`;
    const r = await pool.query(q, values);
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('notification-preferences patch failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

export default router;
