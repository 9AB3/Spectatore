import { pool } from '../lib/pg.js';

async function main() {
  try {
    const r = await pool.query('SELECT NOW() as now');
    const now = r.rows?.[0]?.now;
    console.log('[db:check] connected OK. now =', now);

    const t = await pool.query(
      `SELECT to_regclass('public.users') as users,
              to_regclass('public.shifts') as shifts`,
    );
    console.log('[db:check] tables:', t.rows?.[0]);

    if (!t.rows?.[0]?.users) {
      console.log('[db:check] WARNING: users table missing. Run: npm run db:init');
      process.exitCode = 2;
    }
  } catch (e: any) {
    console.error('[db:check] FAILED:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
