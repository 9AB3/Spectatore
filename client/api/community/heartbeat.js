const { getBackendBase, pickHeader } = require('./_util');

/**
 * Vercel Function proxy for Community heartbeat.
 *
 * Why this exists:
 * - Vercel geo headers (x-vercel-ip-country-region) are available to Vercel Functions.
 * - Browser -> Render API won't include these headers.
 * - So we proxy via same-origin /api/community/heartbeat on Vercel and forward geo headers to Render.
 */
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    const base = getBackendBase();
    if (!base) {
      res.statusCode = 500;
      return res.end('Missing SPECTATORE_API_BASE (or VITE_API_BASE) for Vercel Function');
    }

    const auth = pickHeader(req, 'authorization') || '';
    const country = pickHeader(req, 'x-vercel-ip-country') || '';
    const region = pickHeader(req, 'x-vercel-ip-country-region') || '';

    const r = await fetch(`${base}/api/community/heartbeat`, {
      method: 'POST',
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        // Forward geo headers so Render can persist region/state.
        ...(country ? { 'x-vercel-ip-country': country } : {}),
        ...(region ? { 'x-vercel-ip-country-region': region } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    return res.end(text);
  } catch (e) {
    res.statusCode = 500;
    return res.end('Heartbeat proxy failed');
  }
};
