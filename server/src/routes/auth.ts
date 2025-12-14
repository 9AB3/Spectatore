import { Router } from 'express';
import { db } from '../lib/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { sendEmail } from '../lib/email';

dotenv.config();
const DEV_SKIP = process.env.DEV_SKIP_EMAIL_CONFIRM === '1';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// ---- Helpers --------------------------------------------------------

function normaliseEmail(raw: any): string {
  return String(raw || '').trim().toLowerCase();
}

// rate limiting helpers
function recordFailed(email: string) {
  const e = normaliseEmail(email);
  db.run(
    "INSERT INTO failed_logins (email, ts) VALUES (?, strftime('%Y-%m-%d %H:%M:%f','now'))",
    [e],
  );
}

function tooMany(email: string, cb: (blocked: boolean) => void) {
  const e = normaliseEmail(email);
  db.get(
    "SELECT COUNT(*) as c FROM failed_logins WHERE email=? AND ts >= datetime('now','-10 minutes')",
    [e],
    (err, row: any) => {
      if (err) return cb(false);
      cb(row?.c >= 5);
    },
  );
}

function tokenFor(user: any) {
  return jwt.sign(
    { id: user.id, email: user.email, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

// ---- Routes ---------------------------------------------------------

router.post('/register', (req, res) => {
  const { email, password, site, state, name } = req.body;
  const normEmail = normaliseEmail(email);

  if (!normEmail || !password || !name) {
    return res.status(400).json({ error: 'name, email and password required' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  db.run(
    'INSERT INTO users (email, password_hash, site, state, name, confirm_code) VALUES (?,?,?,?,?,?)',
    [normEmail, hash, site || null, state || null, name, code],
    function (err) {
      if (err) return res.status(400).json({ error: 'email may already exist' });

      if (DEV_SKIP) {
        db.get('SELECT * FROM users WHERE email=?', [normEmail], (e2, user: any) => {
          if (e2 || !user) return res.status(500).json({ error: 'user create failed' });
          db.run(
            'UPDATE users SET email_confirmed=1, confirm_code=NULL WHERE id=?',
            [user.id],
            (e3) => {
              if (e3) return res.status(500).json({ error: 'confirm failed' });
              const token = tokenFor(user);
              return res.json({
                ok: true,
                token,
                user: { id: user.id, email: user.email, name: user.name },
              });
            },
          );
        });
      } else {
        sendEmail(
          normEmail,
          'Spectatore confirmation code',
          `Your code is: ${code}`,
        ).catch(() => {});
        res.json({ ok: true });
      }
    },
  );
});

router.post('/confirm', (req, res) => {
  const { email, code } = req.body;
  const normEmail = normaliseEmail(email);

  db.get('SELECT * FROM users WHERE email=?', [normEmail], (err, user: any) => {
    if (err || !user) return res.status(400).json({ error: 'invalid email' });
    if (user.confirm_code !== code) return res.status(400).json({ error: 'incorrect code' });
    db.run('UPDATE users SET email_confirmed=1, confirm_code=NULL WHERE id=?', [user.id]);
    res.json({ ok: true });
  });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const normEmail = normaliseEmail(email);

  if (!normEmail || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  tooMany(normEmail, (blocked) => {
    if (blocked) {
      return res
        .status(429)
        .json({ error: 'Too many attempts. Try again in 5 minutes' });
    }

    db.get('SELECT * FROM users WHERE email=?', [normEmail], (err, user: any) => {
      if (err || !user) {
        recordFailed(normEmail);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      if (!bcrypt.compareSync(password, user.password_hash)) {
        recordFailed(normEmail);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      const token = tokenFor(user);
      res.json({ token, is_admin: !!user.is_admin, user_id: user.id });
    });
  });
});

router.post('/forgot', (req, res) => {
  const { email } = req.body;
  const normEmail = normaliseEmail(email);

  db.get('SELECT * FROM users WHERE email=?', [normEmail], async (err, user: any) => {
    if (err || !user) return res.json({ ok: true }); // don't leak
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    db.run('UPDATE users SET reset_code=? WHERE id=?', [code, user.id]);
    sendEmail(
      normEmail,
      'Spectatore reset code',
      `Your reset code is: ${code}`,
    ).catch(() => {});
    res.json({ ok: true });
  });
});

router.post('/reset', (req, res) => {
  const { email, code, password } = req.body;
  const normEmail = normaliseEmail(email);

  db.get('SELECT * FROM users WHERE email=?', [normEmail], (err, user: any) => {
    if (err || !user) return res.status(400).json({ error: 'invalid email' });
    if (user.reset_code !== code) return res.status(400).json({ error: 'incorrect code' });
    const hash = bcrypt.hashSync(password, 10);
    db.run('UPDATE users SET password_hash=?, reset_code=NULL WHERE id=?', [hash, user.id]);
    res.json({ ok: true });
  });
});

// Dev helper: get a token for an existing user
router.get('/dev-token', (req, res) => {
  if (process.env.DEV_SKIP_EMAIL_CONFIRM !== '1') return res.status(404).end();
  const email = req.query.email as string;
  const normEmail = normaliseEmail(email);
  if (!normEmail) return res.status(400).json({ error: 'email required' });

  db.get('SELECT * FROM users WHERE email=?', [normEmail], (err, user: any) => {
    if (err || !user) return res.status(404).json({ error: 'user not found' });
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: !!user.is_admin },
      JWT_SECRET,
      { expiresIn: '7d' },
    );
    res.json({ token });
  });
});

export default router;
