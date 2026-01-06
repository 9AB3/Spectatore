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

    const site = String(req.query.site || '').trim() || null;
    const from = isYmd(String(req.query.from || '').trim()) ? String(req.query.from || '').trim() : null;
    const to = isYmd(String(req.query.to || '').trim()) ? String(req.query.to || '').trim() : null;

    // Long-format metrics table:
    // - one row per metric (Distance, Tonnes Hauled, etc.)
    // - one row per UNIQUE load weight (deduped) with a load_count column
    // - task_id groups all metric rows that belong to the same underlying task (validated_shift_activity id)
    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS task_id,
          vs.id  AS validated_shift_id,
          vs.date::timestamptz AS date,
          vs.date::date AS date_ymd,
          vs.dn,
          vs.site,
          vs.user_id,
          u.email AS user_email,
          u.name  AS user_name,
          vsa.activity,
          vsa.sub_activity,
          vsa.payload_json
        FROM validated_shift_activities vsa
        JOIN validated_shifts vs ON vs.id = vsa.validated_shift_id
        LEFT JOIN users u ON u.id = vs.user_id
        WHERE ($1::text IS NULL OR vs.site = $1)
          AND ($2::date IS NULL OR vs.date::date >= $2::date)
          AND ($3::date IS NULL OR vs.date::date <= $3::date)
      ),
      dims AS (
        SELECT
          b.*,
          NULLIF(TRIM(b.payload_json->'values'->>'Source'), '') AS source,
          NULLIF(TRIM(b.payload_json->'values'->>'From'), '')   AS from_location,
          NULLIF(TRIM(b.payload_json->'values'->>'To'), '')     AS to_location,
          NULLIF(TRIM(b.payload_json->>'equipment'), '')        AS equipment,
          NULLIF(TRIM(b.payload_json->>'location'), '')         AS location
        FROM base b
      ),
      value_metrics AS (
        SELECT
          d.task_id,
          d.validated_shift_id,
          d.date,
          d.date_ymd,
          d.dn,
          d.site,
          d.user_id,
          d.user_email,
          d.user_name,
          d.activity,
          d.sub_activity,
          d.equipment,
          d.location,
          d.from_location,
          d.to_location,
          d.source,
          kv.key::text AS metric_key,
          kv.value::text AS value_text,
          CASE
            WHEN kv.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (kv.value)::numeric
            ELSE NULL
          END AS value_num,
          NULL::int AS task_item_index,
          'metric'::text AS task_item_type,
          NULL::int AS load_count
        FROM dims d
        JOIN LATERAL jsonb_each_text(COALESCE(d.payload_json->'values', '{}'::jsonb)) kv ON true
        WHERE kv.key IS NOT NULL
          AND kv.key NOT IN ('Source','From','To')
          AND kv.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
      ),
      load_weights_raw AS (
        SELECT
          d.task_id,
          d.validated_shift_id,
          d.date,
          d.date_ymd,
          d.dn,
          d.site,
          d.user_id,
          d.user_email,
          d.user_name,
          d.activity,
          d.sub_activity,
          d.equipment,
          d.location,
          d.from_location,
          d.to_location,
          d.source,
          (lw->>'weight')::text AS weight_text,
          CASE
            WHEN (lw->>'weight') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (lw->>'weight')::numeric
            ELSE NULL
          END AS weight_num
        FROM dims d
        JOIN LATERAL jsonb_array_elements(COALESCE(d.payload_json->'loads', '[]'::jsonb)) lw ON true
        WHERE lw ? 'weight'
      ),
      load_weights AS (
        SELECT
          lwr.task_id,
          lwr.validated_shift_id,
          lwr.date,
          lwr.date_ymd,
          lwr.dn,
          lwr.site,
          lwr.user_id,
          lwr.user_email,
          lwr.user_name,
          lwr.activity,
          lwr.sub_activity,
          lwr.equipment,
          lwr.location,
          lwr.from_location,
          lwr.to_location,
          lwr.source,
          'Load Weight'::text AS metric_key,
          MIN(lwr.weight_text) AS value_text,
          lwr.weight_num AS value_num,
          NULL::int AS task_item_index,
          'load_weight'::text AS task_item_type,
          COUNT(*)::int AS load_count
        FROM load_weights_raw lwr
        WHERE lwr.weight_num IS NOT NULL
        GROUP BY
          lwr.task_id,
          lwr.validated_shift_id,
          lwr.date,
          lwr.date_ymd,
          lwr.dn,
          lwr.site,
          lwr.user_id,
          lwr.user_email,
          lwr.user_name,
          lwr.activity,
          lwr.sub_activity,
          lwr.equipment,
          lwr.location,
          lwr.from_location,
          lwr.to_location,
          lwr.source,
          lwr.weight_num
      )
      SELECT *
      FROM value_metrics
      UNION ALL
      SELECT *
      FROM load_weights
      ORDER BY date_ymd DESC, task_id DESC, task_item_type, metric_key;
    `;

    const r = await pool.query(sql, [site, from, to]);
    return res.json(r.rows);
  } catch (e: any) {
    console.error('[powerbi] validated/activity-metrics failed', e?.message || e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
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
