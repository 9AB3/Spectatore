import 'dotenv/config';

import express from 'express';
import cors, { type CorsOptions } from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './lib/pg.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import metaRoutes from './routes/meta.js';
import communityRoutes from './routes/community.js';
import powerBiRoutes from './routes/powerbi.js';
import dataRoutes from './routes/data.js';
import shiftsRoutes from './routes/shifts.js';
import reportsRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import siteAdminRoutes from './routes/siteAdmin.js';
import feedbackRoutes from './routes/feedback.js';
import notificationsRoutes from './routes/notifications.js';
import notificationPreferencesRoutes from './routes/notificationPreferences.js';
import pushRoutes from './routes/push.js';
import publicRoutes from './routes/public.js';
import workSitesRoutes from './routes/workSites.js';
import { startPresenceJobs } from './lib/presenceJobs.js';

const isDev = process.env.NODE_ENV !== 'production';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', true);

// Render/containers provide PORT at runtime; keep a sane default for local dev.
const PORT = Number.parseInt(process.env.PORT || "5000", 10);

// This server is compiled & executed as ESM on Render.
// Node ESM does not define __dirname, so we derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In dev, disable etag + caching for API responses to ensure the UI updates live
// without needing hard refreshes.
if (isDev) {
  app.set('etag', false);
}

async function ensureDbColumns() {
  // Best-effort column evolution for existing DBs. This is intentionally defensive:
  // we use ALTER TABLE IF EXISTS so fresh DBs (where the table doesn't exist yet)
  // don't fail the whole preflight.
  try {
    await pool.query(`ALTER TABLE IF EXISTS shifts ADD COLUMN IF NOT EXISTS meta_json JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS terms_version TEXT`);

    // Work Site fields (best-effort; init.sql is authoritative)
    await pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS work_site_id INT`);
    await pool.query(`ALTER TABLE IF EXISTS shifts ADD COLUMN IF NOT EXISTS work_site_id INT`);

    // Community / telemetry fields
    await pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS community_state TEXT`);
    // If older rows only have users.state populated, copy it into the canonical community_state.
    try {
      await pool.query(
        `UPDATE users
            SET community_state = UPPER(NULLIF(state,''))
          WHERE (community_state IS NULL OR community_state = '')
            AND state IS NOT NULL AND state <> ''`,
      );
    } catch {
      // ignore
    }
    await pool.query(`ALTER TABLE IF EXISTS presence_events ADD COLUMN IF NOT EXISTS country_code TEXT`);
    await pool.query(`ALTER TABLE IF EXISTS presence_events ADD COLUMN IF NOT EXISTS region_code TEXT`);
    await pool.query(`ALTER TABLE IF EXISTS presence_events ADD COLUMN IF NOT EXISTS site_id INT`);

    // presence_events schema hardening (after DB resets/migrations):
    // - bucket should be TEXT (we store minute-bucket as ISO string)
    // - ts/meta columns may be missing on older schemas
    // - ensure a unique constraint on (user_id, bucket)
    try {
      // If bucket was previously TIMESTAMPTZ and part of a PK, drop that constraint first.
      await pool.query(`ALTER TABLE IF EXISTS presence_events DROP CONSTRAINT IF EXISTS presence_events_pkey`);
      await pool.query(`ALTER TABLE IF EXISTS presence_events ALTER COLUMN bucket TYPE TEXT USING bucket::text`);
    } catch {
      // ignore (table may not exist yet, or bucket already TEXT)
    }
    await pool.query(`ALTER TABLE IF EXISTS presence_events ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ DEFAULT now()`);
    await pool.query(`ALTER TABLE IF EXISTS presence_events ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_presence_events_user_bucket ON presence_events(user_id, bucket)`,
    );

    // Realtime presence + sessions (best-effort for existing DBs)
    await pool.query(
      `CREATE TABLE IF NOT EXISTS presence_current (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        country_code TEXT NULL,
        region_code TEXT NULL,
        user_agent TEXT NULL,
        PRIMARY KEY (user_id, site_id)
      )`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_presence_current_site_last_seen ON presence_current(site_id, last_seen)`);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS presence_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        site_id INTEGER NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at TIMESTAMPTZ NULL,
        duration_seconds INTEGER NULL,
        closed_reason TEXT NULL
      )`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_presence_sessions_open ON presence_sessions(user_id, site_id) WHERE ended_at IS NULL`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_presence_sessions_site_started ON presence_sessions(site_id, started_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_presence_sessions_last_seen ON presence_sessions(last_seen)`);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS presence_daily_stats (
        day DATE NOT NULL,
        site_id INTEGER NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
        dau INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        total_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, site_id)
      )`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS presence_weekly_stats (
        week_start DATE NOT NULL,
        site_id INTEGER NOT NULL REFERENCES admin_sites(id) ON DELETE CASCADE,
        wau INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        total_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (week_start, site_id)
      )`,
    );

  } catch (e:any) {
    console.warn('[db] ensure columns failed:', e?.message || e);
  }
}
app.use(express.json({ limit: '5mb' }));

