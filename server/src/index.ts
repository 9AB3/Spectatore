import 'dotenv/config';

import express from 'express';
import cors from 'cors';
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
import pushRoutes from './routes/push.js';

const isDev = process.env.NODE_ENV !== 'production';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();

async function ensureDbColumns() {
  try {
    await pool.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS meta_json JSONB DEFAULT '{}'::jsonb`);
  } catch (e:any) {
    console.warn('[db] ensure columns failed:', e?.message || e);
  }
}
ensureDbColumns();


app.use(express.json({ limit: '5mb' }));

app.use(
  cors(
    isDev
      ? { origin: true, credentials: true }
      : { origin: CORS_ORIGIN, credentials: true },
  ),
);

app.options(
  '*',
  cors(
    isDev
      ? { origin: true, credentials: true }
      : { origin: CORS_ORIGIN, credentials: true },
  ),
);

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
app.use('/api/push', pushRoutes);

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
    console.error('Startup failed:', err);
    process.exit(1);
  });
