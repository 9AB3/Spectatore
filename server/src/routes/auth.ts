import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../lib/pg.js';
import { sendEmail } from '../lib/email.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || 'support@spectatore.com').trim();
// In local dev we default to skipping email confirmation when using stub email.
// You can force the confirm flow by setting DEV_SKIP_EMAIL_CONFIRM=0.
const DEV_SKIP =
  process.env.DEV_SKIP_EMAIL_CONFIRM === '1' ||
  (process.env.DEV_SKIP_EMAIL_CONFIRM !== '0' &&
    process.env.NODE_ENV !== 'production' &&
    (process.env.EMAIL_MODE || 'stub') === 'stub');

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

async function recordFailed(email: string, ip?: string, reason?: string) {
  const e = normaliseEmail(email);
  await pool.query(
    'INSERT INTO failed_logins (email, ip, reason) VALUES ($1, $2, $3)',
    [e, ip || null, reason || null],
  );
}

async function tooMany(email: string): Promise<boolean> {
  const e = normaliseEmail(email);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM failed_logins
      WHERE email = $1
        AND ts >= NOW() - INTERVAL '10 minutes'`,
    [e],
  );
  return (r.rows?.[0]?.c || 0) >= 5;
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, site, state, name } = req.body || {};
    const normEmail = normaliseEmail(email);
    if (!normEmail || !password || !name) {
      return res.status(400).json({ error: 'name, email and password required' });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const inserted = await pool.query(
      `INSERT INTO users (email, password_hash, site, state, name, confirm_code)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, email, name, is_admin, email_confirmed`,
      [normEmail, hash, site || null, state || null, name, code],
    );

    const user = inserted.rows[0];

    // Create a membership request for the nominated site (best-effort).
    // Membership status/role is what controls access to site-level validation tools.
    try {
      const siteName = String(site || '').trim();
      if (siteName) {
        await pool.query(
          `INSERT INTO admin_sites (name) VALUES ($2) ON CONFLICT (name) DO NOTHING;
           INSERT INTO site_memberships (user_id, site_id, site_name, role, status)
           VALUES ($1,(SELECT id FROM admin_sites WHERE name=$2),$2,'member','requested')
           ON CONFLICT (user_id, site_id) DO NOTHING;
           UPDATE users SET primary_site_id = COALESCE(primary_site_id, (SELECT id FROM admin_sites WHERE name=$2)) WHERE id=$1`,
          [user.id, siteName],
        );
      }
    } catch {
      // ignore
    }

    // Notify support of every new signup (best-effort; never block registration)
    // NOTE: this email goes to your support inbox; the sign-up code still goes to the user.
    sendEmail(
      SUPPORT_EMAIL,
      'Spectatore – New sign up',
      `A new user signed up.\n\n` +
        `Name: ${name || ''}\n` +
        `Email: ${normEmail}\n` +
        `Site: ${site || ''}\n` +
        `State: ${state || ''}\n` +
        `Time: ${new Date().toISOString()}\n`,
    ).catch(() => {});

    if (DEV_SKIP) {
      await pool.query(
        'UPDATE users SET email_confirmed = TRUE, confirm_code = NULL WHERE id = $1',
        [user.id],
      );
      const token = tokenFor({ ...user, email_confirmed: true });
      return res.json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
      });
    }

    // Normal flow: email the confirmation code
    sendEmail(normEmail, 'Spectatore confirmation code', `Your code is: ${code}`).catch(
      () => {},
    );
    return res.json({ ok: true });
  } catch (err: any) {
    // 23505 = unique_violation
    if (String(err?.code) === '23505') {
      return res.status(400).json({ error: 'email may already exist' });
    }
    console.error('register failed', err);
    return res.status(500).json({ error: 'register failed' });
  }
});

router.post('/confirm', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const normEmail = normaliseEmail(email);
    const r = await pool.query('SELECT id, confirm_code FROM users WHERE email = $1', [
      normEmail,
    ]);
    const user = r.rows[0];
    if (!user) return res.status(400).json({ error: 'invalid email' });
    if (String(user.confirm_code || '') !== String(code || '')) {
      return res.status(400).json({ error: 'incorrect code' });
    }
    await pool.query(
      'UPDATE users SET email_confirmed = TRUE, confirm_code = NULL WHERE id = $1',
      [user.id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('confirm failed', err);
    return res.status(500).json({ error: 'confirm failed' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normEmail = normaliseEmail(email);
  if (!normEmail || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const blocked = await tooMany(normEmail);
    if (blocked) {
      return res
        .status(429)
        .json({ error: 'Too many attempts. Try again in 5 minutes' });
    }

    const r = await pool.query(
      'SELECT id, email, password_hash, is_admin, email_confirmed FROM users WHERE email = $1',
      [normEmail],
    );
    const user = r.rows[0];
    if (!user) {
      await recordFailed(normEmail, req.ip, 'no_user');
      return res.status(401).json({ error: 'invalid credentials' });
    }

    if (!bcrypt.compareSync(String(password), String(user.password_hash || ''))) {
      await recordFailed(normEmail, req.ip, 'bad_password');
      return res.status(401).json({ error: 'invalid credentials' });
    }

    if (!user.email_confirmed) {
      return res.status(403).json({ error: 'EMAIL_NOT_CONFIRMED' });
    }

    const token = tokenFor(user);
    return res.json({ token, is_admin: !!user.is_admin, user_id: user.id });
  } catch (err) {
    console.error('login failed', err);
    return res.status(500).json({ error: 'login failed' });
  }
});

router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body || {};
    const normEmail = normaliseEmail(email);
    const r = await pool.query('SELECT id FROM users WHERE email = $1', [normEmail]);
    const user = r.rows[0];
    if (!user) return res.json({ ok: true }); // don't leak

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query('UPDATE users SET reset_code = $1 WHERE id = $2', [code, user.id]);
    sendEmail(normEmail, 'Spectatore reset code', `Your reset code is: ${code}`).catch(
      () => {},
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('forgot failed', err);
    return res.status(500).json({ error: 'forgot failed' });
  }
});

router.post('/reset', async (req, res) => {
  try {
    const { email, code, password } = req.body || {};
    const normEmail = normaliseEmail(email);
    const r = await pool.query('SELECT id, reset_code FROM users WHERE email = $1', [
      normEmail,
    ]);
    const user = r.rows[0];
    if (!user) return res.status(400).json({ error: 'invalid email' });
    if (String(user.reset_code || '') !== String(code || '')) {
      return res.status(400).json({ error: 'incorrect code' });
    }
    const hash = bcrypt.hashSync(String(password), 10);
    await pool.query('UPDATE users SET password_hash = $1, reset_code = NULL WHERE id = $2', [
      hash,
      user.id,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('reset failed', err);
    return res.status(500).json({ error: 'reset failed' });
  }
});

// Dev helper: get a token for an existing user
router.get('/dev-token', async (req, res) => {
  if (!DEV_SKIP) return res.status(404).end();
  const email = req.query.email as string;
  const normEmail = normaliseEmail(email);
  if (!normEmail) return res.status(400).json({ error: 'email required' });

  try {
    const r = await pool.query(
      'SELECT id, email, is_admin FROM users WHERE email = $1',
      [normEmail],
    );
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'user not found' });
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: !!user.is_admin },
      JWT_SECRET,
      { expiresIn: '7d' },
    );
    return res.json({ token });
  } catch (err) {
    console.error('dev-token failed', err);
    return res.status(500).json({ error: 'dev-token failed' });
  }
});

export default router;
