import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { pool } from './pg.js';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

export function authMiddleware(req: any, res: any, next: any) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    const payload: any = jwt.verify(m[1], JWT_SECRET);
    req.user_id = payload.id;
    // Backwards compatible: still expose role if present, but prefer is_admin flag
    req.role = payload.role;
    req.is_admin = !!payload.is_admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Separate middleware for Site Admin tools
export function siteAdminMiddleware(req: any, res: any, next: any) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    const payload: any = jwt.verify(m[1], JWT_SECRET);

    // Dedicated Site Admin token (legacy / super-admin)
    if (payload?.type === 'site_admin') {
      req.site_admin = {
        username: payload.username,
        sites: Array.isArray(payload.sites) ? payload.sites : ['*'],
      };
      return next();
    }

    // Allow normal auth tokens for users flagged as is_admin=true.
    // These users are scoped to their own site in all Site Admin tools.
    if (payload?.is_admin && payload?.id) {
      // Look up the user's site so we can enforce site-scoping server-side.
      pool
        .query('SELECT id, name, email, site FROM users WHERE id=$1', [payload.id])
        .then((r) => {
          const u = r.rows?.[0];
          if (!u?.site) {
            return res.status(403).json({ error: 'forbidden' });
          }
          req.site_admin = {
            username: u.name || u.email || 'Admin',
            sites: [String(u.site)],
          };
          return next();
        })
        .catch(() => res.status(401).json({ error: 'invalid token' }));
      return;
    }

    return res.status(403).json({ error: 'forbidden' });
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
