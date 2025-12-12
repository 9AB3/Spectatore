import fs from 'fs';
import path from 'path';
import { db } from '../lib/db.js';

function runSQL(sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const dataDir = path.resolve(process.cwd(), 'data');
  const dbFile = path.join(dataDir, 'spectatore.db');

  // Prefer removing the db file entirely; fallback to TRUNCATE if file removal fails
  try {
    if (fs.existsSync(dbFile)) {
      fs.rmSync(dbFile, { force: true });
      console.log('Deleted DB file at', dbFile);
    }
  } catch (e) {
    console.warn('File delete failed, falling back to table clears:', (e as Error).message);
    await runSQL('DELETE FROM shift_activities;');
    await runSQL('DELETE FROM shifts;');
    await runSQL('DELETE FROM users;');
    console.log('Tables cleared.');
  } finally {
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
