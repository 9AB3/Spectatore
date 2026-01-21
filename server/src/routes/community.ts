import { Router } from 'express';
import geoip from 'geoip-lite';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

/**
 * Lightweight heartbeat endpoint.
 * Records at most 1 row per user per minute (bucket) to keep volume low.
 * We derive country from request IP and do not store raw IP.
 */
router.post('/heartbeat', authMiddleware, async (req: any, res) => {
  try {
    const userId = Number(req.user_id);
    if (!userId) return res.status(400).json({ error: 'missing user' });

    const xf = (req.headers['x-forwarded-for'] as string | undefined) || '';
    const ip = (xf.split(',')[0] || req.ip || '').trim();

    const rawCountry = String((req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-geo-country'] || '') as any).trim();
    let country: string | null = rawCountry && rawCountry !== 'XX' ? rawCountry.toUpperCase().slice(0, 2) : null;
    if (!country && ip) {
      try {
        const g = geoip.lookup(ip);
        if (g?.country) country = String(g.country).toUpperCase();
      } catch {
        // ignore
      }
    }

    // Note: we intentionally do NOT store raw IPs. We store only country (coarse) + minute buckets.

    await pool.query(
      `
      INSERT INTO presence_events (user_id, bucket, country_code, user_agent)
      VALUES ($1, date_trunc('minute', now()), $2, $3)
      ON CONFLICT (user_id, bucket) DO UPDATE
        SET country_code = COALESCE(EXCLUDED.country_code, presence_events.country_code),
            user_agent = COALESCE(EXCLUDED.user_agent, presence_events.user_agent)
      `,
      [userId, country, String(req.headers['user-agent'] || '').slice(0, 300)],
    );

    return res.json({ ok: true });
  } catch (e: any) {
    console.warn('[telemetry] heartbeat failed:', e?.message || e);
    return res.status(500).json({ error: 'heartbeat failed' });
  }
});

function roundTo(n: number, step: number) {
  if (!isFinite(n)) return 0;
  return Math.round(n / step) * step;
}

router.get('/public-stats', authMiddleware, async (req: any, res) => {
  try {
    const range = String(req.query.range || 'today'); // today | 7d | 30d
    const delayMinutes = 10;     // delay to avoid true real-time inference
    const liveWindowMinutes = 15;

    const end = `now() - interval '${delayMinutes} minutes'`;
    const liveStart = `now() - interval '${delayMinutes + liveWindowMinutes} minutes'`;
    const start24h = `now() - interval '${24 * 60 + delayMinutes} minutes'`;
    const start7d = `now() - interval '${7 * 24 * 60 + delayMinutes} minutes'`;
    const start30d = `now() - interval '${30 * 24 * 60 + delayMinutes} minutes'`;

    const startExpr = range === '7d' ? start7d : range === '30d' ? start30d : start24h;

    // Live now (unique users in the live window)
    const liveQ = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id)::int AS n
      FROM presence_events
      WHERE bucket >= ${liveStart} AND bucket < ${end}
      `,
    );
    const liveNow = Number(liveQ.rows?.[0]?.n || 0);

    // Today (unique users last 24h, delayed)
    const todayQ = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id)::int AS n
      FROM presence_events
      WHERE bucket >= ${start24h} AND bucket < ${end}
      `,
    );
    const today = Number(todayQ.rows?.[0]?.n || 0);

    // Unique users by country (for selected range)
    const byCountryQ = await pool.query(
      `
      WITH uniq AS (
        SELECT DISTINCT user_id, country_code
        FROM presence_events
        WHERE bucket >= ${startExpr} AND bucket < ${end}
      )
      SELECT COALESCE(country_code, 'UNK') AS country_code,
             COUNT(*)::int AS users
      FROM uniq
      GROUP BY 1
      ORDER BY users DESC
      `,
    );

    // Privacy guardrail: suppress tiny counts by country
    const MIN_COUNTRY = 5;

    const mapAll = byCountryQ.rows
      .map((r: any) => ({ country_code: String(r.country_code || 'UNK'), users: Number(r.users || 0) }))
      .filter((r: any) => r.users >= MIN_COUNTRY);

    const topCountries = mapAll.slice(0, 10);

    // Round headline numbers a little (optional, makes inference harder + looks clean)
    const roundedStep = liveNow < 50 ? 1 : 5;

    return res.json({
      ok: true,
      range,
      delay_minutes: delayMinutes,
      live_window_minutes: liveWindowMinutes,
      live_now: roundTo(liveNow, roundedStep),
      today: roundTo(today, roundedStep),
      top_countries: topCountries,
      map: mapAll,
    });
  } catch (e: any) {
    console.warn('[community] public-stats failed:', e?.message || e);
    return res.status(500).json({ error: 'stats failed' });
  }
});

export default router;
