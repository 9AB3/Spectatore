import { pool } from './pg.js';

// Server-side background jobs for presence/engagement.
// These are intentionally lightweight and defensive so they can run in Render/containers.

const STALE_MINUTES = Number(process.env.PRESENCE_STALE_MINUTES || 5);

async function closeStaleSessions() {
  const mins = Math.max(1, STALE_MINUTES);
  // Close sessions that haven't received a heartbeat recently.
  // Also prune realtime presence rows that are stale.
  await pool.query(
    `
    UPDATE presence_sessions
       SET ended_at = now(),
           duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)))::int),
           closed_reason = COALESCE(closed_reason, 'stale')
     WHERE ended_at IS NULL
       AND last_seen < now() - ($1::text || ' minutes')::interval
    `,
    [String(mins)],
  );

  await pool.query(
    `
    DELETE FROM presence_current
     WHERE last_seen < now() - ($1::text || ' minutes')::interval
    `,
    [String(mins)],
  );
}

async function upsertDailyWeeklyStats() {
  // Recompute a rolling window so the stats remain correct even if sessions close late.
  // Keep the window small to avoid heavy load.
  const days = 35; // enough for MAU-style charts later

  await pool.query(
    `
    WITH days AS (
      SELECT (CURRENT_DATE - offs)::date AS day
      FROM generate_series(0, $1::int) AS offs
    ),
    per_day AS (
      SELECT
        d.day,
        s.site_id,
        COUNT(DISTINCT s.user_id)::int AS dau,
        COUNT(*)::int AS sessions,
        COALESCE(
          SUM(
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_seen) - s.started_at)))
          )
        ,0)::bigint AS total_seconds
      FROM days d
      JOIN presence_sessions s
        ON s.started_at::date = d.day
      GROUP BY 1,2
    )
    INSERT INTO presence_daily_stats (day, site_id, dau, sessions, total_minutes)
    SELECT day, site_id, dau, sessions, GREATEST(0, FLOOR(total_seconds/60))::int
    FROM per_day
    ON CONFLICT (day, site_id) DO UPDATE
      SET dau = EXCLUDED.dau,
          sessions = EXCLUDED.sessions,
          total_minutes = EXCLUDED.total_minutes
    `,
    [days],
  );

  await pool.query(
    `
    WITH weeks AS (
      SELECT date_trunc('week', (CURRENT_DATE - offs)::date)::date AS week_start
      FROM generate_series(0, 120, 7) AS offs
    ),
    per_week AS (
      SELECT
        w.week_start,
        s.site_id,
        COUNT(DISTINCT s.user_id)::int AS wau,
        COUNT(*)::int AS sessions,
        COALESCE(
          SUM(
            GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_seen) - s.started_at)))
          )
        ,0)::bigint AS total_seconds
      FROM weeks w
      JOIN presence_sessions s
        ON date_trunc('week', s.started_at)::date = w.week_start
      GROUP BY 1,2
    )
    INSERT INTO presence_weekly_stats (week_start, site_id, wau, sessions, total_minutes)
    SELECT week_start, site_id, wau, sessions, GREATEST(0, FLOOR(total_seconds/60))::int
    FROM per_week
    ON CONFLICT (week_start, site_id) DO UPDATE
      SET wau = EXCLUDED.wau,
          sessions = EXCLUDED.sessions,
          total_minutes = EXCLUDED.total_minutes
    `,
  );
}

export function startPresenceJobs() {
  // Fire-and-forget intervals (best-effort).
  const safeRun = (name: string, fn: () => Promise<void>) =>
    fn().catch((e: any) => console.warn(`[presence-jobs] ${name} failed:`, e?.message || e));

  // Run shortly after boot, then on a cadence.
  setTimeout(() => safeRun('closeStaleSessions', closeStaleSessions), 10_000);
  setTimeout(() => safeRun('upsertDailyWeeklyStats', upsertDailyWeeklyStats), 15_000);

  setInterval(() => safeRun('closeStaleSessions', closeStaleSessions), 60_000);
  setInterval(() => safeRun('upsertDailyWeeklyStats', upsertDailyWeeklyStats), 5 * 60_000);
}
