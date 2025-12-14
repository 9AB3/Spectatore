import { Router } from 'express';
import { db } from '../lib/db.js';
import { authMiddleware } from '../lib/auth';

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (!req.is_admin) {
    return res.status(403).json({ error: 'Admins only' });
  }
  next();
}

// List all users (basic info + admin flag)
router.get('/users', authMiddleware, requireAdmin, (req, res) => {
  db.all(
    'SELECT id, email, name, site, state, is_admin FROM users ORDER BY id ASC',
    [],
    (err, rows) => {
      if (err) {
        console.error('List users failed:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ users: rows });
    },
  );
});

// Toggle admin ON for a user
router.post('/users/:id/make-admin', authMiddleware, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  db.run('UPDATE users SET is_admin=1 WHERE id=?', [userId], (err) => {
    if (err) {
      console.error('Make admin failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json({ ok: true });
  });
});

// Toggle admin OFF for a user (cannot remove own admin)
router.post('/users/:id/remove-admin', authMiddleware, requireAdmin, (req: any, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  // Prevent removing your own admin flag to avoid locking everyone out
  if (userId === req.user_id) {
    return res.status(400).json({ error: 'Cannot remove admin from yourself' });
  }
  db.run('UPDATE users SET is_admin=0 WHERE id=?', [userId], (err) => {
    if (err) {
      console.error('Remove admin failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json({ ok: true });
  });
});

// Delete a user and their data (cannot delete self)
router.delete('/users/:id', authMiddleware, requireAdmin, (req: any, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (userId === req.user_id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  db.serialize(() => {
    db.run(
      'DELETE FROM shift_activities WHERE shift_id IN (SELECT id FROM shifts WHERE user_id=?)',
      [userId],
    );
    db.run('DELETE FROM shifts WHERE user_id=?', [userId]);
    db.run('DELETE FROM equipment WHERE user_id=?', [userId]);
    db.run('DELETE FROM locations WHERE user_id=?', [userId]);
    db.run('DELETE FROM connections WHERE requester_id=? OR addressee_id=?', [userId, userId]);
    db.run('DELETE FROM users WHERE id=?', [userId], (err) => {
      if (err) {
        console.error('Delete user failed:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ ok: true });
    });
  });
});

export default router;
