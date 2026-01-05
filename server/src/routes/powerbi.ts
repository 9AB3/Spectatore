import { Router } from 'express';
import { pool } from '../lib/pg.js';

const router = Router();

/**
 * Power BI integration via HTTPS (Get Data → Web).
 *
 * These endpoints intentionally return "flat" tabular JSON.
 * Power BI can ingest them directly, without requiring a DB driver.
 *
 * Security:
 * - If POWERBI_TOKEN is set, requests MUST include header:
 *     Authorization: Bearer <POWERBI_TOKEN>
 * - If POWERBI_TOKEN is NOT set, endpoints are open in dev only.
 */

function requirePowerBiAuth(req: any, res: any, next: any) {
  const token = String(process.env.POWERBI_TOKEN || '').trim();
  if (!token) {
    // Open only for local development/testing.
    if ((process.env.NODE_ENV || 'development') !== 'production') return next();
    return res.status(500).json({ error: 'POWERBI_TOKEN not configured' });
  }

  // Power BI Desktop's "From Web" connector often doesn't allow custom headers like
  // `Authorization` (it depends on the connector/auth mode). So we accept a few
  // different ways of passing the token:
  //  - Authorization: Bearer <token>
  //  - ?token=<token>
  //  - X-API-Key / X-PowerBI-Token headers
  const hdr = String(req.headers?.authorization || '').trim();
  const hdrBearer = hdr.startsWith('Bearer ') ? hdr.slice('Bearer '.length).trim() : '';
  const qToken = String(req.query?.token || '').trim();
  const xApiKey = String(req.headers?.['x-api-key'] || '').trim();
  const xPowerBi = String(req.headers?.['x-powerbi-token'] || '').trim();

  const got = hdrBearer || qToken || xApiKey || xPowerBi;
  if (!got || got !== token) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

router.get('/ping', (_req, res) => res.json({ ok: true }));

// Everything below requires auth (unless POWERBI_TOKEN is not set and we're in dev)
router.use(requirePowerBiAuth);

function asDateParam(v: any) {
  const s = String(v || '').trim();
  return s ? s : null;
}

// yyyy-mm-dd helper for validating query params
function isYmd(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * GET /api/powerbi/shift-totals?site=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns one row per (shift, metric).
 * This avoids hard-coding metric keys and stays compatible as totals_json evolves.
 */
router.get('/shift-totals', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim() || null;
    const from = asDateParam(req.query.from);
    const to = asDateParam(req.query.to);

    const r = await pool.query(
      `
      SELECT
        s.date,
        s.dn,
        s.site,
        COALESCE(NULLIF(s.user_email, ''), u.email, '') AS user_email,
        COALESCE(NULLIF(s.user_name, ''), u.name, '') AS user_name,
        kv.key AS metric,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}'
	          ELSE kv.value::text
	        END AS value_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
	            THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS value_num,
        s.finalized_at
      FROM shifts s
      LEFT JOIN users u ON u.id = s.user_id
	      CROSS JOIN LATERAL jsonb_each(COALESCE(s.totals_json, '{}'::jsonb)) kv
      WHERE ($1::text IS NULL OR s.site = $1)
        AND ($2::date IS NULL OR s.date >= $2)
        AND ($3::date IS NULL OR s.date <= $3)
      ORDER BY s.date, s.dn, user_email, kv.key
      `,
      [site, from, to]
    );

    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] shift-totals failed', e?.message || e);
    res.status(500).json({ error: 'powerbi_shift_totals_failed' });
  }
});

/**
 * GET /api/powerbi/shift-metrics?site=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns a fully-flattened "long" table from totals_json so Power BI can chart
 * specific metrics (e.g. Hauling → Production → Trucks) over time.
 *
 * Columns:
 *  - date, dn, site, user_email, user_name, finalized_at
 *  - heading        (e.g. "Hauling")
 *  - sub_activity   (e.g. "Production" / "Development" / "No Sub Activity")
 *  - metric         (e.g. "Trucks", "Weight", "Distance")
 *  - value_num      (double) when scalar is numeric or numeric-text
 *  - value_text     (text) for non-numeric scalars
 */