const corsOptions: CorsOptions = isDev
  ? { origin: true, credentials: true }
  : {
      origin: (origin, cb) => {
        // allow non-browser / same-origin requests
        if (!origin) return cb(null, true);
        if (CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error('CORS blocked: ' + origin), false);
      },
      credentials: true,
    };

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Prevent any intermediate caching of API responses
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// -------------------- Routes --------------------
// If these mounts are missing, the API will start but every request will 404.
// The client expects these exact prefixes (e.g. /api/auth/login).
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/powerbi', powerBiRoutes);

// Data endpoints (equipment, locations, connections, etc.) are rooted at /api
app.use('/api', dataRoutes);

app.use('/api/shifts', shiftsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/site-admin', siteAdminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/notification-preferences', notificationPreferencesRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/work-sites', workSitesRoutes);

// Handle malformed URL encodings from internet scanners (prevents noisy URIError logs).
app.use((err: any, _req: any, res: any, next: any) => {
  if (err instanceof URIError) return res.status(400).send('Bad Request');
  return next(err);
});

async function initDb() {
  // First, ensure required columns exist on *existing* databases before we run init.sql,
  // because init.sql may create indexes that reference these columns.
  try {
    await ensureDbColumns();
  } catch (e) {
    console.warn('[db] ensureDbColumns preflight failed (continuing):', e);
  }

  // Prefer the compiled-asset location (dist/db/init.sql). When the Dockerfile
  // doesn't copy the build helper scripts, postbuild may not run, so dist/db may
  // be missing. Fall back to the source location (src/db/init.sql).
  const distSqlPath = path.join(__dirname, 'db', 'init.sql');
  const srcSqlPath = path.join(process.cwd(), 'src', 'db', 'init.sql');

  const sqlPath = fs.existsSync(distSqlPath) ? distSqlPath : srcSqlPath;
  const sql = fs.readFileSync(sqlPath, 'utf-8');

  try {
    await pool.query(sql);
    console.log('Postgres schema ready.');
  } catch (err: any) {
    // If we're deploying against an older DB that predates new columns (e.g. admin_site_id/work_site_id),
    // Postgres will throw 42703 (undefined_column) when init.sql tries to create indexes. Repair + retry once.
    if (err?.code === '42703') {
      console.warn('[db] init.sql hit undefined column; attempting column repair then retry...', err?.message);
      await ensureDbColumns();
      await pool.query(sql);
      console.log('Postgres schema ready (after column repair).');
    } else {
      throw err;
    }
  }
}

initDb()
  .then(async () => {
    await ensureDbColumns();
    // Presence/engagement background jobs (safe no-op if the tables aren't present yet)
    startPresenceJobs();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API listening on 0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    // Provide a clearer message for the common local dev case where Postgres isn't running.
    const msg = (err as any)?.message || String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED')) {
      console.error('\n[db] Could not connect to Postgres. It looks like Postgres is not running or not reachable.\n');
      console.error('Fix options:');
      console.error('  1) Start local Postgres (service/pgAdmin) and ensure it listens on 127.0.0.1:5432');
      console.error('  2) OR start the provided Docker database from the project root:');
      console.error('       docker compose up -d');
      console.error('     Then initialise tables:');
      console.error('       cd server && npm run db:init');
      console.error('\nYour current DATABASE_URL is: ' + (process.env.DATABASE_URL || '(not set)'));
      console.error('\nOriginal error: ' + msg + '\n');
    } else {
      console.error('Startup failed:', err);
    }
    process.exit(1);
  });
