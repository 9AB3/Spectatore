import 'dotenv/config';

import express from 'express';
import cors, { type CorsOptions } from 'cors';
import fs from 'fs';
import path from 'path';

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

const isDev = process.env.NODE_ENV !== 'production';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

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
  } catch (e:any) {
    console.warn('[db] ensure columns failed:', e?.message || e);
  }
}
ensureDbColumns();


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

async function initDb() {
  const sqlPath = path.join(process.cwd(), 'src', 'db', 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  console.log('Postgres schema ready.');
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/health/db', async (_req, res) => {
  try {
    const r = await pool.query('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.use('/api/shifts', shiftsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/site-admin', siteAdminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/notification-preferences', notificationPreferencesRoutes);
app.use('/api/push', pushRoutes);

// Public, unauthenticated endpoints (marketing site)
app.use('/api/public', publicRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/powerbi', powerBiRoutes);
app.use('/api', dataRoutes);

const PORT = Number(process.env.PORT || 5000);

initDb()
  .then(() => {
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