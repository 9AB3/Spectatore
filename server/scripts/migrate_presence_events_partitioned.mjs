/**
 * One-time migration runner for presence_events partitioning.
 *
 * Usage (local):
 *   DATABASE_URL=... node server/scripts/migrate_presence_events_partitioned.mjs
 *
 * On Render:
 *   Run once via Shell or a one-off job.
 */
import fs from 'node:fs';
import path from 'node:path';

async function getPool() {
  try {
    const mod = await import('../dist/lib/pg.js');
    return mod.pool;
  } catch {
    const mod = await import('../src/lib/pg.js');
    return mod.pool;
  }
}

const pool = await getPool();
const sqlPath = new URL('./presence_events_partition_migration.sql', import.meta.url);
const sql = fs.readFileSync(sqlPath, 'utf-8');

async function main() {
  console.log('[presence_events] running partition migration SQL...');
  await pool.query(sql);
  console.log('[presence_events] migration complete');
}

main()
  .catch((e) => {
    console.error('[presence_events] migration failed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
