

-- === SAFETY: add missing columns to existing tables BEFORE indexes ===
DO $$
BEGIN
  -- users
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='primary_admin_site_id') THEN
      ALTER TABLE users ADD COLUMN primary_admin_site_id INT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='work_site_id') THEN
      ALTER TABLE users ADD COLUMN work_site_id INT NULL;
    END IF;
  END IF;

  -- shifts
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='shifts') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shifts' AND column_name='admin_site_id') THEN
      ALTER TABLE shifts ADD COLUMN admin_site_id INT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shifts' AND column_name='work_site_id') THEN
      ALTER TABLE shifts ADD COLUMN work_site_id INT NULL;
    END IF;
  END IF;

  -- shift_activities
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='shift_activities') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shift_activities' AND column_name='admin_site_id') THEN
      ALTER TABLE shift_activities ADD COLUMN admin_site_id INT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shift_activities' AND column_name='work_site_id') THEN
      ALTER TABLE shift_activities ADD COLUMN work_site_id INT NULL;
    END IF;
  END IF;

  -- validated_shifts
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='validated_shifts') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_shifts' AND column_name='admin_site_id') THEN
      ALTER TABLE validated_shifts ADD COLUMN admin_site_id INT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_shifts' AND column_name='work_site_id') THEN
      ALTER TABLE validated_shifts ADD COLUMN work_site_id INT NULL;
    END IF;
  END IF;

  -- validated_shift_activities
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='validated_shift_activities') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_shift_activities' AND column_name='admin_site_id') THEN
      ALTER TABLE validated_shift_activities ADD COLUMN admin_site_id INT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_shift_activities' AND column_name='work_site_id') THEN
      ALTER TABLE validated_shift_activities ADD COLUMN work_site_id INT NULL;
    END IF;
  END IF;

  -- admin_equipment/admin_locations
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='admin_equipment') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_equipment' AND column_name='admin_site_id') THEN
      ALTER TABLE admin_equipment ADD COLUMN admin_site_id INT NULL;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='admin_locations') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_locations' AND column_name='admin_site_id') THEN
      ALTER TABLE admin_locations ADD COLUMN admin_site_id INT NULL;
    END IF;
  END IF;

  -- reconciliation tables
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='validated_reconciliations') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_reconciliations' AND column_name='admin_site_id') THEN
      ALTER TABLE validated_reconciliations ADD COLUMN admin_site_id INT NULL;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='validated_reconciliation_days') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='validated_reconciliation_days' AND column_name='admin_site_id') THEN
      ALTER TABLE validated_reconciliation_days ADD COLUMN admin_site_id INT NULL;
    END IF;
  END IF;
END$$;
-- === END SAFETY ===

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  name TEXT,
  -- Legacy: historically used as the user's "site". Going forward this is the user's
  -- current WORK SITE display name (kept for backward compatibility with existing
  -- reports/endpoints that filter by users.site / shifts.site).
  site TEXT NOT NULL DEFAULT 'default',
  work_site_id INT NULL,
  primary_admin_site_id INT NULL,
  primary_site_id INT NULL,
  state TEXT,
  email_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirm_code TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  reset_code TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);

