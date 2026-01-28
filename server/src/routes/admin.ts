import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';
import { seedData } from '../tools/seedData.js';

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

// Seed demo data for a specific user, overriding (clearing) their existing shift data.
// POST /api/admin/users/:id/seed-override { days, site, includeValidated }
router.post('/users/:id/seed-override', authMiddleware, requireAdmin, async (req: any, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  try {
    const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
    const allowProd = (process.env.SEED_ALLOW_PROD || '').toLowerCase() === 'true';
    if (isProd && !allowProd) {
      return res.status(403).json({ error: 'Seeding is disabled in production' });
    }

    const days = Math.max(1, Math.min(365, parseInt(String(req.body?.days || '60'), 10)));
    const site = String(req.body?.site || 'Test').trim() || 'Test';
    const includeValidated = String(req.body?.includeValidated ?? 'true').toLowerCase() !== 'false';

    // Look up the target user context
    const u = await pool.query('SELECT id, email, name FROM users WHERE id=$1', [targetId]);
    const row = u.rows?.[0];
    const user_email = String(row?.email || '').trim();
    const user_name = String(row?.name || '').trim() || user_email || `User ${targetId}`;
    if (!user_email) return res.status(404).json({ error: 'User not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clear existing shift + activity data for the target user
      const shiftIdsR = await client.query('SELECT id FROM shifts WHERE user_id=$1', [targetId]);
      const shiftIds = (shiftIdsR.rows || []).map((r: any) => Number(r.id)).filter((n: any) => Number.isFinite(n));
      if (shiftIds.length) {
        await client.query('DELETE FROM shift_activities WHERE shift_id = ANY($1::bigint[])', [shiftIds]);
      }
      await client.query('DELETE FROM shifts WHERE user_id=$1', [targetId]);

      // Optional cleanup: remove notifications for a clean slate
      await client.query('DELETE FROM notifications WHERE user_id=$1', [targetId]).catch(() => undefined);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Seed after clearing, using the *target* user's context
    const out = await seedData({
      days,
      site,
      userEmail: user_email,
      userName: user_name,
      userId: targetId,
      includeValidated,
    });

    if (!out.ok) return res.status(500).json(out);
    return res.json({ ...out, overridden: true, targetUserId: targetId });
  } catch (e: any) {
    console.error('Seed override failed:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});



// DEV-ONLY: Seed demo data (admin only)
router.post('/seed', authMiddleware, requireAdmin, async (req: any, res) => {
  try {
    const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
    const allowProd = (process.env.SEED_ALLOW_PROD || '').toLowerCase() === 'true';
    if (isProd && !allowProd) {
      return res.status(403).json({ error: 'Seeding is disabled in production' });
    }

    const days = Math.max(1, Math.min(365, parseInt(String(req.body?.days || '60'), 10)));
    const site = String(req.body?.site || req.site || 'Test').trim() || 'Test';
    const includeValidated = String(req.body?.includeValidated ?? 'true').toLowerCase() !== 'false';

    // user context from authMiddleware
    const user_id = req.user_id;
    // authMiddleware only guarantees user_id + is_admin. Fetch email/name from DB for reliable context.
    let user_email = String((req.user_email || '')).trim();
    let user_name = String((req.user_name || '')).trim();
    if (user_id && (!user_email || !user_name)) {
      const r = await pool.query('SELECT email, name FROM users WHERE id=$1', [user_id]);
      user_email = user_email || String(r.rows?.[0]?.email || '').trim();
      user_name = user_name || String(r.rows?.[0]?.name || user_email || 'Admin');
    }

    if (!user_id || !user_email) return res.status(400).json({ error: 'Invalid user context' });

    const out = await seedData({
      days,
      site,
      userEmail: user_email,
      userName: user_name,
      userId: user_id,
      includeValidated,
    });

    if (!out.ok) return res.status(500).json(out);
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});


// === Announcements (Admin) ===

// GET /api/admin/announcements
router.get('/announcements', authMiddleware, requireAdmin, async (_req: any, res: any) => {
  try {
    const r = await pool.query(
      `SELECT a.*,
              u.email AS created_by_email
       FROM announcements a
       LEFT JOIN users u ON u.id = a.created_by
       ORDER BY a.created_at DESC
       LIMIT 500`,
    );
    res.json({ announcements: r.rows || [] });
  } catch (e: any) {
    console.warn('[admin] announcements list failed', e?.message || e);
    res.status(500).json({ error: 'failed' });
  }
});

// POST /api/admin/announcements
router.post('/announcements', authMiddleware, requireAdmin, async (req: any, res: any) => {
  try {
    const userId = Number(req.user_id);
    const title = String(req.body?.title || '').trim();
    const body_md = String(req.body?.body_md || '').trim();
    const version = String(req.body?.version || '').trim() || null;
    const audience = String(req.body?.audience || 'all').trim() || 'all';
    const audience_site_id = req.body?.audience_site_id != null && String(req.body.audience_site_id).trim() !== '' ? Number(req.body.audience_site_id) : null;
    const is_pinned = !!req.body?.is_pinned;
    const is_urgent = !!req.body?.is_urgent;

    if (!title) return res.status(400).json({ error: 'missing title' });

    const r = await pool.query(
      `INSERT INTO announcements(title, body_md, version, audience, audience_site_id, is_pinned, is_urgent, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       RETURNING *`,
      [title, body_md || '', version, audience, audience_site_id, is_pinned, is_urgent, userId],
    );
    res.json({ ok: true, announcement: r.rows[0] });
  } catch (e: any) {
    console.warn('[admin] announcements create failed', e?.message || e);
    res.status(500).json({ error: 'failed' });
  }
});

// DELETE /api/admin/announcements/:id
router.delete('/announcements/:id', authMiddleware, requireAdmin, async (req: any, res: any) => {
  try {
    const id = Number(req.params?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });

    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    // also clear seen rows to keep db tidy
    await pool.query('DELETE FROM announcement_seen WHERE announcement_id = $1', [id]).catch(() => {});
    res.json({ ok: true });
  } catch (e: any) {
    console.warn('[admin] announcements delete failed', e?.message || e);
    res.status(500).json({ error: 'failed' });
  }
});


export default router;