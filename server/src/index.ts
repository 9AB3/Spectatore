import express from 'express';
import cors from 'cors';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
import dotenv from 'dotenv';
import { initDb } from './lib/db.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import metaRoutes from './routes/meta.js';
import powerBiRoutes from './routes/powerbi.js';
import dataRoutes from './routes/data.js';
import shiftsRoutes from './routes/shifts.js';
import reportsRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';

dotenv.config();
const isDev = process.env.NODE_ENV !== 'production';
const app = express();
app.use(
  cors(isDev ? { origin: true, credentials: true } : { origin: CORS_ORIGIN, credentials: true }),
);
app.options(
  '*',
  cors(isDev ? { origin: true, credentials: true } : { origin: CORS_ORIGIN, credentials: true }),
);
app.use(express.json({ limit: '5mb' }));

app.use(express.json({ limit: '1mb' }));
app.use(
  cors(isDev ? { origin: true, credentials: true } : { origin: CORS_ORIGIN, credentials: true }),
);
app.options('*', cors({ origin: CORS_ORIGIN, credentials: true }));

app.use('/api/shifts', shiftsRoutes);
app.use('/api/reports', reportsRoutes);

app.use('/api/admin', adminRoutes);

initDb();

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/powerbi', powerBiRoutes);
app.use('/api', dataRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT as number, '0.0.0.0', () => console.log(`API listening on 0.0.0.0:${PORT}`));
