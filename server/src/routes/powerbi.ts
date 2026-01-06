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
    // In production we require a token to be configured.
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
	        END AS metric_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
	            THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS metric_value,
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
  } catch (err: any) {
    console.error('[powerbi] shift-totals failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_shift_totals_failed', detail: ((err as any)?.message || String(err)) });
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
        END AS metric_value,
        CASE
          WHEN jsonb_typeof(val) = 'string' THEN val #>> '{}'
          ELSE val::text
        END AS metric_text
      FROM kv
      WHERE jsonb_typeof(val) <> 'object'
      ORDER BY date, dn, user_email, heading, sub_activity, metric;
      `,
      [site, from, to]
    );

    return res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] shift-metrics failed', err?.message || err);
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
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
	        END AS metric_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS metric_value,
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
  } catch (err: any) {
    console.error('[powerbi] activity-payloads failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_activity_payloads_failed', detail: ((err as any)?.message || String(err)) });
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
	        END AS metric_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
	            THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS metric_value,
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
  } catch (err: any) {
    console.error('[powerbi] validated shift-totals failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_shift_totals_failed', detail: ((err as any)?.message || String(err)) });
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
	        CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE kv.value::text END AS metric_text,
	        CASE
	          WHEN jsonb_typeof(kv.value) = 'number' THEN (kv.value::text)::double precision
	          WHEN jsonb_typeof(kv.value) = 'string' AND (kv.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (kv.value #>> '{}')::double precision
	          ELSE NULL
	        END AS metric_value,
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
  } catch (err: any) {
    console.error('[powerbi] validated activity-payloads failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_activity_payloads_failed', detail: ((err as any)?.message || String(err)) });
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

    const params: any[] = [
      site || null,
      isYmd(from) ? from : null,
      isYmd(to) ? to : null,
    ];

// We flatten payload_json in a robust "1- or 2-level" way:
    // - If payload_json is { "Production": {...}, "Development": {...} } → group=Production, metric_key from inner object.
    // - If payload_json is { "Trucks": 5, "Weight": 45 } → group="(No Group)", metric_key from top-level.
    //
    // We also pull "context" fields out when present (equipment/location/from/to/source/destination).
    //
    // NOTE: context fields may be stored in payload_json alongside metrics. We exclude common context keys from metric flattening.
    const sql = `WITH base AS (
  SELECT
    vsa.id AS activity_id,
    vs.id AS validated_shift_id,
    COALESCE(vs.date::date, vsa.date) AS date_ymd,
    vs.date::timestamptz AS date,
    vs.dn AS dn,
    vs.site AS site,
    vs.user_id AS user_id,
    u.email AS user_email,
    u.name  AS user_name,
    vsa.activity AS activity,
    COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
    vsa.payload_json AS payload
  FROM validated_shift_activities vsa
  LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
  LEFT JOIN users u ON u.id = vs.user_id
  WHERE vs.site = $1
    AND vs.date >= $2::date
    AND vs.date <= $3::date
),
activity_rows AS (
  SELECT
    b.*,
    COALESCE(b.payload->'values', '{}'::jsonb) AS vals,
    COALESCE(
      NULLIF(TRIM(COALESCE(b.payload->>'equipment','')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'Equipment'),'')),'')
    ) AS equipment,
    COALESCE(
      NULLIF(TRIM(COALESCE(b.payload->>'location','')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'Location'),'')),'')
    ) AS location,
    COALESCE(
      NULLIF(TRIM(COALESCE(b.payload->>'from_location','')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'From'),'')),'')
    ) AS from_location,
    COALESCE(
      NULLIF(TRIM(COALESCE(b.payload->>'to_location','')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'To'),'')),'')
    ) AS to_location,
    COALESCE(
      NULLIF(TRIM(COALESCE(b.payload->>'source','')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'Source'),'')),''),
      NULLIF(TRIM(COALESCE((b.payload->'values'->>'From'),'')),'')
    ) AS source
  FROM base b
),
typed_metrics AS (
  SELECT
    ar.activity_id AS task_row_id,
    ar.validated_shift_id AS task_id,
    NULL::int AS task_item_index,
    'metric'::text AS task_item_type,
    ar.date,
    ar.date_ymd,
    ar.dn,
    ar.site,
    ar.user_id,
    ar.user_email,
    ar.user_name,
    ar.activity,
    ar.sub_activity,
    ar.equipment,
    ar.location,
    ar.from_location,
    ar.to_location,
    ar.source,
    kv.key::text AS metric_key,
    kv.value::text AS value_text,
    CASE
      WHEN kv.value::text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (kv.value::text)::double precision
      ELSE NULL
    END AS value_num
  FROM activity_rows ar
  JOIN LATERAL jsonb_each(ar.vals) AS kv(key, value) ON true
  WHERE kv.key IS NOT NULL
    AND kv.key NOT IN ('From','To','Source','Destination','Location','Equipment','Material')
),
load_weights AS (
  SELECT
    ar.activity_id AS task_row_id,
    ar.validated_shift_id AS task_id,
    lw.ord::int AS task_item_index,
    'load'::text AS task_item_type,
    ar.date,
    ar.date_ymd,
    ar.dn,
    ar.site,
    ar.user_id,
    ar.user_email,
    ar.user_name,
    ar.activity,
    ar.sub_activity,
    ar.equipment,
    ar.location,
    ar.from_location,
    ar.to_location,
    ar.source,
    'Load Weight'::text AS metric_key,
    (lw.elem->>'weight') AS value_text,
    CASE
      WHEN (lw.elem->>'weight') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (lw.elem->>'weight')::double precision
      ELSE NULL
    END AS value_num
  FROM activity_rows ar
  JOIN LATERAL jsonb_array_elements(COALESCE(ar.payload->'loads','[]'::jsonb)) WITH ORDINALITY AS lw(elem, ord) ON true
  WHERE lw.elem ? 'weight'
)
SELECT
  task_id,
  task_row_id,
  task_item_index,
  task_item_type,
  date,
  date_ymd,
  dn,
  site,
  user_id,
  user_email,
  user_name,
  activity,
  sub_activity,
  equipment,
  location,
  from_location,
  to_location,
  source,
  metric_key,
  value_text AS metric_text,
  value_num  AS metric_value,
  value_text,
  value_num
