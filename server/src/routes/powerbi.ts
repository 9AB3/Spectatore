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


function getCaseInsensitive(obj: any, key: string) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return (obj as any)[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (String(k).toLowerCase() === lower) return (obj as any)[k];
  }
  return undefined;
}

function extractContextFromPayload(payload: any) {
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const values = getCaseInsensitive(p, 'values') || {};
    const pick = (keys: string[]) => {
      for (const k of keys) {
        const v = (getCaseInsensitive(values, k) ?? getCaseInsensitive(p, k));
        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
      }
      return null;
    };
    const equipment = pick(['Equipment','equipment','equip','machine']);
    const location = pick(['Location','location','loc','lo','heading','area']);
    const from_location = pick(['From','from','From Location','from_location','fromLocation','fromLoc','from loc']);
    const to_location = pick(['To','to','To Location','to_location','toLocation','toLoc','to loc']);
    const source = pick(['Source','source','src']);
    const destination = pick(['Destination','destination','dest','dump']);
    return { equipment, location, from_location, to_location, source, destination };
  } catch {
    return { equipment: null, location: null, from_location: null, to_location: null, source: null, destination: null };
  }
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
    const site = String(req.query.site || '').trim() || null;
    const dn = String(req.query.dn || '').trim() || null;
    const from = isYmd(String(req.query.from || '').trim()) ? String(req.query.from).trim() : null; // YYYY-MM-DD
    const to = isYmd(String(req.query.to || '').trim()) ? String(req.query.to).trim() : null;     // YYYY-MM-DD

    // Robust flattening of validated_shift_activities.payload_json for Power BI.
    // Handles:
    //  A) payload_json contains nested groups (e.g. { "Production": { "Trucks": 5 } })
    //  B) payload_json is flat (e.g. { "Trucks": 5, "Weight": 12 })
    //  C) payload_json contains a 'metrics' array of objects (legacy/alt shape)
    //
    // Also extracts common context keys for slicers:
    // equipment, location, from_location, to_location, source, destination
    const sql = `
      WITH base AS (
        SELECT
          vsa.id AS activity_id,
          vsa.site,
          vsa.date::date AS date,
          vsa.dn,
          COALESCE(vsa.user_id, vs.user_id) AS user_id,
          COALESCE(NULLIF(vsa.user_email,''), NULLIF(vs.user_email,''), '') AS user_email,
          COALESCE(NULLIF(vsa.user_name,''), NULLIF(vs.user_name,''), u.name, NULLIF(vsa.user_email,''), NULLIF(vs.user_email,''), '') AS user_name,
          COALESCE(NULLIF(vsa.activity,''), vsa.payload_json->>'activity', vsa.payload_json->>'Activity', '') AS activity,
          COALESCE(NULLIF(vsa.sub_activity,''), vsa.payload_json->>'sub_activity', vsa.payload_json->>'sub', vsa.payload_json->>'Sub', '(No Sub Activity)') AS sub_activity,
          COALESCE(vsa.payload_json, '{}'::jsonb) AS payload
        FROM validated_shift_activities vsa
        LEFT JOIN validated_shifts vs
          ON vs.site = vsa.site
         AND vs.date = vsa.date
         AND vs.dn = vsa.dn
         AND COALESCE(vs.user_email,'') = COALESCE(vsa.user_email,'')
        LEFT JOIN users u
          ON u.id = COALESCE(vsa.user_id, vs.user_id)
          OR (u.email = COALESCE(NULLIF(vsa.user_email,''), NULLIF(vs.user_email,'')) AND COALESCE(vsa.user_id, vs.user_id) IS NULL)
        WHERE ($1::text IS NULL OR vsa.site = $1)
          AND ($2::text IS NULL OR vsa.dn = $2)
          AND ($3::date IS NULL OR vsa.date >= $3)
          AND ($4::date IS NULL OR vsa.date <= $4)
      ),
      context AS (
        SELECT
          b.activity_id,
          -- Prefer values.* when present, fall back to top-level variants.
          -- Some older/alternate payload shapes use abbreviated keys like "lo" or "fromLoc".
          -- We also do a final best-effort scan of top-level keys (case-insensitive).
          COALESCE(
            b.payload->'values'->>'Equipment',
            b.payload->'values'->>'equipment',
            b.payload->>'Equipment',
            b.payload->>'equipment',
            b.payload->>'equip',
            b.payload->>'machine',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('equipment','equip','machine') LIMIT 1)
          ) AS equipment,
          COALESCE(
            b.payload->'values'->>'Location',
            b.payload->'values'->>'location',
            b.payload->>'Location',
            b.payload->>'location',
            b.payload->>'loc',
            b.payload->>'lo',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('location','loc','lo','heading','area') LIMIT 1)
          ) AS location,
          COALESCE(
            b.payload->'values'->>'From',
            b.payload->'values'->>'From Location',
            b.payload->'values'->>'from',
            b.payload->'values'->>'from_location',
            b.payload->'values'->>'fromLocation',
            b.payload->'values'->>'fromLoc',
            b.payload->>'From',
            b.payload->>'From Location',
            b.payload->>'from',
            b.payload->>'from_location',
            b.payload->>'fromLocation',
            b.payload->>'fromLoc',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('from','from_location','fromlocation','fromloc','fromlocn','fromlocname') LIMIT 1)
          ) AS from_location,
          COALESCE(
            b.payload->'values'->>'To',
            b.payload->'values'->>'To Location',
            b.payload->'values'->>'to',
            b.payload->'values'->>'to_location',
            b.payload->'values'->>'toLocation',
            b.payload->'values'->>'toLoc',
            b.payload->>'To',
            b.payload->>'To Location',
            b.payload->>'to',
            b.payload->>'to_location',
            b.payload->>'toLocation',
            b.payload->>'toLoc',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('to','to_location','tolocation','toloc','tolocn','tolocname') LIMIT 1)
          ) AS to_location,
          COALESCE(
            b.payload->'values'->>'Source',
            b.payload->'values'->>'source',
            b.payload->'values'->>'src',
            b.payload->>'Source',
            b.payload->>'source',
            b.payload->>'src',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('source','src','from') LIMIT 1)
          ) AS source,
          COALESCE(
            b.payload->'values'->>'Destination',
            b.payload->'values'->>'destination',
            b.payload->'values'->>'dest',
            b.payload->>'Destination',
            b.payload->>'destination',
            b.payload->>'dest',
            (SELECT j.value FROM jsonb_each_text(b.payload) j WHERE lower(j.key) IN ('destination','dest','dump','to') LIMIT 1)
          ) AS destination
        FROM base b
      ),
      -- Variant C: if payload contains an explicit metrics array
      metrics_array AS (
        SELECT
          b.activity_id,
          m.value->>'group' AS metric_group,
          m.value->>'key' AS metric_key,
          m.value->>'text' AS metric_text,
          NULLIF(m.value->>'value','')::double precision AS metric_value
        FROM base b
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.payload->'metrics','[]'::jsonb)) m(value)
        WHERE (m.value ? 'key')
      ),
      -- Variant A/B: recursively flatten objects to scalar leaves
      kv AS (
        SELECT
          b.activity_id,
          ARRAY[e.key]::text[] AS path,
          e.value AS val
        FROM base b
        CROSS JOIN LATERAL jsonb_each(b.payload) e(key, value)

        UNION ALL

        SELECT
          kv.activity_id,
          kv.path || e.key,
          e.value
        FROM kv
        CROSS JOIN LATERAL jsonb_each(kv.val) e(key, value)
        WHERE jsonb_typeof(kv.val) = 'object'
      ),
      metrics_kv AS (
        SELECT
          activity_id,
          CASE
            WHEN array_length(path, 1) >= 2 THEN path[1]
            ELSE '(No Group)'
          END AS metric_group,
          CASE
            WHEN array_length(path, 1) >= 2 THEN array_to_string(path[2:array_length(path, 1)], ' / ')
            ELSE path[1]
          END AS metric_key,
          CASE
            WHEN jsonb_typeof(val) IN ('string','number','boolean') THEN trim(both '"' from val::text)
            ELSE val::text
          END AS metric_text,
          CASE
            WHEN jsonb_typeof(val) = 'number' THEN (val::text)::double precision
            WHEN jsonb_typeof(val) = 'string' AND (trim(both '"' from val::text) ~ '^[-+]?[0-9]*\.?[0-9]+$')
              THEN (trim(both '"' from val::text))::double precision
            ELSE NULL
          END AS metric_value
        FROM kv
        WHERE jsonb_typeof(val) <> 'object'
          AND path[1] NOT IN ('values','equipment','Equipment','location','Location','from','From','from_location','From Location','to','To','to_location','To Location','source','Source','destination','Destination','activity','Activity','sub','sub_activity','Sub')
      ),
      all_metrics AS (
        SELECT * FROM metrics_array
        UNION ALL
        SELECT * FROM metrics_kv
      )
      SELECT
        b.date,
        b.dn,
        b.site,
        b.user_id,
        b.user_email,
        b.user_name,
        b.activity,
        b.sub_activity,
        b.payload AS payload_json,
        c.equipment,
        c.location,
        c.from_location,
        c.to_location,
        c.source,
        c.destination,
        CASE
          WHEN b.activity IN ('Hauling','Loading') THEN COALESCE(c.source, c.location, c.from_location, c.to_location)
          ELSE COALESCE(c.location, c.source, c.from_location, c.to_location)
        END AS location_slice,
        m.metric_group,
        m.metric_key,
        m.metric_text,
        m.metric_value
      FROM base b
      LEFT JOIN context c ON c.activity_id = b.activity_id
      JOIN all_metrics m ON m.activity_id = b.activity_id
      WHERE NULLIF(trim(COALESCE(m.metric_key,'')),'') IS NOT NULL
      ORDER BY b.date, b.dn, b.site, b.user_email, b.activity, b.sub_activity, m.metric_group, m.metric_key;
    `;

    const r = await pool.query(sql, [site, dn, from, to]);

    const rows = (r.rows || []).map((row: any) => {
      const missing =
        row.equipment == null &&
        row.location == null &&
        row.from_location == null &&
        row.to_location == null &&
        row.source == null &&
        row.destination == null;

      if (missing && row.payload_json) {
        const ctx = extractContextFromPayload(row.payload_json);
        row.equipment = row.equipment ?? ctx.equipment;
        row.location = row.location ?? ctx.location;
        row.from_location = row.from_location ?? ctx.from_location;
        row.to_location = row.to_location ?? ctx.to_location;
        row.source = row.source ?? ctx.source;
        row.destination = row.destination ?? ctx.destination;
      }

      delete row.payload_json;
      return row;
    });

    res.json(rows);
  } catch (e: any) {
    console.error('[powerbi] validated/activity-metrics failed', e?.message || e);
    res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
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
