import 'dotenv/config';
import { pool } from '../lib/pg.js';

// Dangerous helper for local/dev only
// Usage: tsx src/tools/clearData.ts

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run in production');
  }
  await pool.query('TRUNCATE TABLE validated_shift_activities, validated_shifts RESTART IDENTITY');
  await pool.query('TRUNCATE TABLE shift_activities RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE TABLE shifts RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE TABLE equipment, locations, connections RESTART IDENTITY CASCADE');
  // keep users
  console.log('Cleared non-user data');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
