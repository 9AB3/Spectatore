import pg from 'pg';
const { Pool } = pg;

/**
 * Local-friendly behaviour:
 * - In production (Render), DATABASE_URL must be set.
 * - For local development, default to a common local Postgres URL.
 */
const DEFAULT_LOCAL_URL = 'postgres://postgres:postgres@127.0.0.1:5432/spectatore';
const url = (process.env.DATABASE_URL || '').trim() || DEFAULT_LOCAL_URL;

// Log only the hostname to avoid leaking credentials into terminal logs.
try {
  const u = new URL(url);
  console.log('[pg] host =', u.hostname, 'db =', (u.pathname || '').replace('/', '') || '(none)');
  if (!process.env.DATABASE_URL) {
    console.log('[pg] DATABASE_URL not set - using default local URL');
  }
} catch {
  console.log('[pg] using DATABASE_URL');
}

// Decide SSL based on hostname. Render Postgres requires SSL; local usually does not.
const isLocal = (() => {
  try {
    const u = new URL(url);
    const h = (u.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1';
  } catch {
    return url.includes('localhost') || url.includes('127.0.0.1');
  }
})();

export const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
