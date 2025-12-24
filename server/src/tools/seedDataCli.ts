import { pool } from '../lib/pg.js';
import { seedData } from './seedData.js';

async function main() {
  const email = (process.env.SEED_USER_EMAIL || '').trim();
  const days = parseInt(process.env.SEED_DAYS || '60', 10);
  const site = (process.env.SEED_SITE || 'Test').trim();
  const includeValidated = (process.env.SEED_INCLUDE_VALIDATED || 'true').toLowerCase() !== 'false';

  if (!email) {
    console.error('[seed:data] SEED_USER_EMAIL is required');
    process.exit(1);
  }

  const r = await pool.query('SELECT id, email, name FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]);
  if (!r.rows?.length) {
    console.error('[seed:data] user not found:', email);
    process.exit(1);
  }

  const user = r.rows[0];
  const res = await seedData({
    days,
    site,
    userEmail: user.email,
    userName: user.name || user.email,
    userId: user.id,
    includeValidated,
  });

  // seedData throws on failure
  console.log('[seed:data] done:', res);
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed:data] FAILED:', e?.message || e);
  process.exit(1);
});
