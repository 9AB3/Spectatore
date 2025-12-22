import path from 'path';
import fs from 'fs';

// IMPORTANT:
// - Do NOT `import sqlite3 from 'sqlite3'` here.
// - Alpine builds often fail to compile native sqlite3 bindings,
//   and TS will also fail if the module is missing at build time.
let sqlite3: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite3 = require('sqlite3');
  if (sqlite3?.verbose) sqlite3.verbose();
} catch (e) {
  sqlite3 = null;
  console.warn('⚠️ sqlite3 module not available in this build/runtime:', e);
}

// Prefer explicit DB_PATH (Render), otherwise pick a sensible default
const dbPath =
  process.env.DB_PATH ||
  (process.env.NODE_ENV === 'production'
    ? '/var/data/data.db'
    : path.resolve(process.cwd(), 'data', 'spectatore.db'));

// Only create the local ./data dir for local dev
if (process.env.NODE_ENV !== 'production' && !process.env.DB_PATH) {
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

// Export a db handle (may be null if sqlite3 not available)
export const db: any =
  sqlite3 && sqlite3.Database
    ? new sqlite3.Database(dbPath, (err: any) => {
        if (err) console.error('❌ Failed to open DB:', dbPath, err);
        else console.log('✅ SQLite DB opened at:', dbPath);
      })
    : null;

export function initDb() {
  if (!db) {
    throw new Error(
      'SQLite DB is not available. sqlite3 module is missing in this environment.',
    );
  }

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      site TEXT,
      state TEXT,
      email_confirmed INTEGER DEFAULT 0,
      confirm_code TEXT,
      is_admin INTEGER DEFAULT 0,
      reset_code TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS failed_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      ip TEXT,
      ts TEXT DEFAULT (datetime('now')),
      reason TEXT
    )`);

    // Ensure columns exist for older databases
    db.all('PRAGMA table_info(users)', [], (err: any, rows: any[]) => {
      if (err) {
        console.error('Failed to inspect users table:', err);
        return;
      }
      try {
        const cols = Array.isArray(rows) ? rows.map((r: any) => r.name) : [];
        if (!cols.includes('is_admin')) {
          db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0', (e: any) => {
            if (e) console.error('Failed to add is_admin column:', e);
          });
        }
        if (!cols.includes('reset_code')) {
          db.run('ALTER TABLE users ADD COLUMN reset_code TEXT', (e: any) => {
            if (e) console.error('Failed to add reset_code column:', e);
          });
        }
      } catch (e) {
        console.error('Error ensuring users columns:', e);
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL,
      addressee_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT,
      dn TEXT,
      totals_json TEXT,
      finalized_at TEXT,
      UNIQUE (user_id, date, dn)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS shift_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER,
      activity TEXT,
      sub_activity TEXT,
      payload_json TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      equipment_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, equipment_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    )`);

    // Ensure type column exists for older databases
    db.all('PRAGMA table_info(locations)', [], (err: any, rows: any[]) => {
      if (err) {
        console.error('Failed to inspect locations table:', err);
        return;
      }
      try {
        const cols = Array.isArray(rows) ? rows.map((r: any) => r.name) : [];
        if (!cols.includes('type')) {
          db.run('ALTER TABLE locations ADD COLUMN type TEXT', (e: any) => {
            if (e) console.error('Failed to add locations.type column:', e);
          });
        }
      } catch (e) {
        console.error('Error ensuring locations columns:', e);
      }
    });
  });
}
