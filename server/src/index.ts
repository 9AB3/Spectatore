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

const isDev = process.env.NODE_ENV !== 'production';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

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
  try {
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS meta_json JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT`);
    // Work Site fields (best-effort; init.sql is authoritative)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS work_site_id INT`);
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS work_site_id INT`);
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