/**
 * Spectatore (Render): presence_events partition maintenance
 *
 * - Ensures monthly partitions exist for the next N months
 * - Drops partitions older than retentionDays (default 30)
 *
 * Run daily via a Render Cron Job, e.g.
 *   node server/scripts/presence_partitions_maintenance.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

async function getPool() {
  // Prefer compiled dist in production; fall back to src for local/dev
  try {
    const mod = await import('../dist/lib/pg.js');
    return mod.pool;
  } catch {
    const mod = await import('../src/lib/pg.js');
    return mod.pool;
  }
}

function monthStartUTC(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}
function addMonthsUTC(d, months) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, 0, 0, 0));
}
function fmtYYYYMM(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}_${m}`;
}

const retentionDays = Number(process.env.PRESENCE_EVENTS_RETENTION_DAYS || 30);
const createMonthsAhead = Number(process.env.PRESENCE_EVENTS_CREATE_MONTHS_AHEAD || 2);

const pool = await getPool();

async function ensureParentIsPartitioned() {
  const q = await pool.query(`
    SELECT relkind
    FROM pg_class
    WHERE oid = 'public.presence_events'::regclass
  `);
  const relkind = q.rows?.[0]?.relkind;
  // 'p' = partitioned table, 'r' = regular table
  return relkind === 'p';
}

async function createPartition(startTs, endTs) {
  const name = `presence_events_${fmtYYYYMM(startTs)}`;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public.${name} PARTITION OF public.presence_events FOR VALUES FROM ($1) TO ($2);`,
    [startTs.toISOString(), endTs.toISOString()],
  );
}

async function listMonthlyPartitions() {
  const q = await pool.query(`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname='public' AND p.relname='presence_events'
    ORDER BY c.relname
  `);
  return q.rows.map(r => String(r.name));
}

function partitionStartFromName(name) {
  const m = name.match(/^presence_events_(\d{4})_(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return new Date(Date.UTC(y, mo, 1, 0, 0, 0));
}

async function dropOldPartitions() {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  // drop partitions whose month end is strictly before cutoff
  const parts = await listMonthlyPartitions();
  for (const name of parts) {
    const start = partitionStartFromName(name);
    if (!start) continue;
    const end = addMonthsUTC(start, 1);
    if (end.getTime() < cutoff.getTime()) {
      console.log(`[presence_events] dropping old partition: ${name} (end=${end.toISOString().slice(0,10)})`);
      await pool.query(`DROP TABLE IF EXISTS public.${name};`);
    }
  }
}

async function main() {
  const isPartitioned = await ensureParentIsPartitioned();
  if (!isPartitioned) {
    console.log('[presence_events] parent is not partitioned; skipping maintenance. Run the one-time migration first.');
    return;
  }

  const base = monthStartUTC(new Date());
  // Ensure last month, this month, and next N months exist
  for (let i = -1; i <= createMonthsAhead; i++) {
    const start = addMonthsUTC(base, i);
    const end = addMonthsUTC(base, i + 1);
    console.log(`[presence_events] ensure partition: ${fmtYYYYMM(start)} (${start.toISOString().slice(0,10)} -> ${end.toISOString().slice(0,10)})`);
    await createPartition(start, end);
  }

  await dropOldPartitions();
  console.log('[presence_events] maintenance complete');
}

main()
  .catch((e) => {
    console.error('[presence_events] maintenance failed', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