FROM (
  SELECT * FROM typed_metrics
  UNION ALL
  SELECT * FROM load_weights
) x
ORDER BY date, dn, user_email, activity, sub_activity, task_row_id, task_item_type, task_item_index NULLS FIRST, metric_key
`;

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/activity-metrics failed', err?.message || err);
    res.status(500).json({ error: 'server_error', detail: ((err as any)?.message || String(err)) });
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
  } catch (err: any) {
    console.error('[powerbi] dim/sites failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_dim_sites_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * VALIDATED “FACT” endpoints (typed columns for Power BI slicers)
 *
 * These endpoints keep validated_shift_activities.payload_json as the source of truth,
 * but present one row per activity with stable, typed columns.
 *
 * Common query params (all optional):
 *  - site=<site name>
 *  - from=YYYY-MM-DD
 *  - to=YYYY-MM-DD
 */

// helper: optional site/from/to with basic YYYY-MM-DD validation
function parseCommonFilters(req: any) {
  const site = String(req.query.site || '').trim() || null;
  const fromRaw = String(req.query.from || '').trim();
  const toRaw = String(req.query.to || '').trim();
  const from = isYmd(fromRaw) ? fromRaw : null;
  const to = isYmd(toRaw) ? toRaw : null;
  return { site, from, to };
}

// helper used in SQL blocks (numeric parsing)
// NULLIF(regexp_replace(txt,'[^0-9.\-]','','g'),'')::numeric

/**
 * GET /api/powerbi/validated/fact-hauling
 * One row per validated hauling activity.
 */

/**
 * GET /api/powerbi/validated/activity-summary
 * Debug helper: shows which activity/sub_activity labels exist and their counts.
 */
router.get('/validated/activity-summary', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);
    const sql = `
      SELECT
        COALESCE(NULLIF(TRIM(activity), ''), '(blank)') AS activity,
        COALESCE(NULLIF(TRIM(sub_activity), ''), '(blank)') AS sub_activity,
        COUNT(*)::int AS rows
      FROM validated_shift_activities
      WHERE ($1::text IS NULL OR site = $1)
        AND ($2::date IS NULL OR date >= $2::date)
        AND ($3::date IS NULL OR date <= $3::date)
      GROUP BY 1,2
      ORDER BY rows DESC, activity, sub_activity
    `;
    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/activity-summary failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_activity_summary_failed', detail: ((err as any)?.message || String(err)) });
  }
});

router.get('/validated/fact-hauling', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          vsa.payload_json AS payload
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Hauling'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      ), x AS (
        SELECT
          b.*,
          COALESCE(b.payload->'values','{}'::jsonb) AS vals,
          b.payload->'loads' AS loads
        FROM base b
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Source'), '') AS source,
        NULLIF(TRIM(vals->>'From'), '') AS from_location,
        NULLIF(TRIM(vals->>'To'), '') AS to_location,
        NULLIF(TRIM(vals->>'Material'), '') AS material,

        CASE
          WHEN jsonb_typeof(loads) = 'array' THEN jsonb_array_length(loads)
          ELSE NULLIF(regexp_replace(COALESCE(vals->>'Trucks',''), '[^0-9]', '', 'g'), '')::int
        END AS trucks,

        NULLIF(regexp_replace(COALESCE(vals->>'Distance',''), '[^0-9.\-]', '', 'g'), '')::numeric AS distance_km,

        -- tonnes_hauled: prefer explicit "Tonnes Hauled" key, else fall back to Trucks*Weight when parseable
        COALESCE(
          NULLIF(regexp_replace(COALESCE(vals->>'Tonnes Hauled',''), '[^0-9.\-]', '', 'g'), '')::numeric,
          (
            (NULLIF(regexp_replace(COALESCE(vals->>'Trucks',''), '[^0-9]', '', 'g'), '')::numeric)
            * (NULLIF(regexp_replace(COALESCE(vals->>'Weight',''), '[^0-9.\-]', '', 'g'), '')::numeric)
          )
        ) AS tonnes_hauled,

        CASE
          WHEN jsonb_typeof(loads) = 'array' AND jsonb_array_length(loads) > 0 THEN
            (
              SELECT AVG(NULLIF(regexp_replace(COALESCE(lw->>'weight',''), '[^0-9.\-]', '', 'g'), '')::numeric)
              FROM jsonb_array_elements(loads) lw
            )
          ELSE NULLIF(regexp_replace(COALESCE(vals->>'Weight',''), '[^0-9.\-]', '', 'g'), '')::numeric
        END AS avg_load_weight_t,

        (
          COALESCE(
            NULLIF(regexp_replace(COALESCE(vals->>'Tonnes Hauled',''), '[^0-9.\-]', '', 'g'), '')::numeric,
            (
              (NULLIF(regexp_replace(COALESCE(vals->>'Trucks',''), '[^0-9]', '', 'g'), '')::numeric)
              * (NULLIF(regexp_replace(COALESCE(vals->>'Weight',''), '[^0-9.\-]', '', 'g'), '')::numeric)
            )
          )
          * NULLIF(regexp_replace(COALESCE(vals->>'Distance',''), '[^0-9.\-]', '', 'g'), '')::numeric
        ) AS tkm
      FROM x
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-hauling failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_hauling_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-hauling-loads
 * One row per hauling load weight (when payload_json.loads is present).
 */
router.get('/validated/fact-hauling-loads', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          COALESCE(vsa.sub_activity,'(No Sub Activity)') AS sub_activity,
          vsa.payload_json AS payload,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals,
          vsa.payload_json->'loads' AS loads
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Hauling'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
          AND jsonb_typeof(vsa.payload_json->'loads') = 'array'
      )
      SELECT
        b.activity_id,
        b.validated_shift_id,
        b.date,
        b.dn,
        b.site,
        b.user_id,
        b.user_email,
        b.user_name,
        b.sub_activity,

        NULLIF(TRIM(b.vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(b.vals->>'Source'), '') AS source,
        NULLIF(TRIM(b.vals->>'From'), '') AS from_location,
        NULLIF(TRIM(b.vals->>'To'), '') AS to_location,
        NULLIF(TRIM(b.vals->>'Material'), '') AS material,

        (x.ord - 1) AS load_index,
        NULLIF(regexp_replace(COALESCE(x.lw->>'weight',''), '[^0-9.\-]', '', 'g'), '')::numeric AS load_weight_t
      FROM base b
      CROSS JOIN LATERAL jsonb_array_elements(b.loads) WITH ORDINALITY AS x(lw, ord)
      ORDER BY b.date, b.dn, b.user_email, b.activity_id, load_index;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-hauling-loads failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_hauling_loads_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-loading
 * One row per validated loading activity (prod/dev).
 */
router.get('/validated/fact-loading', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Loading'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Source'), '') AS source,
        NULLIF(TRIM(vals->>'Material'), '') AS material,

        NULLIF(regexp_replace(COALESCE(vals->>'Stope to Truck',''), '[^0-9.\-]', '', 'g'), '')::numeric AS stope_to_truck,
        NULLIF(regexp_replace(COALESCE(vals->>'Stope to SP',''), '[^0-9.\-]', '', 'g'), '')::numeric AS stope_to_sp,

        NULLIF(regexp_replace(COALESCE(vals->>'Heading to Truck',''), '[^0-9.\-]', '', 'g'), '')::numeric AS heading_to_truck,
        NULLIF(regexp_replace(COALESCE(vals->>'Heading to SP',''), '[^0-9.\-]', '', 'g'), '')::numeric AS heading_to_sp,

        NULLIF(regexp_replace(COALESCE(vals->>'SP to Truck',''), '[^0-9.\-]', '', 'g'), '')::numeric AS sp_to_truck,
        NULLIF(regexp_replace(COALESCE(vals->>'SP to SP',''), '[^0-9.\-]', '', 'g'), '')::numeric AS sp_to_sp
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-loading failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_loading_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-dev-face-drilling
 * One row per validated Development → Face Drilling activity.
 */
router.get('/validated/fact-dev-face-drilling', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Development'
          AND vsa.sub_activity = 'Face Drilling'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Location'), '') AS location,

        NULLIF(regexp_replace(COALESCE(vals->>'No of Reamers',''), '[^0-9.\-]', '', 'g'), '')::numeric AS reamers,
        NULLIF(regexp_replace(COALESCE(vals->>'No of Holes',''), '[^0-9.\-]', '', 'g'), '')::numeric AS holes,
        NULLIF(regexp_replace(COALESCE(vals->>'Cut Length',''), '[^0-9.\-]', '', 'g'), '')::numeric AS cut_length_m,

        (
          NULLIF(regexp_replace(COALESCE(vals->>'No of Holes',''), '[^0-9.\-]', '', 'g'), '')::numeric
          * NULLIF(regexp_replace(COALESCE(vals->>'Cut Length',''), '[^0-9.\-]', '', 'g'), '')::numeric
        ) AS dev_drill_m
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-dev-face-drilling failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_dev_face_drilling_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-ground-support
 * One row per validated Development → Ground Support or Rehab.
 */
router.get('/validated/fact-ground-support', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Development'
          AND vsa.sub_activity IN ('Ground Support', 'Rehab')
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Location'), '') AS location,

        NULLIF(TRIM(vals->>'Bolt Type'), '') AS bolt_type,
        NULLIF(regexp_replace(COALESCE(vals->>'Bolt Length',''), '[^0-9.\-]', '', 'g'), '')::numeric AS bolt_length_m,
        NULLIF(regexp_replace(COALESCE(vals->>'No. of Bolts',''), '[^0-9.\-]', '', 'g'), '')::numeric AS bolts,
        NULLIF(regexp_replace(COALESCE(vals->>'Agi Volume',''), '[^0-9.\-]', '', 'g'), '')::numeric AS agi_volume,
        NULLIF(regexp_replace(COALESCE(vals->>'Spray Volume',''), '[^0-9.\-]', '', 'g'), '')::numeric AS spray_volume,

        (
          NULLIF(regexp_replace(COALESCE(vals->>'No. of Bolts',''), '[^0-9.\-]', '', 'g'), '')::numeric
          * NULLIF(regexp_replace(COALESCE(vals->>'Bolt Length',''), '[^0-9.\-]', '', 'g'), '')::numeric
        ) AS gs_drill_m
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-ground-support failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_ground_support_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-production-drilling
 * One row per validated Production Drilling activity.
 */
router.get('/validated/fact-production-drilling', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Production Drilling'
          AND vsa.sub_activity IN ('Stope','Service Hole')
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Location'), '') AS location,

        NULLIF(regexp_replace(COALESCE(vals->>'Metres Drilled',''), '[^0-9.\-]', '', 'g'), '')::numeric AS metres_drilled_m,
        NULLIF(regexp_replace(COALESCE(vals->>'Cleanouts Drilled',''), '[^0-9.\-]', '', 'g'), '')::numeric AS cleanouts_drilled_m,
        NULLIF(regexp_replace(COALESCE(vals->>'Redrills',''), '[^0-9.\-]', '', 'g'), '')::numeric AS redrills_m
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-production-drilling failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_production_drilling_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-charging
 * One row per validated Charging activity (dev + prod).
 */
router.get('/validated/fact-charging', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Charging'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(TRIM(vals->>'Equipment'), '') AS equipment,
        NULLIF(TRIM(vals->>'Location'), '') AS location,

        NULLIF(regexp_replace(COALESCE(vals->>'No of Holes',''), '[^0-9.\-]', '', 'g'), '')::numeric AS holes,
        NULLIF(regexp_replace(COALESCE(vals->>'Charge Metres',''), '[^0-9.\-]', '', 'g'), '')::numeric AS charge_metres,
        NULLIF(regexp_replace(COALESCE(vals->>'Charge kg',''), '[^0-9.\-]', '', 'g'), '')::numeric AS charge_kg,
        NULLIF(regexp_replace(COALESCE(vals->>'Cut Length',''), '[^0-9.\-]', '', 'g'), '')::numeric AS cut_length_m,
        NULLIF(regexp_replace(COALESCE(vals->>'Tonnes Fired',''), '[^0-9.\-]', '', 'g'), '')::numeric AS tonnes_fired
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-charging failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_charging_failed', detail: ((err as any)?.message || String(err)) });
  }
});

/**
 * GET /api/powerbi/validated/fact-hoisting
 * One row per validated Hoisting activity.
 */
router.get('/validated/fact-hoisting', async (req, res) => {
  try {
    const { site, from, to } = parseCommonFilters(req);

    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vs.id AS validated_shift_id,
          COALESCE(vs.date::date, vsa.date) AS date,
          COALESCE(vs.dn, vsa.dn) AS dn,
          COALESCE(vs.site, vsa.site) AS site,
          COALESCE(vs.user_id, vsa.user_id) AS user_id,
          COALESCE(u.email, vs.user_email, vsa.user_email, '') AS user_email,
          COALESCE(u.name, vs.user_name, vsa.user_name, vs.user_email, vsa.user_email, '') AS user_name,
          vsa.activity,
          COALESCE(NULLIF(vsa.sub_activity,''),'(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json->'values','{}'::jsonb) AS vals
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE vsa.activity = 'Hoisting'
          AND ($1::text IS NULL OR COALESCE(vs.site, vsa.site) = $1)
          AND ($2::date IS NULL OR COALESCE(vs.date, vsa.date) >= $2::date)
          AND ($3::date IS NULL OR COALESCE(vs.date, vsa.date) <= $3::date)
      )
      SELECT
        activity_id,
        validated_shift_id,
        date,
        dn,
        site,
        user_id,
        user_email,
        user_name,
        activity,
        sub_activity,

        NULLIF(regexp_replace(COALESCE(vals->>'Ore Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric AS ore_tonnes,
        NULLIF(regexp_replace(COALESCE(vals->>'Waste Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric AS waste_tonnes,
        (
          NULLIF(regexp_replace(COALESCE(vals->>'Ore Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric
          + NULLIF(regexp_replace(COALESCE(vals->>'Waste Tonnes',''), '[^0-9.\-]', '', 'g'), '')::numeric
        ) AS total_tonnes
      FROM base
      ORDER BY date, dn, user_email, activity_id;
    `;

    const r = await pool.query(sql, [site, from, to]);
    res.json(r.rows);
  } catch (err: any) {
    console.error('[powerbi] validated/fact-hoisting failed', err?.message || err);
    res.status(500).json({ error: 'powerbi_validated_fact_hoisting_failed', detail: ((err as any)?.message || String(err)) });
  }
});


export default router;
