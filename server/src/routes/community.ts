import { Router } from 'express';
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

    // Optional site context. When provided we maintain realtime "online now" + sessions per site.
    // site_id refers to admin_sites.id (official sites).
    const rawSiteId = req.body?.site_id;
    const siteId = rawSiteId != null && rawSiteId !== '' ? Number(rawSiteId) : null;

    // Country is derived from trusted edge headers where available (Cloudflare/Vercel/etc).
    // We intentionally do NOT store raw IPs. If no country header is present we store NULL.
    const rawCountry = String(
      (req.headers['cf-ipcountry'] ||
        req.headers['x-vercel-ip-country'] ||
        req.headers['x-geo-country'] ||
        req.headers['x-country-code'] ||
        req.headers['x-appengine-country'] ||
        '') as any,
    ).trim();

    const cc = rawCountry && rawCountry !== 'XX' ? rawCountry.toUpperCase().slice(0, 2) : '';
    const country: string | null = cc && /^[A-Z]{2}$/.test(cc) ? cc : null;

    const rawRegion = String(
      (req.headers['x-vercel-ip-country-region'] ||
        req.headers['x-geo-region'] ||
        req.headers['x-country-region'] ||
        req.headers['x-region-code'] ||
        '') as any,
    ).trim();

    // Vercel's x-vercel-ip-country-region is the *region portion* of ISO 3166-2 (often up to 3 chars).
    // We store full ISO 3166-2 code like "AU-NSW" when we can.
    const regionPart = rawRegion ? rawRegion.toUpperCase() : '';
    const regionCode: string | null =
      country && regionPart && /^[A-Z0-9]{1,3}$/.test(regionPart) ? `${country}-${regionPart}` : null;


    // Two-tier fallback: if we're in AU and region header isn't available, use the user's saved community_state.
    let finalRegionCode: string | null = regionCode;
    if (!finalRegionCode && country === 'AU') {
      try {
        const u = await pool.query('SELECT community_state FROM users WHERE id=$1', [userId]);
        const st = String(u.rows?.[0]?.community_state || '').trim().toUpperCase();
        if (st && /^[A-Z]{2,3}$/.test(st) && st !== 'UNK') {
          finalRegionCode = `AU-${st}`;
        }
      } catch {
        // ignore
      }
    }

        // Note: we intentionally do NOT store raw IPs. We store only country (coarse) + minute buckets.

        try {
      await pool.query(
        `
      INSERT INTO presence_events (user_id, bucket, ts, meta, country_code, region_code, user_agent, site_id)
      VALUES ($1, to_char(date_trunc('minute', now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI"Z"'), now(), '{}'::jsonb, $2, $3, $4, $5)
      ON CONFLICT (user_id, bucket) DO UPDATE
        SET ts = EXCLUDED.ts,
            country_code = COALESCE(EXCLUDED.country_code, presence_events.country_code),
            region_code = COALESCE(EXCLUDED.region_code, presence_events.region_code),
            user_agent = COALESCE(EXCLUDED.user_agent, presence_events.user_agent),
            site_id = COALESCE(EXCLUDED.site_id, presence_events.site_id)
      `,
        [userId, country, finalRegionCode, String(req.headers['user-agent'] || '').slice(0, 300), siteId],
      );
    } catch (e: any) {
      // If the table exists without the expected unique constraint/index (older DBs),
      // fall back to an idempotent insert without ON CONFLICT.
      const msg = String(e?.message || '');
      if (msg.includes('no unique or exclusion constraint') || msg.includes('ON CONFLICT')) {
        await pool.query(
          `
          INSERT INTO presence_events (user_id, bucket, ts, meta, country_code, region_code, user_agent, site_id)
          SELECT $1, to_char(date_trunc('minute', now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI"Z"'), now(), '{}'::jsonb, $2, $3, $4, $5
          WHERE NOT EXISTS (
            SELECT 1 FROM presence_events
            WHERE user_id=$1 AND bucket=to_char(date_trunc('minute', now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI"Z"')
          )
          `,
          [userId, country, finalRegionCode, String(req.headers['user-agent'] || '').slice(0, 300), siteId],
        );
      } else {
        throw e;
      }
    }

    // Maintain realtime presence + sessions when we have a valid site_id.
    if (siteId && Number.isFinite(siteId)) {
      try {
        await pool.query(
          `
          INSERT INTO presence_current (user_id, site_id, last_seen, country_code, region_code, user_agent)
          VALUES ($1, $2, now(), $3, $4, $5)
          ON CONFLICT (user_id, site_id) DO UPDATE
            SET last_seen = now(),
                country_code = COALESCE(EXCLUDED.country_code, presence_current.country_code),
                region_code = COALESCE(EXCLUDED.region_code, presence_current.region_code),
                user_agent = COALESCE(EXCLUDED.user_agent, presence_current.user_agent)
          `,
          [userId, siteId, country, finalRegionCode, String(req.headers['user-agent'] || '').slice(0, 300)],
        );

        // Ensure a single open session per user+site
        await pool.query(
          `
          INSERT INTO presence_sessions (user_id, site_id, started_at, last_seen)
          VALUES ($1, $2, now(), now())
          ON CONFLICT (user_id, site_id) WHERE ended_at IS NULL
          DO UPDATE SET last_seen = now()
          `,
          [userId, siteId],
        );
      } catch {
        // Non-fatal (older DBs may not have these tables yet)
      }
    }

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
    // Founder/Beta mode: show stats immediately and don't hide small counts.
    // You can tighten these guardrails later by bumping delayMinutes and MIN_* thresholds.
    const delayMinutes = 0;
    const liveWindowMinutes = 15;

    // NOTE: presence_events.bucket is stored as TEXT (minute bucket string) for compatibility.
    // For time-window queries we MUST use the real timestamp column `ts`.
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
      WHERE ts >= ${liveStart} AND ts < ${end}
      `,
    );
    const liveNow = Number(liveQ.rows?.[0]?.n || 0);

    // Today (unique users last 24h, delayed)
    const todayQ = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id)::int AS n
      FROM presence_events
      WHERE ts >= ${start24h} AND ts < ${end}
      `,
    );
    const today = Number(todayQ.rows?.[0]?.n || 0);

    // Unique users by country (for selected range)
    const byCountryQ = await pool.query(
      `
      WITH uniq AS (
        SELECT DISTINCT user_id, country_code
        FROM presence_events
        WHERE ts >= ${startExpr} AND ts < ${end}
      )
      SELECT COALESCE(country_code, 'UNK') AS country_code,
             COUNT(*)::int AS users
      FROM uniq
      GROUP BY 1
      ORDER BY users DESC
      `,
    );

    

    // --- AU state/region heat (two-tier: geo region header OR user-selected state) ---
    const byAuStateQ = await pool.query(
      `
      WITH base AS (
        SELECT user_id, bucket, country_code, region_code
        FROM presence_events
        WHERE ts >= ${startExpr} AND ts < ${end}
      ),
      uniq AS (
        SELECT DISTINCT b.user_id,
          COALESCE(
            CASE WHEN b.country_code = 'AU' AND b.region_code IS NOT NULL THEN b.region_code END,
            CASE WHEN (b.country_code = 'AU' OR b.country_code IS NULL) AND u.community_state IS NOT NULL THEN 'AU-' || u.community_state END
          ) AS region_code
        FROM base b
        LEFT JOIN users u ON u.id = b.user_id
        WHERE (b.country_code = 'AU' OR u.community_state IS NOT NULL)
      )
      SELECT COALESCE(SPLIT_PART(region_code, '-', 2), 'UNK') AS state,
             COUNT(*)::int AS users
      FROM uniq
      WHERE region_code IS NOT NULL
      GROUP BY 1
      ORDER BY users DESC
      `,
    );

    const MIN_STATE = 1;
    const auStatesAll = byAuStateQ.rows
      .map((r: any) => ({ state: String(r.state || 'UNK'), users: Number(r.users || 0) }))
      .filter((r: any) => r.users >= MIN_STATE)
      .slice(0, 12);

// Privacy guardrail: suppress tiny counts by country
    const MIN_COUNTRY = 1;

    const mapAll = byCountryQ.rows
      .map((r: any) => ({ country_code: String(r.country_code || 'UNK'), users: Number(r.users || 0) }))
      .filter((r: any) => r.users >= MIN_COUNTRY);

    const topCountries = mapAll.slice(0, 10);

    // In beta we show exact counts.
    const roundedStep = 1;

    return res.json({
      ok: true,
      range,
      delay_minutes: delayMinutes,
      live_window_minutes: liveWindowMinutes,
      live_now: roundTo(liveNow, roundedStep),
      today: roundTo(today, roundedStep),
      top_countries: topCountries,
      map: mapAll,
      au_states: auStatesAll,
    });
  } catch (e: any) {
    console.warn('[community] public-stats failed:', e?.message || e);
    return res.status(500).json({ error: 'stats failed' });
  }
});

export default router;
