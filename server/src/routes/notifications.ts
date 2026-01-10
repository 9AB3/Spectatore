import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// GET /api/notifications
router.get('/', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });

  const limit = Math.min(Math.max(Number(req.query.limit || 50) || 50, 1), 200);
  const onlyUnread = String(req.query.unread || '').toLowerCase() === 'true';

  try {
    const r = await pool.query(
      `SELECT id, type, title, body, payload_json, created_at, read_at
         FROM notifications
        WHERE user_id=$1
          ${onlyUnread ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT $2`,
      [user_id, limit],
    );
    return res.json({ items: r.rows || [] });
  } catch (err) {
    console.error('notifications list failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await pool.query(
      'SELECT COUNT(1)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL',
      [user_id],
    );
    return res.json({ count: Number(r.rows?.[0]?.count || 0) });
  } catch (err) {
    console.error('notifications unread-count failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    await pool.query(
      'UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2',
      [id, user_id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('notifications read failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  try {
    await pool.query(
      'UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL',
      [user_id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('notifications read-all failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// POST /api/notifications/clear-read
// Deletes all *read* notifications for the current user.
router.post('/clear-read', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await pool.query('DELETE FROM notifications WHERE user_id=$1 AND read_at IS NOT NULL', [user_id]);
    return res.json({ ok: true, deleted: Number(r.rowCount || 0) });
  } catch (err) {
    console.error('notifications clear-read failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// POST /api/notifications/clear-all
// Deletes *all* notifications for the current user.
router.post('/clear-all', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await pool.query('DELETE FROM notifications WHERE user_id=$1', [user_id]);
    return res.json({ ok: true, deleted: Number(r.rowCount || 0) });
  } catch (err) {
    console.error('notifications clear-all failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

// DELETE /api/notifications/:id
// Deletes a single notification (useful for swipe-to-dismiss later).
router.delete('/:id', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  if (!user_id) return res.status(401).json({ error: 'unauthorized' });
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const r = await pool.query('DELETE FROM notifications WHERE id=$1 AND user_id=$2', [id, user_id]);
    return res.json({ ok: true, deleted: Number(r.rowCount || 0) });
  } catch (err) {
    console.error('notifications delete failed', err);
    return res.status(500).json({ error: 'db failed' });
  }
});

export default router;
