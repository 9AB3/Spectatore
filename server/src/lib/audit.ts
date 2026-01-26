import { pool } from './pg.js';

// Lightweight audit log helper.
//
// This is intentionally "best effort": it must never block a request.
// Store small JSON in meta for investigation (avoid large payloads).

// Keep this as a wide string type so adding new audit actions doesn't
// require touching this file every time.
//
// Convention: use dotted namespaces like "billing.*", "site.*", "auth.*".
export type AuditAction = string;

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