router.get('/shift-metrics', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim() || null;
    const from = asDateParam(req.query.from);
    const to = asDateParam(req.query.to);

    const r = await pool.query(
      `
      WITH RECURSIVE base AS (
        SELECT
          s.id AS shift_id,
          s.date,
          s.dn,
          s.site,
          s.finalized_at,
          u.email AS user_email,
          u.name AS user_name,
          COALESCE(s.totals_json, '{}'::jsonb) AS totals_json
        FROM shifts s
        JOIN users u ON u.id = s.user_id
        WHERE ($1::text IS NULL OR s.site = $1)
          AND ($2::text IS NULL OR s.date >= $2::date)
          AND ($3::text IS NULL OR s.date <= $3::date)
          AND s.finalized_at IS NOT NULL
      ),
      kv AS (
        -- level 1
        SELECT
          b.shift_id,
          b.date,
          b.dn,
          b.site,
          b.finalized_at,
          b.user_email,
          b.user_name,
          ARRAY[e.key]::text[] AS path,
          e.value AS val
        FROM base b
        CROSS JOIN LATERAL jsonb_each(b.totals_json) AS e(key, value)

        UNION ALL

        -- expand objects to any depth
        SELECT
          kv.shift_id,
          kv.date,
          kv.dn,
          kv.site,
          kv.finalized_at,
          kv.user_email,
          kv.user_name,
          kv.path || e.key,
          e.value
        FROM kv
        CROSS JOIN LATERAL jsonb_each(kv.val) AS e(key, value)
        WHERE jsonb_typeof(kv.val) = 'object'
      )
      SELECT
        date,
        dn,
        site,
        user_email,
        user_name,
        finalized_at,
        path[1] AS heading,
        CASE
          WHEN array_length(path, 1) >= 3 THEN path[2]
          ELSE 'No Sub Activity'
        END AS sub_activity,
        CASE
          WHEN array_length(path, 1) >= 3 THEN array_to_string(path[3:array_length(path, 1)], ' / ')
          WHEN array_length(path, 1) = 2 THEN path[2]
          ELSE path[1]
        END AS metric,
        CASE
          WHEN jsonb_typeof(val) = 'number' THEN (val::text)::double precision
          WHEN jsonb_typeof(val) = 'string' AND (val #>> '{}') ~ '^[-+]?[0-9]*\\.?[0-9]+$'
            THEN (val #>> '{}')::double precision
          ELSE NULL
        END AS value_num,
        CASE
          WHEN jsonb_typeof(val) = 'string' THEN val #>> '{}'
          ELSE val::text
        END AS value_text
      FROM kv
      WHERE jsonb_typeof(val) <> 'object'
      ORDER BY date, dn, user_email, heading, sub_activity, metric;
      `,
      [site, from, to]
    );

    return res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] shift-metrics failed', e?.message || e);
    return res.status(500).json({ error: 'internal', detail: String(e?.message || e) });
  }
});

/**
 * GET /api/powerbi/activity-payloads?site=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns one row per (activity row, payload key).
 * Useful when you want to build visuals by activity/sub-activity without matching
 * the app's internal payload shapes.
 */
router.get('/activity-payloads', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim() || null;
    const from = asDateParam(req.query.from);
    const to = asDateParam(req.query.to);

    const r = await pool.query(
      `
      SELECT
        s.date,
        s.dn,
        COALESCE(a.site, s.site) AS site,
        COALESCE(NULLIF(a.user_email, ''), NULLIF(s.user_email, ''), u.email, '') AS user_email,
        COALESCE(NULLIF(a.user_name, ''), NULLIF(s.user_name, ''), u.name, '') AS user_name,
        a.activity,
        a.sub_activity,
        kv.key AS field,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}'
	          ELSE kv.value::text
	        END AS value_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS value_num,
        a.created_at
      FROM shift_activities a
      JOIN shifts s ON s.id = a.shift_id
      LEFT JOIN users u ON u.id = s.user_id
	      CROSS JOIN LATERAL jsonb_each(COALESCE(a.payload_json, '{}'::jsonb)) kv
      WHERE ($1::text IS NULL OR COALESCE(a.site, s.site) = $1)
        AND ($2::date IS NULL OR s.date >= $2)
        AND ($3::date IS NULL OR s.date <= $3)
      ORDER BY s.date, s.dn, user_email, a.activity, a.sub_activity, kv.key
      `,
      [site, from, to]
    );

    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] activity-payloads failed', e?.message || e);
    res.status(500).json({ error: 'powerbi_activity_payloads_failed' });
  }
});

/**
 * Validated (Site Admin) snapshots
 */

