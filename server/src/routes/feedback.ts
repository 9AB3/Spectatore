import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';

const router = Router();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'support@spectatore.com').trim();

// Submit feedback
router.post('/', authMiddleware, async (req: any, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

  try {
    const uR = await pool.query('SELECT id, email, name, site FROM users WHERE id=$1', [req.user_id]);
    const u = uR.rows?.[0];
    if (!u) return res.status(401).json({ ok: false, error: 'invalid user' });

    const ins = await pool.query(
      `INSERT INTO user_feedback(user_id, user_email, user_name, site, message)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [u.id, u.email || null, u.name || null, u.site || null, message],
    );

    // Email notification (stub locally, real in production)
    const subject = 'Spectatore – New feedback';
    const text =
      `New feedback received\n\n` +
      `From: ${u.name || 'User'} <${u.email || ''}>\n` +
      `Site: ${u.site || ''}\n` +
      `Feedback ID: ${ins.rows?.[0]?.id}\n\n` +
      `${message}\n`;
    await sendEmail(SUPPORT_EMAIL, subject, text);

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to submit feedback' });
  }
});

// List approved feedback (ordered by most upvotes first)
router.get('/approved', authMiddleware, async (req: any, res) => {
  try {
    const userId = req.user_id;
    const r = await pool.query(
      `SELECT
        f.id,
        f.message,
        f.user_name,
        f.site,
        f.created_at::text as created_at,
        COALESCE(v.upvotes, 0)::int as upvotes,
        CASE WHEN uv.id IS NULL THEN FALSE ELSE TRUE END as has_upvoted
      FROM user_feedback f
      LEFT JOIN (
        SELECT feedback_id, COUNT(*)::int as upvotes
        FROM user_feedback_votes
        GROUP BY feedback_id
      ) v ON v.feedback_id = f.id
      LEFT JOIN user_feedback_votes uv
        ON uv.feedback_id = f.id AND uv.user_id = $1
      WHERE f.approved = TRUE
      ORDER BY COALESCE(v.upvotes,0) DESC, f.created_at DESC`,
      [userId],
    );
    return res.json({ ok: true, rows: r.rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to load feedback' });
  }
});

// Upvote an approved feedback item (only once per user)
router.post('/upvote', authMiddleware, async (req: any, res) => {
  const feedbackId = Number(req.body?.feedback_id || 0);
  if (!feedbackId) return res.status(400).json({ ok: false, error: 'Missing feedback_id' });

  try {
    const okR = await pool.query('SELECT id FROM user_feedback WHERE id=$1 AND approved=TRUE', [feedbackId]);
    if (!okR.rows?.[0]) return res.status(400).json({ ok: false, error: 'Feedback is not approved' });

    await pool.query(
      `INSERT INTO user_feedback_votes(feedback_id, user_id)
       VALUES ($1,$2)
       ON CONFLICT (feedback_id, user_id) DO NOTHING`,
      [feedbackId, req.user_id],
    );

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to upvote' });
  }
});

export default router;
