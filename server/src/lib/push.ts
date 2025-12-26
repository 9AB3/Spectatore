import webpush from 'web-push';
import { pool } from './pg.js';

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:no-reply@spectatore.com').trim();

let configured = false;
let warnedMissing = false;

function ensureConfigured() {
  if (configured) return;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    if (!warnedMissing) {
      console.warn('[push] VAPID keys missing; push disabled in this environment');
      warnedMissing = true;
    }
    configured = false;
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  console.log('[push] VAPID configured');
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
        WHERE user_id=$1
        ORDER BY id DESC`,
      [user_id],
    );

    const subs = r.rows || [];
    console.log(`[push] user=${user_id} subs=${subs.length}`);

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
        await webpush.sendNotification(sub as any, msg, {
          TTL: 60,          // short TTL prevents old queued notifications
          urgency: 'high',  // better chance of timely delivery
        } as any);

        console.log(`[push] ok user=${user_id} sub_id=${s.id}`);
      } catch (e: any) {
        const status = Number(e?.statusCode || e?.status || 0);
        const body = String(e?.body || '');
        const message = String(e?.message || e);

        console.warn(`[push] FAIL user=${user_id} sub_id=${s.id} status=${status} msg=${message} body=${body}`);

        // 404/410 => expired/invalid subscription, remove it
        if (status === 404 || status === 410) {
          try {
            await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
            console.log(`[push] deleted stale sub_id=${s.id}`);
          } catch (delErr: any) {
            console.warn('[push] failed to delete stale sub:', delErr?.message || delErr);
          }
        }

        // 401/403 usually means VAPID mismatch (frontend key vs backend key)
        if (status === 401 || status === 403) {
          console.warn('[push] 401/403 suggests VAPID key mismatch or invalid authorization');
        }
      }
    }
  } catch (e: any) {
    console.warn('[push] sendPushToUser crashed:', e?.message || e);
  }
}