router.get('/validated/shift-totals', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim() || null;
    const from = asDateParam(req.query.from);
    const to = asDateParam(req.query.to);

    const r = await pool.query(
      `
      SELECT
        v.date,
        v.dn,
        v.site,
        v.user_email,
        COALESCE(NULLIF(v.user_name, ''), '') AS user_name,
        kv.key AS metric,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}'
	          ELSE kv.value::text
	        END AS value_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
	            THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS value_num,
        v.validated,
        v.created_at
      FROM validated_shifts v
	      CROSS JOIN LATERAL jsonb_each(COALESCE(v.totals_json, '{}'::jsonb)) kv
      WHERE ($1::text IS NULL OR v.site = $1)
        AND ($2::date IS NULL OR v.date >= $2)
        AND ($3::date IS NULL OR v.date <= $3)
      ORDER BY v.date, v.dn, v.user_email, kv.key
      `,
      [site, from, to]
    );

    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] validated shift-totals failed', e?.message || e);
    res.status(500).json({ error: 'powerbi_validated_shift_totals_failed' });
  }
});

router.get('/validated/activity-payloads', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim() || null;
    const from = asDateParam(req.query.from);
    const to = asDateParam(req.query.to);

    const r = await pool.query(
      `
      SELECT
        a.date,
        a.dn,
        a.site,
        COALESCE(NULLIF(a.user_email, ''), '') AS user_email,
        COALESCE(NULLIF(a.user_name, ''), '') AS user_name,
        a.activity,
        a.sub_activity,
	        kv.key AS field,
	        CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE kv.value::text END AS value_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS value_num,
        a.created_at
      FROM validated_shift_activities a
	      CROSS JOIN LATERAL jsonb_each(COALESCE(a.payload_json, '{}'::jsonb)) kv
      WHERE ($1::text IS NULL OR a.site = $1)
        AND ($2::date IS NULL OR a.date >= $2)
        AND ($3::date IS NULL OR a.date <= $3)
      ORDER BY a.date, a.dn, user_email, a.activity, a.sub_activity, kv.key
      `,
      [site, from, to]
    );

    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] validated activity-payloads failed', e?.message || e);
    res.status(500).json({ error: 'powerbi_validated_activity_payloads_failed' });
  }
});
/**
 * GET /api/powerbi/validated/activity-metrics
 * Returns VALIDATED activity-level metrics flattened from validated_shift_activities.payload_json
 * Designed for Power BI:
 * - Use Anonymous auth in Power BI
 * - Append ?token=YOUR_POWERBI_TOKEN to the URL
 *
 * Output rows: one per (shift_activity x group x metric)
 * group = e.g. "Production" / "Development" / "(No Sub Activity)" etc (first-level key when payload_json is nested)
 * metric_key = the metric name (e.g. "Trucks", "Weight", "Distance", "TKMs", "Metres Drilled", etc)
 * metric_value = numeric when parseable, else null; metric_text always provided
 */
