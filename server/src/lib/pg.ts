import pg from 'pg';
const { Pool } = pg;

console.log('[pg] DATABASE_URL =', process.env.DATABASE_URL);


const url = process.env.DATABASE_URL || '';
if (!url) {
  // Fail fast with a helpful message
  throw new Error('DATABASE_URL is not set');
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
