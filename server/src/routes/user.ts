import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

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

router.get('/me', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const r = await pool.query('SELECT id, email, site FROM users WHERE id=$1', [user_id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'user not found' });
    return res.json({ email: row.email, site: row.site || null });
  } catch (err) {
    console.error('GET /user/me failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/me', authMiddleware, async (req: any, res) => {
  const user_id = req.user_id;
  const nextEmail = req.body?.email != null ? normaliseEmail(req.body.email) : null;
  const nextSite = req.body?.site != null ? String(req.body.site).trim() : null;
  const currentPassword = req.body?.current_password ? String(req.body.current_password) : '';
  const newPassword = req.body?.new_password ? String(req.body.new_password) : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      'SELECT id, email, site, password_hash, is_admin FROM users WHERE id=$1 FOR UPDATE',
      [user_id],
    );
    const user = u.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }

    if (newPassword) {
      if (!currentPassword) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'current password required' });
      }
      if (!bcrypt.compareSync(currentPassword, String(user.password_hash || ''))) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'current password incorrect' });
      }
      if (newPassword.length < 6) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'password too short' });
      }
    }

    if (nextEmail && nextEmail !== user.email) {
      const check = await client.query('SELECT id FROM users WHERE email=$1 AND id<>$2', [
        nextEmail,
        user_id,
      ]);
      if (check.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'email already in use' });
      }
    }

    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (nextEmail && nextEmail !== user.email) {
      updates.push(`email=$${i++}`);
      params.push(nextEmail);
    }
    if (nextSite !== null) {
      updates.push(`site=$${i++}`);
      params.push(nextSite || null);
    }
    if (newPassword) {
      updates.push(`password_hash=$${i++}`);
      params.push(bcrypt.hashSync(newPassword, 10));
    }

    if (updates.length > 0) {
      params.push(user_id);
      await client.query(`UPDATE users SET ${updates.join(', ')} WHERE id=$${i}`, params);
    }

    const fresh = await client.query('SELECT id, email, site, is_admin FROM users WHERE id=$1', [
      user_id,
    ]);
    await client.query('COMMIT');

    const f = fresh.rows[0];
    const token = tokenFor(f);
    return res.json({ ok: true, token, me: { email: f.email, site: f.site || null } });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (String(err?.code) === '23505') {
      return res.status(400).json({ error: 'email already in use' });
    }
    console.error('PATCH /user/me failed', err);
    return res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

router.get('/search', async (req, res) => {
  try {
    const name = String((req.query.name as string) || '').trim();
    if (!name) return res.json({ items: [] });
    const like = `%${name}%`;
    const r = await pool.query(
      'SELECT id, name, email FROM users WHERE name ILIKE $1 ORDER BY name LIMIT 50',
      [like],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('user search failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});

export default router;
