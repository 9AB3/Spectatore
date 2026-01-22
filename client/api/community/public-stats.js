const { getBackendBase, pickHeader } = require('./_util');

/**
 * Vercel Function proxy for Community public stats.
 * Keeps Community API calls same-origin and forwards auth.
 */
module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    const base = getBackendBase();
    if (!base) {
      res.statusCode = 500;
      return res.end('Missing SPECTATORE_API_BASE (or VITE_API_BASE) for Vercel Function');
    }

    const auth = pickHeader(req, 'authorization') || '';
    const range = (req.query && req.query.range) ? String(req.query.range) : 'today';

    const r = await fetch(`${base}/api/community/public-stats?range=${encodeURIComponent(range)}`, {
      method: 'GET',
      headers: {
        ...(auth ? { Authorization: auth } : {}),
      },
    });

    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    return res.end(text);
  } catch (e) {
    res.statusCode = 500;
    return res.end('Public stats proxy failed');
  }
};
