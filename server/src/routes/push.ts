import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

/**
 * POST /api/push/subscribe
 * body: PushSubscription-like
 * {
 *   endpoint: string,
 *   keys: { p256dh: string, auth: string }
 * }
 *
 * Important:
 * - De-dupe by (user_id, endpoint) (not just endpoint)
 * - Avoid moving subscriptions between users
 */
router.post('/subscribe', authMiddleware, async (req: any, res) => {
  try {
    const user_id = Number(req.user_id);
    if (!user_id) return res.status(401).json({ error: 'unauthorized' });

    const sub = req.body || {};
    const endpoint = String(sub?.endpoint || '').trim();
    const p256dh = String(sub?.keys?.p256dh || '').trim();
    const auth = String(sub?.keys?.auth || '').trim();

    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }

    // If this endpoint is already owned by a DIFFERENT user, delete it first.
    // This prevents "endpoint re-used" causing duplicates / weird cross-user updates.
    await pool.query(
      `DELETE FROM push_subscriptions
        WHERE endpoint=$1 AND user_id<>$2`,
      [endpoint, user_id],
    );

    // Upsert on (user_id, endpoint)
    // NOTE: requires a UNIQUE constraint on (user_id, endpoint) ideally.
    // If you don't have it yet, create it:
    //   ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_user_endpoint_uniq UNIQUE (user_id, endpoint);
    await pool.query(
      `
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, endpoint)
      DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth
      `,
      [user_id, endpoint, p256dh, auth],
    );

    // OPTIONAL: If you want "one device per user" (prevents duplicates on same machine):
    // await pool.query(
    //   `DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint<>$2`,
    //   [user_id, endpoint],
    // );

    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[push] subscribe failed', e?.message || e);
    return res.status(500).json({ error: 'subscribe failed' });
  }
});

/**
 * POST /api/push/unsubscribe
 * body: { endpoint }
 */
router.post('/unsubscribe', authMiddleware, async (req: any, res) => {
  try {
    const user_id = Number(req.user_id);
    if (!user_id) return res.status(401).json({ error: 'unauthorized' });

    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });

    const r = await pool.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [user_id, endpoint],
    );

    return res.json({ ok: true, deleted: r.rowCount });
  } catch (e: any) {
    console.error('[push] unsubscribe failed', e?.message || e);
    return res.status(500).json({ error: 'unsubscribe failed' });
  }
});

export default router;
