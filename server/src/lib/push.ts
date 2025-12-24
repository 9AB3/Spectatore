import webpush from 'web-push';
import { pool } from './pg.js';

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:no-reply@spectatore.com').trim();

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    // Not configured in this environment; silently no-op
    configured = false;
    return;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

export async function sendPushToUser(
  user_id: number,
  payload: { title: string; body: string; url?: string; tag?: string; data?: any },
) {
  try {
    ensureConfigured();
    if (!configured) return;

    const r = await pool.query(
      `SELECT id, endpoint, p256dh, auth
       FROM push_subscriptions
       WHERE user_id=$1`,
      [user_id],
    );

    const subs = r.rows || [];
    if (!subs.length) return;

    const msg = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/Notifications',
      tag: payload.tag || undefined,
      data: payload.data || undefined,
    });

    for (const s of subs) {
      const sub = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };

      try {
        await webpush.sendNotification(sub as any, msg);
      } catch (e: any) {
        const status = Number(e?.statusCode || e?.status || 0);
        // 404/410 => expired/invalid subscription, remove it
        if (status === 404 || status === 410) {
          try {
            await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
          } catch {}
        } else {
          // Keep the sub; just log
          console.warn('[push] send failed:', status || '', e?.message || e);
        }
      }
    }
  } catch (e: any) {
    console.warn('[push] sendPushToUser failed:', e?.message || e);
  }
}
