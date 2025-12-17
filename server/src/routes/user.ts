import { Router } from 'express';
import { db } from '../lib/db.js';
import { authMiddleware } from '../lib/auth.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

const router = Router();

function normaliseEmail(raw: any): string {
  return String(raw || '').trim().toLowerCase();
}

function tokenFor(user: any) {
  return jwt.sign(
    { id: user.id, email: user.email, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

// --- Current user profile (settings page) ----------------------------

router.get('/me', authMiddleware, (req: any, res) => {
  const user_id = req.user_id;
  db.get('SELECT id, email, site, is_admin FROM users WHERE id=?', [user_id], (err, row: any) => {
    if (err || !row) return res.status(404).json({ error: 'user not found' });
    return res.json({ email: row.email, site: row.site || null });
  });
});

router.patch('/me', authMiddleware, (req: any, res) => {
  const user_id = req.user_id;
  const nextEmail = req.body?.email != null ? normaliseEmail(req.body.email) : null;
  const nextSite = req.body?.site != null ? String(req.body.site).trim() : null;
  const currentPassword = req.body?.current_password ? String(req.body.current_password) : '';
  const newPassword = req.body?.new_password ? String(req.body.new_password) : '';

  db.get('SELECT id, email, site, password_hash, is_admin FROM users WHERE id=?', [user_id], (err, user: any) => {
    if (err || !user) return res.status(404).json({ error: 'user not found' });

    // validate password change if requested
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'current password required' });
      if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
        return res.status(401).json({ error: 'current password incorrect' });
      }
      if (newPassword.length < 6) return res.status(400).json({ error: 'password too short' });
    }

    // email uniqueness check if changing
    const doEmailCheck = nextEmail && nextEmail !== user.email;
    const proceed = () => {
      const updates: string[] = [];
      const params: any[] = [];

      if (nextEmail && nextEmail !== user.email) {
        updates.push('email=?');
        params.push(nextEmail);
      }
      if (nextSite !== null) {
        updates.push('site=?');
        params.push(nextSite || null);
      }
      if (newPassword) {
        updates.push('password_hash=?');
        params.push(bcrypt.hashSync(newPassword, 10));
      }

      if (updates.length === 0) {
        return res.json({ ok: true, me: { email: user.email, site: user.site || null } });
      }

      params.push(user_id);
      db.run(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, params, function (uErr) {
        if (uErr) return res.status(400).json({ error: 'update failed' });
        db.get('SELECT id, email, site, is_admin FROM users WHERE id=?', [user_id], (gErr, fresh: any) => {
          if (gErr || !fresh) return res.status(500).json({ error: 'readback failed' });
          const token = tokenFor(fresh);
          return res.json({ ok: true, token, me: { email: fresh.email, site: fresh.site || null } });
        });
      });
    };

    if (doEmailCheck) {
      db.get('SELECT id FROM users WHERE email=? AND id<>?', [nextEmail, user_id], (e2, row2: any) => {
        if (e2) return res.status(400).json({ error: 'email check failed' });
        if (row2) return res.status(400).json({ error: 'email already in use' });
        proceed();
      });
    } else {
      proceed();
    }
  });
});

router.get('/search', (req, res) => {
  const name = ((req.query.name as string) || '').trim();
  if (!name) return res.json({ items: [] });
  const like = `%${name}%`;
  db.all(
    'SELECT id, name, email FROM users WHERE name LIKE ? ORDER BY name LIMIT 50',
    [like],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

export default router;
