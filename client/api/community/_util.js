// Shared helpers for Vercel Serverless Functions.
// These functions are deployed alongside the Vite client on Vercel.

function getBackendBase() {
  // Prefer the same env var used by the client build if it's also set for Functions.
  const base = process.env.SPECTATORE_API_BASE || process.env.VITE_API_BASE || '';
  return String(base || '').replace(/\/$/, '');
}

function pickHeader(req, name) {
  const v = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

module.exports = { getBackendBase, pickHeader };
