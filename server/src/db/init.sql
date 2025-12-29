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