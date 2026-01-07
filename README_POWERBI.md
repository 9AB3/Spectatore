# Spectatore → Power BI (Get Data → Web)

This project includes a **Power BI-friendly HTTP integration** so you can build dashboards **without connecting Power BI directly to PostgreSQL**.

The endpoints live under:

```
/api/powerbi
```

They return **flat JSON tables** (Power BI ingests these cleanly).

---

## 1) Configure security (recommended)

Set this environment variable on the **server**:

```
POWERBI_TOKEN=your-long-random-token
```

If `POWERBI_TOKEN` is set, requests must include:

```
Authorization: Bearer <POWERBI_TOKEN>
```

If `POWERBI_TOKEN` is **not** set, the endpoints are **only open in dev** (`NODE_ENV != production`).

### Render
1. Open your **Spectatore web service** in Render
2. Go to **Environment**
3. Add `POWERBI_TOKEN`
4. Deploy

---

## 2) Power BI Desktop connection

1. Power BI Desktop → **Get Data** → **Web**
2. Use one of the URLs below (replace the base domain with your deployment):

Examples:
- Production custom domain: `https://spectatore.com`
- Render service domain: `https://spectatore.onrender.com`

### Auth options (pick ONE)

Power BI Desktop’s **From Web** connector can be awkward with custom headers depending on the auth mode. This project supports both:

1) **Header auth (best when it works)**
   - Get Data → Web → **Advanced**
   - Add request header:
     - `Authorization` = `Bearer <POWERBI_TOKEN>`

2) **Query-string token (most reliable)**
   - Append `?token=<POWERBI_TOKEN>` to the URL
   - In the Web connector, select **Anonymous**

Either way, you can then **Load** or **Transform Data**.

---

## 3) Available endpoints

All endpoints accept optional query params:

- `site=<site name>` (optional)
- `from=YYYY-MM-DD` (optional)
- `to=YYYY-MM-DD` (optional)

### Shift totals (one row per metric)

```
GET /api/powerbi/shift-totals?site=MineA&from=2025-12-01&to=2025-12-31
```

Returns rows like:
- `date, dn, site, user_email, user_name, metric, value_text, value_num, finalized_at`

### Activity payloads (one row per payload field)

```
GET /api/powerbi/activity-payloads?site=MineA&from=2025-12-01&to=2025-12-31
```

Returns rows like:
- `date, dn, site, user_email, user_name, activity, sub_activity, field, value_text, value_num, created_at`

### Validated (Site Admin) snapshots

```
GET /api/powerbi/validated/shift-totals?site=MineA&from=2025-12-01&to=2025-12-31
GET /api/powerbi/validated/activity-payloads?site=MineA&from=2025-12-01&to=2025-12-31
```

### Validated “FACT” tables (recommended for Power BI)

These are **typed-column** tables (one row per validated activity) so slicers/filters are straightforward.

```
GET /api/powerbi/validated/fact-hauling
GET /api/powerbi/validated/fact-hauling-loads
GET /api/powerbi/validated/fact-loading
GET /api/powerbi/validated/fact-dev-face-drilling
GET /api/powerbi/validated/fact-ground-support
GET /api/powerbi/validated/fact-production-drilling
GET /api/powerbi/validated/fact-charging
GET /api/powerbi/validated/fact-firing
GET /api/powerbi/validated/fact-hoisting
GET /api/powerbi/validated/fact-reconciliation-days
```

Each supports: `site`, `from`, `to`.

Example:

```
GET /api/powerbi/validated/fact-hauling?site=MineA&from=2025-12-01&to=2025-12-31
```

### Dimension tables for slicers

```
GET /api/powerbi/dim/sites
```

---

## 4) Quick test

Ping (no auth required):

```
GET /api/powerbi/ping
```

If you set `POWERBI_TOKEN`, test with curl:

```bash
curl -H "Authorization: Bearer $POWERBI_TOKEN" \
  "https://spectatore.com/api/powerbi/shift-totals?from=2025-12-01&to=2025-12-31"

```

Or (query-string token):

```bash
curl "https://spectatore.com/api/powerbi/validated/fact-hauling?token=$POWERBI_TOKEN&from=2025-12-01&to=2025-12-31"
```

---

## 5) Notes

- The **FACT** endpoints are the easiest to model in Power BI (clean columns).
- The older “long” endpoints (`*-totals`, `*-payloads`, `validated/activity-metrics`) are still available when you want maximum flexibility without column definitions.
- For large datasets, consider creating materialized views or adding pagination.


## Backfilling

- Validated fact endpoint:
  - `/api/powerbi/validated/fact-backfilling?token=...`
