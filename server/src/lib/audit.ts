import { pool } from './pg.js';

// Lightweight audit log helper.
//
// This is intentionally "best effort": it must never block a request.
// Store small JSON in meta for investigation (avoid large payloads).

export type AuditAction =
  | 'auth.blocked.subscription_required'
  | 'billing.status'
  | 'billing.prices'
  | 'billing.checkout.create'
  | 'billing.portal.create'
  | 'billing.plan_change'
  | 'billing.webhook.received'
  | 'billing.webhook.skipped'
  | 'billing.webhook.processed';

export async function auditLog(
  action: AuditAction,
  opts: {
    user_id?: number | null;
    ip?: string | null;
    ua?: string | null;
    meta?: any;
  } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (action, user_id, ip, ua, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        action,
        typeof opts.user_id === 'number' ? opts.user_id : null,
        opts.ip || null,
        opts.ua || null,
        (opts.meta ?? {}) as any,
      ],
    );
  } catch {
    // best-effort only
  }
}
