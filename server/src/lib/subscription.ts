import { pool } from './pg.js';
import { auditLog } from './audit.js';

export function isSubscriptionEnforced(): boolean {
  return String(process.env.STRIPE_ENFORCE_SUBSCRIPTION || '0') === '1';
}

function getDevBypass(email: string | null | undefined): boolean {
  const devBypassEnabled = String(process.env.STRIPE_DEV_BYPASS || '0') === '1';
  if (!devBypassEnabled) return false;
  const allowEmails = (process.env.STRIPE_DEV_BYPASS_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const e = String(email || '').trim().toLowerCase();
  return !!e && allowEmails.includes(e);
}

/**
 * Enforces that the authenticated user has an active subscription
 * (or is admin / billing_exempt / dev-bypass / within paid window).
 *
 * NOTE: This middleware assumes req.user_id has already been populated
 * by authMiddleware.
 */
export async function requireActiveSubscription(req: any, res: any, next: any) {
  try {
    if (!isSubscriptionEnforced()) return next();

    const path = String(req.originalUrl || req.url || '');
    // Always allow billing + auth endpoints when enforced so users can subscribe.
    if (path.startsWith('/api/billing') || path.startsWith('/api/auth') || path.startsWith('/api/public')) {
      return next();
    }

    const userId = Number(req.user_id || 0);
    if (!userId) return res.status(401).json({ error: 'invalid token' });

    const r = await pool.query(
      `SELECT email, is_admin, billing_exempt, subscription_status, current_period_end
         FROM users
        WHERE id=$1`,
      [userId],
    );
    const u = r.rows?.[0];
    if (!u) return res.status(401).json({ error: 'invalid token' });

    const status = String(u.subscription_status || '').toLowerCase();
    const active = status === 'active' || status === 'trialing';
    const cpe = u.current_period_end ? new Date(u.current_period_end).getTime() : 0;
    const withinPaidWindow = !!cpe && cpe > Date.now();
    const devBypass = getDevBypass(u.email);

    // Reflect DB truth for downstream handlers
    req.is_admin = !!u.is_admin;

    const allowed = !!u.billing_exempt || !!u.is_admin || devBypass || active || withinPaidWindow;
    if (!allowed) {
      await auditLog('auth.blocked.subscription_required', {
        user_id: userId,
        ip: String(req.ip || ''),
        ua: String(req.headers?.['user-agent'] || ''),
        meta: {
          path,
          subscription_status: u.subscription_status || null,
          current_period_end: u.current_period_end || null,
        },
      });
      return res.status(402).json({ error: 'subscription_required', code: 'SUBSCRIPTION_REQUIRED' });
    }

    return next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