router.get('/validated/activity-metrics', async (req, res) => {
  try {
    const site = String(req.query.site || '').trim();
    const from = String(req.query.from || '').trim(); // YYYY-MM-DD
    const to = String(req.query.to || '').trim();     // YYYY-MM-DD

    const where: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (site) { where.push(`vsa.site = $${p++}`); params.push(site); }
    if (isYmd(from)) { where.push(`vs.date >= $${p++}`); params.push(from); }
    if (isYmd(to)) { where.push(`vs.date <= $${p++}`); params.push(to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // We flatten payload_json in a robust "1- or 2-level" way:
    // - If payload_json is { "Production": {...}, "Development": {...} } → group=Production, metric_key from inner object.
    // - If payload_json is { "Trucks": 5, "Weight": 45 } → group="(No Group)", metric_key from top-level.
    //
    // We also pull "context" fields out when present (equipment/location/from/to/source/destination).
    //
    // NOTE: context fields may be stored in payload_json alongside metrics. We exclude common context keys from metric flattening.
    const sql = `WITH base AS (
  SELECT
    vs.id AS shift_id,
    vsa.id AS activity_id,
    vsa.date::date AS date,
    to_char(vsa.date::date, 'YYYY-MM-DD') AS date_ymd,
    vsa.dn,
    vsa.site,
    COALESCE(vsa.user_id, vs.user_id) AS user_id,
    vsa.user_email,
    COALESCE(vsa.user_name, vs.user_name) AS user_name,
    COALESCE(vsa.activity, vsa.payload_json->>'activity', vsa.payload_json->>'Activity') AS activity,
    COALESCE(vsa.sub_activity, vsa.payload_json->>'sub', vsa.payload_json->>'sub_activity', vsa.payload_json->>'Sub') AS sub_activity,
    COALESCE(vsa.equipment,
      vsa.payload_json->'values'->>'Equipment', vsa.payload_json->'values'->>'equipment',
      vsa.payload_json->>'Equipment', vsa.payload_json->>'equipment'
    ) AS equipment,
    COALESCE(vsa.location,
      vsa.payload_json->'values'->>'Location', vsa.payload_json->'values'->>'location',
      vsa.payload_json->>'Location', vsa.payload_json->>'location'
    ) AS location,
    COALESCE(vsa.from_location,
      vsa.payload_json->'values'->>'From', vsa.payload_json->'values'->>'From Location',
      vsa.payload_json->'values'->>'from', vsa.payload_json->'values'->>'from_location',
      vsa.payload_json->>'From', vsa.payload_json->>'From Location',
      vsa.payload_json->>'from', vsa.payload_json->>'from_location'
    ) AS from_location,
    COALESCE(vsa.to_location,
      vsa.payload_json->'values'->>'To', vsa.payload_json->'values'->>'To Location',
      vsa.payload_json->'values'->>'to', vsa.payload_json->'values'->>'to_location',
      vsa.payload_json->>'To', vsa.payload_json->>'To Location',
      vsa.payload_json->>'to', vsa.payload_json->>'to_location'
    ) AS to_location,
    COALESCE(vsa.source,
      vsa.payload_json->'values'->>'Source', vsa.payload_json->'values'->>'source',
      vsa.payload_json->>'Source', vsa.payload_json->>'source'
    ) AS source,
    COALESCE(vsa.destination,
      vsa.payload_json->'values'->>'Destination', vsa.payload_json->'values'->>'destination',
      vsa.payload_json->>'Destination', vsa.payload_json->>'destination'
    ) AS destination,
    COALESCE(vsa.payload_json, '{}'::jsonb) AS payload
  FROM validated_shift_activities vsa
  LEFT JOIN validated_shifts vs
    ON vs.site = vsa.site
   AND vs.date = vsa.date
   AND vs.dn = vsa.dn
   AND vs.user_email = vsa.user_email
  WHERE 1=1
    AND (vs.validated = 1 OR vs.validated IS NULL) -- allow if shift row missing but activity exists
    AND ($1::text IS NULL OR vsa.site = $1)
    AND ($2::text IS NULL OR vsa.dn = $2)
    AND ($3::text IS NULL OR to_char(vsa.date::date,'YYYY-MM-DD') >= $3)
    AND ($4::text IS NULL OR to_char(vsa.date::date,'YYYY-MM-DD') <= $4)
),
metrics AS (
  SELECT
    b.*,
    m.value->>'group' AS metric_group,
    m.value->>'key' AS metric_key,
    m.value->>'text' AS metric_text,
    NULLIF(m.value->>'value','')::double precision AS metric_value
  FROM base b
  LEFT JOIN LATERAL (
    SELECT value
    FROM jsonb_array_elements(
      COALESCE(b.payload->'metrics', '[]'::jsonb)
    ) value
  ) m ON TRUE
),
final_rows AS (
  SELECT
    (metrics.activity_id::text || ':' || COALESCE(metrics.metric_key,'') || ':' || COALESCE(metrics.metric_text,'')) AS row_id,
    metrics.shift_id,
    metrics.activity_id,
    metrics.date,
    metrics.date_ymd,
    metrics.dn,
    metrics.site,
    metrics.user_id,
    metrics.user_email,
    metrics.user_name,
    metrics.activity,
    metrics.sub_activity,
    metrics.equipment,
    metrics.location,
    metrics.from_location,
    metrics.to_location,
    metrics.source,
    metrics.destination,
    CASE
      WHEN metrics.activity IN ('Hauling','Loading') THEN COALESCE(metrics.source, metrics.location, metrics.from_location, metrics.to_location)
      ELSE COALESCE(metrics.location, metrics.source, metrics.from_location, metrics.to_location)
    END AS location_slice,
    metrics.metric_group,
    metrics.metric_key,
    metrics.metric_text,
    metrics.metric_value
  FROM metrics
)
SELECT *
FROM final_rows
WHERE metric_key IS NOT NULL
ORDER BY date, dn, site, user_email, activity, sub_activity, row_id`;

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] validated/activity-metrics failed', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Optional: a small "dimension" endpoint Power BI can use for slicers.
 * GET /api/powerbi/dim/sites
 */
router.get('/dim/sites', async (_req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT name AS site, state, created_at
      FROM admin_sites
      WHERE TRIM(COALESCE(name,'')) <> ''
      ORDER BY name
      `
    );
    res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] dim/sites failed', e?.message || e);
    res.status(500).json({ error: 'powerbi_dim_sites_failed' });
  }
});

export default router;
