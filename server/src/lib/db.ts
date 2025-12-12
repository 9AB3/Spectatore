import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'spectatore.db');
sqlite3.verbose();
export const db = new sqlite3.Database(dbPath);

export function initDb() {
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



    // Ensure is_admin column exists for older databases
    db.all("PRAGMA table_info(users)", [], (err, rows: any[]) => {
      if (err) {
        console.error('Failed to inspect users table:', err);
        return;
      }
      try {
        const cols = Array.isArray(rows) ? rows.map((r: any) => r.name) : [];
        if (!cols.includes('is_admin')) {
          db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0", (e) => {
            if (e) console.error('Failed to add is_admin column:', e);
          });
        }
        if (!cols.includes('reset_code')) {
          db.run("ALTER TABLE users ADD COLUMN reset_code TEXT", (e) => {
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
  });
  db.run(
  `CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    equipment_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, equipment_id)
  )`,
);

db.run(
  `CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  )`,
);

}
