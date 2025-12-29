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

    // Allow normal auth tokens for users who are:
    //  - is_admin=true (site admins)
    //  - OR have an active membership with role validator/admin (site validators)
    //
    // We attach a unified `req.site_admin` object for both cases.
    if (payload?.id) {
      pool
        .query(
          `SELECT id, name, email, site, is_admin
             FROM users
            WHERE id=$1`,
          [payload.id],
        )
        .then(async (r) => {
          const u = r.rows?.[0];
          if (!u?.id) return res.status(403).json({ error: 'forbidden' });

          // Spectatore super-admin (users.is_admin=true)
          // Can manage/validate across all sites.
          if (u.is_admin) {
            req.site_admin = {
              username: u.name || u.email || 'Admin',
              sites: ['*'],
              can_manage: true,
              is_validator: true,
            };
            return next();
          }

          // Validators via membership
          try {
            const mr = await pool.query(
              `SELECT COALESCE(s.name, m.site, m.site_name) as site, m.role
                 FROM site_memberships m
                 LEFT JOIN admin_sites s ON s.id=m.site_id
                WHERE m.user_id=$1 AND LOWER(COALESCE(m.status,'')) IN ('active','approved') AND LOWER(COALESCE(m.role,'')) IN ('validator','admin','site_admin','site_validator')`,
              [u.id],
            );
                        const sites = (mr.rows || []).map((x: any) => String(x.site)).filter(Boolean);
            if (!sites.length) return res.status(403).json({ error: 'forbidden' });
            const can_manage = (mr.rows || []).some((x: any) => ['admin','site_admin'].includes(String(x.role).toLowerCase()));
            req.site_admin = {
              username: u.name || u.email || 'Validator',
              sites,
              can_manage,
              is_validator: true,
            };
            return next();
          } catch {
            return res.status(403).json({ error: 'forbidden' });
          }
        })
        .catch(() => res.status(401).json({ error: 'invalid token' }));
      return;
    }

    return res.status(403).json({ error: 'forbidden' });
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
