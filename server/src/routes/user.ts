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
    const r = await pool.query(
      'SELECT id, email, site, is_admin, name, terms_accepted_at, terms_version FROM users WHERE id=$1',
      [user_id],
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'user not found' });
    return res.json({
      id: row.id,
      email: row.email,
      site: row.site || null,
      name: row.name || null,
      is_admin: !!row.is_admin,
      termsAccepted: !!row.terms_accepted_at,
      termsAcceptedAt: row.terms_accepted_at || null,
      termsVersion: row.terms_version || null,
    });
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


router.post('/terms/accept', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const version = String(req.body?.version || 'v1').trim() || 'v1';
    await pool.query(
      'UPDATE users SET terms_accepted_at=now(), terms_version=$2 WHERE id=$1',
      [user_id, version],
    );
    return res.json({ ok: true, termsAccepted: true, termsVersion: version });
  } catch (err) {
    console.error('POST /user/terms/accept failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Site membership invites (2-way consent) ----
// When a site-admin "adds" a user via /SiteAdmin/People, we create a membership with status='invited'.
// The invited user must accept before it becomes active.
router.get('/site-invites', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const r = await pool.query(
      `SELECT
         m.id,
        COALESCE(s.name, m.site_name, '') as site,

         COALESCE(m.role,'member') as role,
         COALESCE(m.status,'') as status,
         m.requested_at
       FROM site_memberships m
       LEFT JOIN admin_sites s ON s.id = m.site_id
       WHERE m.user_id=$1 AND m.status='invited'
       ORDER BY m.requested_at DESC NULLS LAST, m.id DESC`,
      [user_id],
    );
    return res.json({ ok: true, invites: r.rows || [] });
  } catch (err) {
    console.error('GET /user/site-invites failed', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/site-invites/respond', authMiddleware, async (req: any, res) => {
  try {
    const user_id = req.user_id;
    const membership_id = Number(req.body?.membership_id || 0);
    const accept = !!req.body?.accept;
    if (!membership_id) return res.status(400).json({ ok: false, error: 'missing membership_id' });

    const m = await pool.query(
      `SELECT id, status
         FROM site_memberships
        WHERE id=$1 AND user_id=$2`,
      [membership_id, user_id],
    );
    if (!m.rows?.[0]) return res.status(404).json({ ok: false, error: 'invite not found' });

    const status = String(m.rows[0].status || '');
    if (status !== 'invited') {
      return res.status(400).json({ ok: false, error: 'not_invited' });
    }

    if (accept) {
      await pool.query(
        `UPDATE site_memberships
            SET status='active', approved_at=NOW(), approved_by=NULL
          WHERE id=$1 AND user_id=$2`,
        [membership_id, user_id],
      );
      return res.json({ ok: true, status: 'active' });
    }

    await pool.query(
      `UPDATE site_memberships
          SET status='declined'
        WHERE id=$1 AND user_id=$2`,
      [membership_id, user_id],
    );
    return res.json({ ok: true, status: 'declined' });
  } catch (err) {
    console.error('POST /user/site-invites/respond failed', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

export default router;