-- WORK SITES (where a user works / worked) - NOT tied to subscribed Site Admin.
-- Users can nominate a Work Site even if a Subscribed Site (admin tenant) doesn't exist.
CREATE TABLE IF NOT EXISTS work_sites (
  id SERIAL PRIMARY KEY,
  name_display TEXT NOT NULL,
  name_normalized TEXT NOT NULL UNIQUE,
  country TEXT,
  state TEXT,
  company TEXT,
  is_official BOOLEAN NOT NULL DEFAULT FALSE,
  -- Links an official work site to a Subscribed Site (admin tenant) when/if it exists.
  official_site_id INT NULL,
  created_by_user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_sites_name_display ON work_sites(name_display);

CREATE TABLE IF NOT EXISTS user_work_site_history (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_site_id INT NOT NULL REFERENCES work_sites(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, work_site_id, start_date)
);

CREATE INDEX IF NOT EXISTS idx_user_work_site_history_user ON user_work_site_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_work_site_history_site ON user_work_site_history(work_site_id);


CREATE TABLE IF NOT EXISTS connections (
  id SERIAL PRIMARY KEY,
  requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(requester_id, addressee_id)
);


CREATE TABLE IF NOT EXISTS failed_logins (
  id SERIAL PRIMARY KEY,
  email TEXT,
  ip TEXT,
  ts TIMESTAMPTZ DEFAULT now(),
  reason TEXT
);

CREATE TABLE IF NOT EXISTS equipment (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_equipment_user ON equipment(user_id);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_locations_user ON locations(user_id);

-- SUBSCRIBED SITE ADMIN TENANTS
CREATE TABLE IF NOT EXISTS admin_sites (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  state TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);

-- SITE ADMIN MASTER LISTS (per-site)
CREATE TABLE IF NOT EXISTS admin_equipment (
  id SERIAL PRIMARY KEY,
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(admin_site_id, equipment_id)
);

ALTER TABLE admin_equipment ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE INDEX IF NOT EXISTS idx_admin_equipment_admin_site_id ON admin_equipment(admin_site_id);

CREATE TABLE IF NOT EXISTS admin_locations (
  id SERIAL PRIMARY KEY,
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(admin_site_id, name)
);

ALTER TABLE admin_locations ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE INDEX IF NOT EXISTS idx_admin_locations_admin_site_id ON admin_locations(admin_site_id);



CREATE INDEX IF NOT EXISTS idx_users_site ON users(site);

-- ADMIN SITES (for Site Admin creation dropdown)

-- Backward-compatible migration: older databases may have admin_sites.site instead of admin_sites.name.
-- Ensure required columns exist and backfill name from site when present.
ALTER TABLE admin_sites ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE admin_sites ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE admin_sites ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE admin_sites ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE admin_sites ADD COLUMN IF NOT EXISTS terms_version TEXT;

-- Backfill admin_sites.name from admin_sites.site if that legacy column exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='admin_sites' AND column_name='site'
  ) THEN
    EXECUTE 'UPDATE admin_sites SET name = COALESCE(NULLIF(name, ''''), TRIM(site)) WHERE COALESCE(NULLIF(name, ''''), '''') = ''''';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- do nothing; safe on partial schemas
END $$;

-- Some older schemas incorrectly enforced validated_shifts.user_id as NOT NULL.
-- Newer logic allows email-only rows (user_id NULL), so we defensively drop the constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'validated_shifts'
       AND column_name = 'user_id'
       AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE validated_shifts ALTER COLUMN user_id DROP NOT NULL';
  END IF;
END $$;

-- Ensure uniqueness on name (some older schemas may miss the constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename='admin_sites' AND indexname='admin_sites_name_key'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS admin_sites_name_key ON admin_sites(name)';
  END IF;
END $$;


-- SITE MEMBERSHIPS (approval + roles)
-- Authoritative membership + roles per site.
-- role: member | validator | admin
-- status: requested | active | revoked
--
-- NOTE: site_name is deprecated (legacy/backfill only). site_id is authoritative.
CREATE TABLE IF NOT EXISTS site_memberships (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INT REFERENCES admin_sites(id) ON DELETE CASCADE,
  site_name TEXT, -- legacy / snapshot
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'requested',
  requested_at TIMESTAMPTZ DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, site_id)
);


-- SHIFTS (raw operator-submitted)
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_site_id INT NULL REFERENCES work_sites(id) ON DELETE SET NULL,
  admin_site_id INT NULL REFERENCES admin_sites(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  totals_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ,
  user_email TEXT,
  user_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, date, dn)
);

CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE INDEX IF NOT EXISTS idx_shifts_admin_site_id ON shifts(admin_site_id);
CREATE INDEX IF NOT EXISTS idx_shifts_work_site_id ON shifts(work_site_id);

