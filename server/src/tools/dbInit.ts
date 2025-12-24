import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/pg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const initPath = path.resolve(__dirname, '..', 'db', 'init.sql');
  if (!fs.existsSync(initPath)) {
    console.error('[db:init] init.sql not found at:', initPath);
    process.exit(1);
  }

  const sql = fs.readFileSync(initPath, 'utf8');
  if (!sql.trim()) {
    console.error('[db:init] init.sql is empty:', initPath);
    process.exit(1);
  }

  try {
    console.log('[db:init] applying', initPath);
    await pool.query(sql);
    console.log('[db:init] done');
  } catch (e: any) {
    console.error('[db:init] FAILED:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
