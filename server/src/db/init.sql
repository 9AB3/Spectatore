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
  created_at TIMESTAMPTZ DEFAULT now()
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
  created_at TIMESTAMPTZ DEFAULT now()
);


-- SHIFTS (store site for fast filtering; also keep user_id reference)
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  user_email TEXT,
  user_name TEXT,
  site TEXT NOT NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  totals_json JSONB DEFAULT '{}'::jsonb,
  meta_json JSONB DEFAULT '{}'::jsonb,
  finalized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, date, dn)
);


CREATE INDEX IF NOT EXISTS idx_shifts_site_date ON shifts(site, date);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);

-- ACTIVITIES
CREATE TABLE IF NOT EXISTS shift_activities (
  id SERIAL PRIMARY KEY,
  shift_id INT REFERENCES shifts(id) ON DELETE CASCADE,
  user_email TEXT,
  user_name TEXT,
  site TEXT NOT NULL,
  activity TEXT NOT NULL,
  sub_activity TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acts_shift ON shift_activities(shift_id);
CREATE INDEX IF NOT EXISTS idx_acts_site ON shift_activities(site);
CREATE INDEX IF NOT EXISTS idx_acts_activity ON shift_activities(activity, sub_activity);

-- VALIDATION LAYER
-- NOTE: validated_days was unused and always empty in the UI; removing it.
DROP TABLE IF EXISTS validated_days;

CREATE TABLE IF NOT EXISTS validated_shifts (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  validated INTEGER NOT NULL DEFAULT 0,
  totals_json JSONB DEFAULT '{}'::jsonb
);


CREATE INDEX IF NOT EXISTS idx_vshifts_site_date ON validated_shifts(site, date);

ALTER TABLE IF EXISTS validated_shifts ADD COLUMN IF NOT EXISTS validated INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS validated_shift_activities (
  id SERIAL PRIMARY KEY,
  site TEXT NOT NULL,
  date DATE NOT NULL,
  dn TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  activity TEXT NOT NULL,
  sub_activity TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}'::jsonb
);

-- Backfill columns if DB already exists
ALTER TABLE IF EXISTS shifts ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE IF EXISTS shifts ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE IF EXISTS shift_activities ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE IF EXISTS shift_activities ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE IF EXISTS validated_shifts ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE IF EXISTS validated_shift_activities ADD COLUMN IF NOT EXISTS user_name TEXT;

CREATE INDEX IF NOT EXISTS idx_vacts_site_date ON validated_shift_activities(site, date);

-- USER FEEDBACK
CREATE TABLE IF NOT EXISTS user_feedback (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  user_name TEXT,
  site TEXT,
  message TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  declined BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_approved ON user_feedback(approved);

CREATE TABLE IF NOT EXISTS user_feedback_votes (
  id SERIAL PRIMARY KEY,
  feedback_id INT NOT NULL REFERENCES user_feedback(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(feedback_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_votes_feedback ON user_feedback_votes(feedback_id);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;


-- PUSH SUBSCRIPTIONS (Web Push)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
