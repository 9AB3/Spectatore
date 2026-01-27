# Render Postgres: presence_events scale safety

This build makes `presence_events` compatible with a partitioned time-series setup on Render Postgres.

## Why
Even with 1 row per user per minute, `presence_events` grows quickly and will eventually impact:
- storage
- vacuum/bloat
- index size
- query latency

Partitioning lets you drop old data instantly.

## One-time migration (run once)
1. Ensure `DATABASE_URL` points at your Render Postgres.
2. From the **server** folder:

```bash
npm run db:presence:migrate
```

This:
- renames `presence_events` -> `presence_events_legacy`
- creates a new partitioned `presence_events` partitioned by month on `ts`
- backfills data (minute-truncates `ts`)
- creates required indexes, including `UNIQUE (user_id, ts)`

After verifying, you may drop the legacy table:
```sql
DROP TABLE public.presence_events_legacy;
```

## Daily maintenance (Render Cron Job)
Create a Render Cron Job that runs daily:

```bash
cd server && npm run db:presence:maintain
```

Environment:
- `DATABASE_URL` (required)
- `PRESENCE_EVENTS_RETENTION_DAYS` (default 30)
- `PRESENCE_EVENTS_CREATE_MONTHS_AHEAD` (default 2)

The job:
- ensures partitions exist (last month -> next N months)
- drops partitions older than retention

## App compatibility
The community heartbeat now writes `ts` at minute granularity and uses `ON CONFLICT (user_id, ts)` by default.
It will fall back to the legacy `(user_id, bucket)` unique constraint on older DBs.
