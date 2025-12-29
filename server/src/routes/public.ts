import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { sendEmail } from '../lib/email.js';

const router = Router();

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// POST /api/public/contact
// body: { name, email, company?, site?, message? }
router.post('/contact', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const company = String(b.company || '').trim();
  const site = String(b.site || '').trim();
  const message = String(b.message || '').trim();

  if (!name || name.length < 2) return res.status(400).json({ error: 'name required' });
  if (!email || !isEmail(email)) return res.status(400).json({ error: 'valid email required' });
  if (message.length > 4000) return res.status(400).json({ error: 'message too long' });

  try {
    await pool.query(
      `INSERT INTO contact_requests (name, email, company, site, message)
       VALUES ($1,$2,$3,$4,$5)`,
      [name, email, company || null, site || null, message || null],
    );

    const to = (process.env.CONTACT_TO || process.env.SUPPORT_EMAIL || 'support@spectatore.com').trim();
    const subject = `Spectatore demo / contact request — ${name}`;
    const text = [
      `Name: ${name}`,
      `Email: ${email}`,
      company ? `Company: ${company}` : null,
      site ? `Site: ${site}` : null,
      '',
      message ? `Message:\n${message}` : 'Message: (none)',
      '',
      `Received: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Email in stub mode will write to outbox; in prod it will send via SendGrid.
    await sendEmail(to, subject, text);

    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[contact] error', e?.message || e);
    return res.status(500).json({ error: 'failed to submit request' });
  }
});

export default router;
