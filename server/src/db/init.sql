-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  name TEXT,
  site TEXT NOT NULL DEFAULT 'default',
  state TEXT,
  email_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirm_code TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  reset_code TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);


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

-- SITE ADMIN MASTER LISTS (per-site)
CREATE TABLE IF NOT EXISTS admin_equipment (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  type TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_equipment_site ON admin_equipment(site);

CREATE TABLE IF NOT EXISTS admin_locations (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site, name)
);

CREATE INDEX IF NOT EXISTS idx_admin_locations_site ON admin_locations(site);



CREATE INDEX IF NOT EXISTS idx_users_site ON users(site);

-- ADMIN SITES (for Site Admin creation dropdown)
CREATE TABLE IF NOT EXISTS admin_sites (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  state TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);

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


-- ---- Schema migrations / backfill (safe to run repeatedly) ----
DO $$
BEGIN
  -- users.primary_site_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='users' AND column_name='primary_site_id'
  ) THEN
    ALTER TABLE users ADD COLUMN primary_site_id INT;
    ALTER TABLE users ADD CONSTRAINT users_primary_site_fk FOREIGN KEY (primary_site_id)
      REFERENCES admin_sites(id) ON DELETE SET NULL;
  END IF;

  -- site_memberships.site_id + site_name (if upgrading from legacy schema)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='site_memberships' AND column_name='site_id'
  ) THEN
    ALTER TABLE site_memberships ADD COLUMN site_id INT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='site_memberships' AND column_name='site_name'
  ) THEN
    ALTER TABLE site_memberships ADD COLUMN site_name TEXT;
  END IF;

  -- If legacy column `site` exists, copy to site_name.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='site_memberships' AND column_name='site'
  ) THEN
    EXECUTE 'UPDATE site_memberships SET site_name = COALESCE(site_name, site) WHERE site_name IS NULL OR site_name=''''';
  END IF;

  -- Ensure every referenced site_name exists in admin_sites, then backfill site_id.
  INSERT INTO admin_sites (name)
  SELECT DISTINCT TRIM(COALESCE(site_name, '')) AS name
  FROM site_memberships
  WHERE TRIM(COALESCE(site_name, '')) <> ''
  ON CONFLICT (name) DO NOTHING;

  UPDATE site_memberships m
     SET site_id = s.id
    FROM admin_sites s
   WHERE m.site_id IS NULL
     AND TRIM(COALESCE(m.site_name,'')) <> ''
     AND s.name = TRIM(m.site_name);

  -- Backfill users.primary_site_id from users.site (legacy) where possible.
  INSERT INTO admin_sites (name)
  SELECT DISTINCT TRIM(COALESCE(site,'')) AS name
  FROM users
  WHERE TRIM(COALESCE(site,'')) <> ''
  ON CONFLICT (name) DO NOTHING;

  UPDATE users u
     SET primary_site_id = s.id
    FROM admin_sites s
   WHERE u.primary_site_id IS NULL
     AND TRIM(COALESCE(u.site,'')) <> ''
     AND s.name = TRIM(u.site);

  -- Ensure membership rows exist for legacy users.site
  INSERT INTO site_memberships (user_id, site_id, site_name, role, status, approved_at)
  SELECT u.id, s.id, s.name, 'member', 'requested', NULL
  FROM users u
  JOIN admin_sites s ON s.name = TRIM(u.site)
  LEFT JOIN site_memberships m ON m.user_id=u.id AND m.site_id=s.id
  WHERE m.id IS NULL;

  -- De-dupe any historical rows before adding a unique index.
  -- Keep the lowest id for each (user_id, site_id).
  DELETE FROM site_memberships a
  USING site_memberships b
  WHERE a.id > b.id
    AND a.user_id = b.user_id
    AND COALESCE(a.site_id, 0) = COALESCE(b.site_id, 0);

  -- Ensure ON CONFLICT(user_id, site_id) is valid even if the table existed before.
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS ux_site_memberships_user_site ON site_memberships(user_id, site_id)';

  -- Indexes for site_memberships (created after migrations/backfill)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='site_memberships' AND column_name='site_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_site_memberships_site_id ON site_memberships(site_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_site_memberships_site_status ON site_memberships(site_id, status)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='site_memberships' AND column_name='user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_site_memberships_user ON site_memberships(user_id)';
  END IF;

EXCEPTION WHEN others THEN
  -- no-op (allows dev DBs in weird states to still boot)
END$$;
-- PUSH SUBSCRIPTIONS (Web Push)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);


CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);


-- CONTACT / DEMO REQUESTS (Marketing landing page)
CREATE TABLE IF NOT EXISTS contact_requests (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  site TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_created_at ON contact_requests(created_at);
-- SHIFTS (authoritative user-finalized data)
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site TEXT NOT NULL DEFAULT 'default',
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  totals_json JSONB DEFAULT '{}'::jsonb,
  meta_json JSONB DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ,
  user_email TEXT,
  user_name TEXT,
  UNIQUE (user_id, date, dn)
);

CREATE INDEX IF NOT EXISTS idx_shifts_site_date ON shifts(site, date);
CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);

CREATE TABLE IF NOT EXISTS shift_activities (
  id SERIAL PRIMARY KEY,
  shift_id INT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_email TEXT,
  user_name TEXT,
  site TEXT,
  activity TEXT,
  sub_activity TEXT,
  payload_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shift_activities_shift ON shift_activities(shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_activities_site ON shift_activities(site);

-- VALIDATION LAYER (editable snapshot used by Site Admin validation)
CREATE TABLE IF NOT EXISTS validated_shifts (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  -- Normalise NULLs so we can enforce a simple UNIQUE constraint.
  user_email TEXT NOT NULL DEFAULT '',
  user_name TEXT,
  user_id INTEGER,
  validated INT NOT NULL DEFAULT 0,
  totals_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (site, date, dn, user_email)
);

-- Day-level status for Site Admin validation calendar.
-- Used for UI colouring and quick status checks.
CREATE TABLE IF NOT EXISTS validated_days (
  site TEXT NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unvalidated',
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (site, date)
);

CREATE INDEX IF NOT EXISTS idx_validated_shifts_site_date ON validated_shifts(site, date);

CREATE TABLE IF NOT EXISTS validated_shift_activities (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  user_id INTEGER,
  activity TEXT,
  sub_activity TEXT,
  payload_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);


-- --- Power BI scalability upgrades (idempotent) ---
-- Add relational linkage between validated_shift_activities and validated_shifts
ALTER TABLE IF EXISTS validated_shifts
  ADD COLUMN IF NOT EXISTS shift_key TEXT;

ALTER TABLE IF EXISTS validated_shift_activities
  ADD COLUMN IF NOT EXISTS validated_shift_id INTEGER;

ALTER TABLE IF EXISTS validated_shift_activities
  ADD COLUMN IF NOT EXISTS shift_key TEXT;

ALTER TABLE IF EXISTS validated_shift_activities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_validated_shifts_shift_key ON validated_shifts(shift_key);
CREATE INDEX IF NOT EXISTS idx_validated_acts_validated_shift_id ON validated_shift_activities(validated_shift_id);
CREATE INDEX IF NOT EXISTS idx_validated_acts_shift_key ON validated_shift_activities(shift_key);

-- Ensure validated user_id columns exist BEFORE any updates reference them
ALTER TABLE IF EXISTS validated_shifts
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

ALTER TABLE IF EXISTS validated_shift_activities
  ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- Best-effort backfill keys (safe if data exists; if not, no harm)
UPDATE validated_shifts
SET shift_key = site || '|' || to_char(date,'YYYY-MM-DD') || '|' || dn || '|' || COALESCE(user_id::text, user_email, '')
WHERE shift_key IS NULL OR shift_key = '';

UPDATE validated_shift_activities vsa
SET shift_key = COALESCE(vsa.shift_key, vs.shift_key, vsa.site || '|' || to_char(vsa.date,'YYYY-MM-DD') || '|' || vsa.dn || '|' || COALESCE(vsa.user_id::text, vsa.user_email, '')),
    validated_shift_id = COALESCE(vsa.validated_shift_id, vs.id)
FROM validated_shifts vs
WHERE (vsa.validated_shift_id IS NULL OR vsa.shift_key IS NULL OR vsa.shift_key = '')
  AND vsa.site = vs.site
  AND vsa.date = vs.date
  AND vsa.dn = vs.dn
  AND (
    (vsa.user_id IS NOT NULL AND vs.user_id = vsa.user_id)
    OR (COALESCE(vsa.user_email,'') <> '' AND COALESCE(vs.user_email,'') = COALESCE(vsa.user_email,''))
  );

-- Foreign key (NOT VALID first to avoid deploy-time lock). Validate later if desired.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_validated_shift_activities_shift'
  ) THEN
    ALTER TABLE validated_shift_activities
      ADD CONSTRAINT fk_validated_shift_activities_shift
      FOREIGN KEY (validated_shift_id)
      REFERENCES validated_shifts(id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;


CREATE INDEX IF NOT EXISTS idx_validated_acts_site_date ON validated_shift_activities(site, date);
CREATE INDEX IF NOT EXISTS idx_validated_acts_site_date_dn_email ON validated_shift_activities(site, date, dn, COALESCE(user_email,''));


-- Add missing validated user_id columns (backfill-safe)
ALTER TABLE IF EXISTS validated_shifts ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE IF EXISTS validated_shift_activities ADD COLUMN IF NOT EXISTS user_id INTEGER;

-- Backfill validated user_id/user_name from users table where possible
UPDATE validated_shifts vs
SET user_id = u.id,
    user_name = COALESCE(NULLIF(vs.user_name,''), u.name, vs.user_email)
FROM users u
WHERE vs.user_id IS NULL
  AND vs.user_email = u.email;

UPDATE validated_shift_activities vsa
SET user_id = u.id,
    user_name = COALESCE(NULLIF(vsa.user_name,''), u.name, vsa.user_email)
FROM users u
WHERE vsa.user_id IS NULL
  AND vsa.user_email = u.email;

-- POWER BI / VALIDATED SCHEMA UPGRADES
-- Goal: add stable keys and FK relationships so Power BI can model a star schema.
-- This block is idempotent and safe to run on existing DBs.

-- 1) validated_shifts: add shift_key + timestamps
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS shift_key TEXT;
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE validated_shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill shift_key (site|YYYY-MM-DD|dn|user_id_or_email)
UPDATE validated_shifts
SET shift_key = site || '|' || to_char(date,'YYYY-MM-DD') || '|' || dn || '|' ||
  COALESCE(user_id::text, NULLIF(user_email,''), '')
WHERE shift_key IS NULL OR shift_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_validated_shifts_shift_key ON validated_shifts(shift_key);
CREATE INDEX IF NOT EXISTS idx_validated_shifts_site_date ON validated_shifts(site, date);
CREATE INDEX IF NOT EXISTS idx_validated_shifts_user_id ON validated_shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_validated_shifts_user_email ON validated_shifts(user_email);

-- 2) validated_shift_activities: add validated_shift_id FK + shift_key mirror + timestamps
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS validated_shift_id INTEGER;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS shift_key TEXT;
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE validated_shift_activities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill validated_shift_id using user_id first (preferred)
UPDATE validated_shift_activities vsa
SET validated_shift_id = vs.id
FROM validated_shifts vs
WHERE vsa.validated_shift_id IS NULL
  AND vsa.site = vs.site
  AND vsa.date = vs.date
  AND vsa.dn = vs.dn
  AND vsa.user_id IS NOT NULL
  AND vs.user_id = vsa.user_id;

-- Fallback backfill by email (if user_id missing)
UPDATE validated_shift_activities vsa
SET validated_shift_id = vs.id
FROM validated_shifts vs
WHERE vsa.validated_shift_id IS NULL
  AND vsa.site = vs.site
  AND vsa.date = vs.date
  AND vsa.dn = vs.dn
  AND COALESCE(vsa.user_email,'') <> ''
  AND COALESCE(vs.user_email,'') = COALESCE(vsa.user_email,'');

-- Backfill shift_key mirror from validated_shifts once validated_shift_id set
UPDATE validated_shift_activities vsa
SET shift_key = vs.shift_key
FROM validated_shifts vs
WHERE vsa.validated_shift_id = vs.id
  AND (vsa.shift_key IS NULL OR vsa.shift_key = '');

-- Indexes for BI queries
CREATE INDEX IF NOT EXISTS idx_vsa_validated_shift_id ON validated_shift_activities(validated_shift_id);
CREATE INDEX IF NOT EXISTS idx_vsa_shift_key ON validated_shift_activities(shift_key);
CREATE INDEX IF NOT EXISTS idx_vsa_activity ON validated_shift_activities(activity);
CREATE INDEX IF NOT EXISTS idx_vsa_site_date ON validated_shift_activities(site, date);

-- Add FK constraint (NOT VALID then validate to avoid long locks)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_vsa_validated_shift'
  ) THEN
    ALTER TABLE validated_shift_activities
      ADD CONSTRAINT fk_vsa_validated_shift
      FOREIGN KEY (validated_shift_id)
      REFERENCES validated_shifts(id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END$$;

ALTER TABLE validated_shift_activities VALIDATE CONSTRAINT fk_vsa_validated_shift;

-- =============================
-- RECONCILIATION LAYER (Option A)
-- =============================
-- Stores month-level reconciliation targets entered by Site Admins.
-- These DO NOT modify validated_shifts / validated_shift_activities.
-- Instead, reporting can union/apply daily allocations from validated_reconciliation_days.

CREATE TABLE IF NOT EXISTS validated_reconciliations (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  -- Month key stored as 'YYYY-MM' (e.g. '2026-03')
  month_ym TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  reconciled_total NUMERIC NOT NULL DEFAULT 0,
  -- 'validated_only' (default) or 'captured_all'
  basis TEXT NOT NULL DEFAULT 'validated_only',
  -- 'spread_daily' (default), 'month_end', 'custom'
  method TEXT NOT NULL DEFAULT 'spread_daily',
  notes TEXT,
  is_locked BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id INTEGER,
  -- Audit snapshots of what the system computed when saved/recalculated
  actual_total_snapshot NUMERIC,
  delta_snapshot NUMERIC,
  computed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site, month_ym, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_vr_site_month ON validated_reconciliations(site, month_ym);
CREATE INDEX IF NOT EXISTS idx_vr_metric ON validated_reconciliations(metric_key);

CREATE TABLE IF NOT EXISTS validated_reconciliation_days (
  id SERIAL PRIMARY KEY,
  reconciliation_id INTEGER NOT NULL REFERENCES validated_reconciliations(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  month_ym TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  date DATE NOT NULL,
  allocated_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(reconciliation_id, date)
);

CREATE INDEX IF NOT EXISTS idx_vrd_site_date ON validated_reconciliation_days(site, date);
CREATE INDEX IF NOT EXISTS idx_vrd_metric ON validated_reconciliation_days(metric_key);
CREATE INDEX IF NOT EXISTS idx_vrd_month ON validated_reconciliation_days(month_ym);
