import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

/**
 * POST /api/push/subscribe
 * body: { endpoint, keys: { p256dh, auth } }
 */
router.post('/subscribe', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });

  const sub = req.body || {};
  const endpoint = String(sub.endpoint || '').trim();
  const p256dh = String(sub?.keys?.p256dh || '').trim();
  const auth = String(sub?.keys?.auth || '').trim();

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
      [user_id, endpoint, p256dh, auth],
    );
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[push] subscribe failed', e?.message || e);
    return res.status(400).json({ error: 'subscribe failed' });
  }
});

/**
 * POST /api/push/unsubscribe
 * body: { endpoint }
 */
router.post('/unsubscribe', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });

  const endpoint = String(req.body?.endpoint || '').trim();
  if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });

  try {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [
      user_id,
      endpoint,
    ]);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[push] unsubscribe failed', e?.message || e);
    return res.status(400).json({ error: 'unsubscribe failed' });
  }
});

export default router;
