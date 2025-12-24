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
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, payload_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [user_id, type, title, body, JSON.stringify(payload || {})],
    );
  } catch (e) {
    console.warn('notify failed', e);
  }

  // Best-effort push (no-op if VAPID keys aren't set)
  try {
    await sendPushToUser(user_id, { title, body, url: pushUrl, tag: type, data: payload || {} });
  } catch {}
}
