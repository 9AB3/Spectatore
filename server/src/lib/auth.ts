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
    // Optional Stripe subscription enforcement
    const enforce = String(process.env.STRIPE_ENFORCE_SUBSCRIPTION || '0') === '1';
    const path = String(req.originalUrl || req.url || '');

    // Always allow the billing endpoints so a logged-in user can subscribe/manage
    // even while they are gated.
    if (enforce && path.startsWith('/api/billing')) return next();

    if (!enforce) return next();

    // Enforced: user must be subscribed unless exempt/admin/dev-bypass
    pool
      .query(
        `SELECT email, is_admin, billing_exempt, subscription_status, current_period_end
           FROM users
          WHERE id=$1`,
        [payload.id],
      )
      .then((r) => {
        const u = r.rows?.[0];
        if (!u) return res.status(401).json({ error: 'invalid token' });

        const status = String(u.subscription_status || '').toLowerCase();
        const active = status === 'active' || status === 'trialing';
        const cpe = u.current_period_end ? new Date(u.current_period_end).getTime() : 0;
        const withinPaidWindow = !!cpe && cpe > Date.now();

        const devBypassEnabled = String(process.env.STRIPE_DEV_BYPASS || '0') === '1';
        const allowEmails = (process.env.STRIPE_DEV_BYPASS_EMAILS || '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const email = String(u.email || '').toLowerCase();
        const devBypass = devBypassEnabled && !!email && allowEmails.includes(email);

        // Admin bypass: reflect DB truth
        req.is_admin = !!u.is_admin;

        const allowed = !!u.billing_exempt || !!u.is_admin || devBypass || active || withinPaidWindow;
        if (!allowed) {
          return res.status(402).json({ error: 'subscription_required', code: 'SUBSCRIPTION_REQUIRED' });
        }
        return next();
      })
      .catch(() => res.status(401).json({ error: 'invalid token' }));
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
            // NOTE: Some DBs store role/status with odd casing or whitespace (e.g. " Validator ").
            // Be tolerant here so legitimate site admins/validators don't get blocked.
            // NOTE: Some older DBs had a legacy `site` column on site_memberships.
            // Our canonical schema uses site_id + site_name only.
            // Do NOT reference m.site here or the query will fail and block validators.
            const mr = await pool.query(
              `WITH m2 AS (
                 SELECT
                   COALESCE(s.name, m.site_name) AS site,
                   LOWER(TRIM(COALESCE(NULLIF(m.role, ''), '')))     AS role_norm,
                   LOWER(TRIM(COALESCE(NULLIF(m.status, ''), 'active'))) AS status_norm
                 FROM site_memberships m
                 LEFT JOIN admin_sites s ON s.id = m.site_id
                 WHERE m.user_id = $1
               )
               SELECT site, role_norm
                 FROM m2
                WHERE status_norm IN ('active','approved')
                  AND (
                    role_norm IN ('validator','admin','site_admin','site_validator')
                    OR role_norm LIKE '%validator%'
                    OR role_norm LIKE '%admin%'
                  )`,
              [u.id],
            );
            const sites = (mr.rows || []).map((x: any) => String(x.site)).filter(Boolean);
            if (!sites.length) return res.status(403).json({ error: 'forbidden' });
            const can_manage = (mr.rows || []).some((x: any) => String(x.role_norm || '').includes('admin'));
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
