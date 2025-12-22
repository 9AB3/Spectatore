import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (!req.is_admin) {
    return res.status(403).json({ error: 'Admins only' });
  }
  next();
}

// List all users (basic info + admin flag)
router.get('/users', authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query('SELECT id, email, name, site, state, is_admin FROM users ORDER BY id ASC');
    res.json({ users: r.rows });
  } catch (err) {
    console.error('List users failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/make-admin', authMiddleware, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Make admin failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/remove-admin', authMiddleware, requireAdmin, async (req: any, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.user_id) return res.status(400).json({ error: 'Cannot remove admin from yourself' });
  try {
    await pool.query('UPDATE users SET is_admin=FALSE WHERE id=$1', [userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Remove admin failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', authMiddleware, requireAdmin, async (req: any, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.user_id) return res.status(400).json({ error: 'Cannot delete your own account' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FKs handle cascades for shifts/shift_activities/equipment/locations/connections
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Delete user failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
