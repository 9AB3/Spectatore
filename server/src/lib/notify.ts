import { pool } from './pg.js';
import { sendPushToUser } from './push.js';

export async function notify(
  user_id: number,
  type: string,
  title: string,
  body: string,
  payload: any = {},
  pushUrl: string = '/Notifications',
) {
  // 🔍 HARD TRACE — this should appear ONCE per real event
  console.log('[notify] called', {
    user_id,
    type,
    title,
    pushUrl,
    payload,
    ts: new Date().toISOString(),
  });

  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, payload_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [user_id, type, title, body, JSON.stringify(payload || {})],
    );

    console.log('[notify] db insert ok', { user_id, type });
  } catch
