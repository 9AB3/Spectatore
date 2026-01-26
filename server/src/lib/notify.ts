import { pool } from './pg.js';
import { sendPushToUser } from './push.js';

type PrefBucket = 'milestones' | 'crew_requests' | 'other';

function bucketForType(type: string): PrefBucket {
  const t = String(type || '').toLowerCase();
  if (t === 'milestone_broken') return 'milestones';
  if (t.startsWith('connection_') || t === 'connection_request') return 'crew_requests';
  return 'other';
}

async function getPrefs(user_id: number): Promise<any | null> {
  try {
    const r = await pool.query('SELECT * FROM notification_preferences WHERE user_id=$1', [user_id]);
    return r.rows?.[0] || null;
  } catch {
    // Table may not exist yet in some environments — default ON.
    return null;
  }
}

function normalizePrefsRow(row: any | null): any {
  if (!row) return null;
  // New schema: prefs_json JSONB
  if (row.prefs_json && typeof row.prefs_json === 'object') {
    return row.prefs_json;
  }
  // Older schema: columns stored directly
  const out: any = {};
  for (const k of ['in_app_milestones', 'in_app_crew_requests', 'push_milestones', 'push_crew_requests']) {
    if (typeof row[k] === 'boolean') out[k] = row[k];
  }
  return out;
}

async function isInAppEnabled(user_id: number, bucket: PrefBucket): Promise<boolean> {
  if (bucket === 'other') return true;
  const row = await getPrefs(user_id);
  if (!row) return true;
  const prefs = normalizePrefsRow(row) || {};
  // default ON unless explicitly disabled
  if (bucket === 'milestones') return prefs.in_app_milestones !== false;
  if (bucket === 'crew_requests') return prefs.in_app_crew_requests !== false;
  return true;
}

async function isPushEnabled(user_id: number, bucket: PrefBucket): Promise<boolean> {
  if (bucket === 'other') return true;
  const row = await getPrefs(user_id);
  if (!row) return true;
  const prefs = normalizePrefsRow(row) || {};
  // default OFF for push unless explicitly enabled
  if (bucket === 'milestones') return prefs.push_milestones === true;
  if (bucket === 'crew_requests') return prefs.push_crew_requests === true;
  return true;
}

export async function notify(
  user_id: number,
  type: string,
  title: string,
  body: string,
  payload: any = {},
  pushUrl: string = '/Notifications',
) {
  const bucket = bucketForType(type);

  // Persist the deep-link so in-app notifications can navigate too.
  const payloadWithUrl = { ...(payload || {}), url: pushUrl };

  // In-app notification
  try {
    if (await isInAppEnabled(user_id, bucket)) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, payload_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [user_id, type, title, body, JSON.stringify(payloadWithUrl)],
      );
    }
  } catch (e: any) {
    console.warn('[notify] db insert failed', e?.message || e);
  }

  // Best-effort push
  try {
    if (!(await isPushEnabled(user_id, bucket))) return;

    // Use a more specific tag where possible so distinct alerts don't overwrite each other.
    const tag =
      payload?.tag ? String(payload.tag) : payload?.metric ? `${type}:${String(payload.metric)}` : type;

    await sendPushToUser(user_id, {
      title,
      body,
      url: pushUrl,
      tag,
      data: payload || {},
    });
  } catch (e: any) {
    console.warn('[notify] push failed', e?.message || e);
  }
}
