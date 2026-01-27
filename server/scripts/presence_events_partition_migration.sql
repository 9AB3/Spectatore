-- Spectatore: migrate presence_events to partitioned time-series table (Render Postgres friendly)
-- Goal:
--   - keep 1 row per user per minute (enforced by UNIQUE (user_id, ts))
--   - partition by month on ts so retention = DROP old partitions (no bloat)
--
-- Run this ONCE during a short maintenance window.
-- After migration, update the app to write minute-truncated ts (community heartbeat already does this).

BEGIN;

-- 0) Safety: keep the legacy table
ALTER TABLE IF EXISTS public.presence_events RENAME TO presence_events_legacy;

-- 1) New partitioned parent
CREATE TABLE IF NOT EXISTS public.presence_events (
  user_id      integer NOT NULL,
  site_id      integer,
  bucket       text NOT NULL,
  ts           timestamptz NOT NULL,
  meta         jsonb DEFAULT '{}'::jsonb,
  country_code text,
  region_code  text,
  user_agent   text,
  created_at   timestamptz DEFAULT now() NOT NULL
) PARTITION BY RANGE (ts);

-- 2) Partitioned indexes (propagate to partitions)
CREATE UNIQUE INDEX IF NOT EXISTS uq_presence_events_user_ts ON public.presence_events (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_presence_events_ts ON public.presence_events (ts);
CREATE INDEX IF NOT EXISTS idx_presence_events_site_ts ON public.presence_events (site_id, ts);
CREATE INDEX IF NOT EXISTS idx_presence_events_country_ts ON public.presence_events (country_code, ts);
CREATE INDEX IF NOT EXISTS idx_presence_events_region_ts ON public.presence_events (region_code, ts);

-- 3) Create partitions for last month, current month, next 2 months
DO $$
DECLARE
  m date;
  start_ts timestamptz;
  end_ts   timestamptz;
  part_name text;
BEGIN
  FOR m IN
    SELECT date_trunc('month', (now() at time zone 'utc')::date) + (i || ' month')::interval
    FROM generate_series(-1, 2) AS i
  LOOP
    start_ts := (m::date)::timestamptz;
    end_ts := ((m::date + interval '1 month')::date)::timestamptz;
    part_name := format('presence_events_%s', to_char(m::date, 'YYYY_MM'));

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.presence_events FOR VALUES FROM (%L) TO (%L);',
      part_name, start_ts, end_ts
    );
  END LOOP;
END $$;

-- 4) Backfill legacy data (minute truncate ts)
-- Note: legacy table used UNIQUE(user_id, bucket) so this should not create duplicates.
INSERT INTO public.presence_events (user_id, site_id, bucket, ts, meta, country_code, region_code, user_agent, created_at)
SELECT
  user_id,
  site_id,
  COALESCE(bucket, to_char(date_trunc('minute', COALESCE(ts, created_at, now())) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI"Z"')),
  date_trunc('minute', COALESCE(ts, created_at, now())),
  COALESCE(meta, '{}'::jsonb),
  country_code,
  region_code,
  user_agent,
  COALESCE(created_at, now())
FROM public.presence_events_legacy
ON CONFLICT (user_id, ts) DO UPDATE
  SET ts = EXCLUDED.ts,
      bucket = EXCLUDED.bucket,
      site_id = COALESCE(EXCLUDED.site_id, public.presence_events.site_id),
      country_code = COALESCE(EXCLUDED.country_code, public.presence_events.country_code),
      region_code = COALESCE(EXCLUDED.region_code, public.presence_events.region_code),
      user_agent = COALESCE(EXCLUDED.user_agent, public.presence_events.user_agent);

COMMIT;

-- Optional: after you confirm everything is good:
-- DROP TABLE public.presence_events_legacy;