-- SHIFT ACTIVITIES (raw rows)
CREATE TABLE IF NOT EXISTS shift_activities (
  id SERIAL PRIMARY KEY,
  shift_id INT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_email TEXT,
  user_name TEXT,
  work_site_id INT NULL REFERENCES work_sites(id) ON DELETE SET NULL,
  admin_site_id INT NULL REFERENCES admin_sites(id) ON DELETE SET NULL,
  activity TEXT NOT NULL,
  sub_activity TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shift_activities_shift_id ON shift_activities(shift_id);
ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE INDEX IF NOT EXISTS idx_shift_activities_admin_site_id ON shift_activities(admin_site_id);
CREATE INDEX IF NOT EXISTS idx_shift_activities_work_site_id ON shift_activities(work_site_id);

-- VALIDATION LAYER (tenant-scoped, visible in Site Admin)
CREATE TABLE IF NOT EXISTS validated_shifts (
  id SERIAL PRIMARY KEY,
  -- A stable natural key used throughout the project for tenant-scoped validation.
  -- Format: "<admin_site_id>|<date>|<dn>|<user_id_or_email>"
  shift_key TEXT NOT NULL,

  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  work_site_id INT NULL REFERENCES work_sites(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,

  -- Use email as the consistent identifier across older datasets.
  user_email TEXT NOT NULL DEFAULT '',
  user_name TEXT,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,

  validated BOOLEAN NOT NULL DEFAULT FALSE,
  validated_at TIMESTAMPTZ,
  validated_by INT REFERENCES users(id) ON DELETE SET NULL,

  totals_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(admin_site_id, date, dn, user_email),
  UNIQUE(shift_key)
);

-- Bootstrap safety: if this table already existed from an older run (without shift_key),
-- add the column BEFORE creating indexes that reference it.
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS shift_key TEXT;

CREATE INDEX IF NOT EXISTS idx_validated_shifts_admin_site_id ON validated_shifts(admin_site_id);
CREATE INDEX IF NOT EXISTS idx_validated_shifts_date ON validated_shifts(date);
CREATE INDEX IF NOT EXISTS idx_validated_shifts_shift_key ON validated_shifts(shift_key);

-- IMPORTANT: If validated_shifts already existed (older local DB resets), the UNIQUE() clauses in the
-- CREATE TABLE above will NOT be applied retroactively. We therefore create the equivalent UNIQUE
-- indexes defensively so ON CONFLICT works reliably.
CREATE UNIQUE INDEX IF NOT EXISTS uq_validated_shifts_shift_key ON validated_shifts(shift_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_validated_shifts_natural_key ON validated_shifts(admin_site_id, date, dn, user_email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_validated_shifts_shift_id ON validated_shifts(shift_id) WHERE shift_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS validated_shift_activities (
  id SERIAL PRIMARY KEY,
  validated_shift_id INT NOT NULL REFERENCES validated_shifts(id) ON DELETE CASCADE,

  -- denormalized keys for fast filtering (mirrors validated_shifts)
  shift_key TEXT NOT NULL,
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  work_site_id INT NULL REFERENCES work_sites(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  user_name TEXT,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,

  activity TEXT NOT NULL,
  sub_activity TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Bootstrap safety: add shift_key before indexes if this table existed without it.
-- Bootstrap safety: if this table already existed from an older run (without shift_key),
-- add the column BEFORE creating indexes that reference it.
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS shift_key TEXT;

CREATE INDEX IF NOT EXISTS idx_validated_shift_activities_vshift_id ON validated_shift_activities(validated_shift_id);
CREATE INDEX IF NOT EXISTS idx_validated_shift_activities_admin_site_id ON validated_shift_activities(admin_site_id);
CREATE INDEX IF NOT EXISTS idx_validated_shift_activities_shift_key ON validated_shift_activities(shift_key);

-- -----------------------------------------------------------------------------
-- SCHEMA DRIFT GUARDS (safe on existing databases)
-- These ensure older local DBs can upgrade without needing a full drop/recreate.
-- -----------------------------------------------------------------------------

-- shifts / shift_activities: used in some older local DBs and future-proofing.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS shift_key TEXT;
ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS shift_key TEXT;

-- Older DBs may have shift_key nullable; make it safe for ON CONFLICT(shift_key) upserts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='shifts' AND column_name='shift_key'
  ) THEN
    EXECUTE 'UPDATE shifts SET shift_key = COALESCE(shift_key, '''') WHERE shift_key IS NULL';
    EXECUTE 'ALTER TABLE shifts ALTER COLUMN shift_key SET DEFAULT ''''';
    EXECUTE 'ALTER TABLE shifts ALTER COLUMN shift_key SET NOT NULL';
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- no-op
END $$;

-- validated_shifts (older versions were keyed by shift_id and lacked date/dn/shift_key)
-- (shift_key already handled above before index creation, keep this as an extra no-op guard)
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS shift_key TEXT;
-- Older local DBs may still have a legacy shift_id column (FK to shifts) that was created as NOT NULL.
-- Site-admin validation can create a validated shift even when an operator forgot to upload/finalize,
-- so shift_id must be allowed to be NULL in those legacy schemas.
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS shift_id INT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'validated_shifts'
      AND column_name = 'shift_id'
      AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE validated_shifts ALTER COLUMN shift_id DROP NOT NULL';
  END IF;
EXCEPTION WHEN undefined_table THEN
  -- no-op
END $$;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS admin_site_id INT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS work_site_id INT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS dn TEXT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS user_id INT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS validated BOOLEAN;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS validated_by INT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS totals_json JSONB;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS meta_json JSONB;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Power BI: per-site API tokens
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS powerbi_site_tokens (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  label TEXT,
  token TEXT NOT NULL,
  created_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_powerbi_site_tokens_token ON powerbi_site_tokens(token);
CREATE INDEX IF NOT EXISTS idx_powerbi_site_tokens_site ON powerbi_site_tokens(site);

-- validated_shift_activities (older versions lacked denormalized keys)
-- (shift_key already handled above before index creation, keep this as an extra no-op guard)
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS shift_key TEXT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS admin_site_id INT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS work_site_id INT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS dn TEXT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS user_id INT;

-- CONTACT REQUESTS (crew)
CREATE TABLE IF NOT EXISTS contact_requests (
  id SERIAL PRIMARY KEY,
  requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE(requester_id, addressee_id)
);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, created_at DESC);

-- notifications read_at (older versions used is_read only)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notification_preferences (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- USER FEEDBACK
CREATE TABLE IF NOT EXISTS user_feedback (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  user_name TEXT,
  site TEXT,
  message TEXT NOT NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  declined BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure columns exist on older DBs that already have user_feedback
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS site TEXT;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS approved BOOLEAN;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS declined BOOLEAN;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE user_feedback ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS user_feedback_votes (
  id SERIAL PRIMARY KEY,
  feedback_id INT NOT NULL REFERENCES user_feedback(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(feedback_id, user_id)
);

-- VALIDATED DAYS (aggregates / calendar)
-- This table has drifted across versions. We keep both:
--  - status TEXT (newer UI expectation)
--  - validated BOOLEAN (older expectation)
--  - payload_json JSONB (calendar aggregates)
CREATE TABLE IF NOT EXISTS validated_days (
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unvalidated',
  validated BOOLEAN NOT NULL DEFAULT FALSE,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (admin_site_id, date)
);

-- Ensure columns exist on older DBs that already have validated_days
ALTER TABLE validated_days ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE validated_days ADD COLUMN IF NOT EXISTS validated BOOLEAN;
ALTER TABLE validated_days ADD COLUMN IF NOT EXISTS payload_json JSONB;
ALTER TABLE validated_days ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE validated_days ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- RECONCILIATION (tenant)
CREATE TABLE IF NOT EXISTS validated_reconciliations (
  id SERIAL PRIMARY KEY,
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  -- Normalized month bucket: YYYY-MM
  month_ym TEXT,
  -- Metric identifier (matches UI list)
  metric_key TEXT,
  -- Target reconciled total for the month
  reconciled_total NUMERIC,
  -- How to compute the "actual" month total used for delta
  basis TEXT DEFAULT 'validated_only',
  -- Allocation method
  method TEXT DEFAULT 'spread_daily',
  notes TEXT,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id INT,
  actual_total_snapshot NUMERIC,
  delta_snapshot NUMERIC,
  computed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(admin_site_id, month_ym, metric_key)
);

CREATE TABLE IF NOT EXISTS validated_reconciliation_days (
  id SERIAL PRIMARY KEY,
  reconciliation_id INT NOT NULL REFERENCES validated_reconciliations(id) ON DELETE CASCADE,
  admin_site_id INT NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
  month_ym TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  date DATE NOT NULL,
  allocated_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(reconciliation_id, date)
);

-- Ensure reconciliation columns exist on older DBs (idempotent upgrades)
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS month_ym TEXT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS metric_key TEXT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS reconciled_total NUMERIC;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS method TEXT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS is_locked BOOLEAN;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS created_by_user_id INT;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS actual_total_snapshot NUMERIC;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS delta_snapshot NUMERIC;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

ALTER TABLE validated_reconciliations ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_validated_reconciliations_key
  ON validated_reconciliations(admin_site_id, month_ym, metric_key);

ALTER TABLE validated_reconciliation_days ADD COLUMN IF NOT EXISTS admin_site_id INT;
ALTER TABLE validated_reconciliation_days ADD COLUMN IF NOT EXISTS month_ym TEXT;
ALTER TABLE validated_reconciliation_days ADD COLUMN IF NOT EXISTS metric_key TEXT;
ALTER TABLE validated_reconciliation_days ADD COLUMN IF NOT EXISTS allocated_value NUMERIC;

ALTER TABLE validated_reconciliation_days ADD COLUMN IF NOT EXISTS admin_site_id INT;

CREATE INDEX IF NOT EXISTS ix_validated_reconciliation_days_admin_site_month_metric
  ON validated_reconciliation_days(admin_site_id, month_ym, metric_key);




-- ---------------------------------------------------------------------------
-- SAFE POST-CREATE COLUMN ENSURE (idempotent, supports upgrades)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- users
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE users ADD COLUMN IF NOT EXISTS work_site_id INT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_admin_site_id INT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_site_id INT NULL;
  END IF;

  -- notifications
  IF to_regclass('public.notifications') IS NOT NULL THEN
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
  END IF;

  -- shifts + activities
  IF to_regclass('public.shifts') IS NOT NULL THEN
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS work_site_id INT NULL;
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS admin_site_id INT NULL;
  END IF;

  IF to_regclass('public.shift_activities') IS NOT NULL THEN
    ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS work_site_id INT NULL;
    ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS admin_site_id INT NULL;
  END IF;

  IF to_regclass('public.validated_shifts') IS NOT NULL THEN
    ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS work_site_id INT NULL;
    ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS admin_site_id INT NULL;
  END IF;

  IF to_regclass('public.validated_shift_activities') IS NOT NULL THEN
    ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS work_site_id INT NULL;
    ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS admin_site_id INT NULL;
  END IF;
END $$;

-- Ensure shifts has unique (user_id, date, dn) for ON CONFLICT
CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_user_date_dn ON shifts(user_id, date, dn);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shifts_shift_key ON shifts(shift_key);


-- === COMMUNITY / PUBLIC STATS (APP USAGE) ===
CREATE TABLE IF NOT EXISTS presence_events (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket TIMESTAMPTZ NOT NULL,
  country_code TEXT NULL,
  user_agent TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_presence_events_bucket ON presence_events(bucket);
CREATE INDEX IF NOT EXISTS idx_presence_events_country_bucket ON presence_events(country_code, bucket);

