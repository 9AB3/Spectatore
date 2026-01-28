import { Router } from 'express';
import { pool } from '../lib/pg.js';
import { notify } from '../lib/notify.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// -------------------- Equipment --------------------
// Prefer authenticated user_id (JWT) but keep legacy support for clients that still send user_id.
router.post('/equipment', authMiddleware, async (req: any, res) => {
  try {
    const { user_id, type, equipment_id } = req.body || {};
    const uid = Number((req as any).user_id || user_id);
    const eid = String(equipment_id || '').trim().toUpperCase();
    const t = String(type || '').trim();
    if (!uid || !eid || !t) {
      return res.status(400).json({ error: 'missing user_id, type or equipment_id' });
    }

    // Upsert behavior: legacy clients used POST for both create + update.
    // If (user_id, equipment_id) exists, update the type.
    const r = await pool.query(
      `INSERT INTO equipment (user_id, type, equipment_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, equipment_id)
       DO UPDATE SET type=EXCLUDED.type
       RETURNING id`,
      [uid, t, eid],
    );
    return res.json({ id: r.rows[0]?.id || null });
  } catch (err) {
    console.error('equipment insert failed', err);
    return res.status(500).json({ error: 'insert failed' });
  }
});

// True edit endpoint (supports renaming equipment_id)
router.patch('/equipment/:id', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.body?.user_id);
    const id = Number(req.params?.id);
    const eid = String(req.body?.equipment_id || '').trim().toUpperCase();
    const t = String(req.body?.type || '').trim();
    if (!uid || !id || !eid || !t) {
      return res.status(400).json({ error: 'missing id, equipment_id or type' });
    }

    const r = await pool.query(
      `UPDATE equipment
          SET equipment_id=$1,
              type=$2
        WHERE id=$3 AND user_id=$4
        RETURNING id`,
      [eid, t, id, uid],
    );

    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, id: r.rows[0]?.id || id });
  } catch (err: any) {
    // Handle unique constraint collisions if renaming to an existing equipment_id.
    if (String(err?.code) === '23505') {
      return res.status(409).json({ error: 'equipment_id already exists' });
    }
    console.error('equipment update failed', err);
    return res.status(500).json({ error: 'update failed' });
  }
});

router.get('/equipment', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.query.user_id);
    if (!uid) return res.status(400).json({ error: 'missing user_id' });
    const r = await pool.query(
      'SELECT id, type, equipment_id FROM equipment WHERE user_id=$1 ORDER BY created_at DESC',
      [uid],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('equipment list failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});

router.delete('/equipment', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.body?.user_id);
    const eid = String(req.body?.equipment_id || '').trim().toUpperCase();
    if (!uid || !eid) return res.status(400).json({ error: 'missing user_id or equipment_id' });
    const r = await pool.query('DELETE FROM equipment WHERE user_id=$1 AND equipment_id=$2', [uid, eid]);
    return res.json({ deleted: r.rowCount });
  } catch (err) {
    console.error('equipment delete failed', err);
    return res.status(500).json({ error: 'delete failed' });
  }
});

// -------------------- Locations --------------------
router.post('/locations', authMiddleware, async (req: any, res) => {
  try {
    const { user_id, name, type } = req.body || {};
    const uid = Number((req as any).user_id || user_id);
    const trimmed = String(name || '').trim();
    const t = String(type || '').trim();
    if (!uid || !trimmed || !t) {
      return res.status(400).json({ error: 'missing user_id, name or type' });
    }
    const allowed = new Set(['Heading', 'Stope', 'Stockpile']);
    if (!allowed.has(t)) return res.status(400).json({ error: 'invalid location type' });

    // Upsert behavior: legacy clients used POST for both create + update.
    // If (user_id, name) exists, update the type.
    const r = await pool.query(
      `INSERT INTO locations (user_id, name, type)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, name)
       DO UPDATE SET type=EXCLUDED.type
       RETURNING id`,
      [uid, trimmed, t],
    );
    return res.json({ id: r.rows[0]?.id || null });
  } catch (err) {
    console.error('locations insert failed', err);
    return res.status(500).json({ error: 'insert failed' });
  }
});

// True edit endpoint (supports renaming location name)
router.patch('/locations/:id', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.body?.user_id);
    const id = Number(req.params?.id);
    const name = String(req.body?.name || '').trim();
    const t = String(req.body?.type || '').trim();
    if (!uid || !id || !name || !t) return res.status(400).json({ error: 'missing id, name or type' });

    const allowed = new Set(['Heading', 'Stope', 'Stockpile']);
    if (!allowed.has(t)) return res.status(400).json({ error: 'invalid location type' });

    const r = await pool.query(
      `UPDATE locations
          SET name=$1,
              type=$2
        WHERE id=$3 AND user_id=$4
        RETURNING id`,
      [name, t, id, uid],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, id: r.rows[0]?.id || id });
  } catch (err: any) {
    if (String(err?.code) === '23505') {
      return res.status(409).json({ error: 'location name already exists' });
    }
    console.error('locations update failed', err);
    return res.status(500).json({ error: 'update failed' });
  }
});

router.get('/locations', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.query.user_id);
    if (!uid) return res.status(400).json({ error: 'missing user_id' });
    const r = await pool.query(
      'SELECT id, name, type FROM locations WHERE user_id=$1 ORDER BY created_at DESC',
      [uid],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('locations list failed', err);
    return res.status(500).json({ error: 'query failed' });
  }
});

router.delete('/locations', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number((req as any).user_id || req.body?.user_id);
    const name = String(req.body?.name || '').trim();
    if (!uid || !name) return res.status(400).json({ error: 'missing user_id or name' });
    const r = await pool.query('DELETE FROM locations WHERE user_id=$1 AND name=$2', [uid, name]);
    return res.json({ deleted: r.rowCount });
  } catch (err) {
    console.error('locations delete failed', err);
    return res.status(500).json({ error: 'delete failed' });
  }
});

// -------------------- Legacy shift + activity endpoints (kept for compatibility) --------------------
router.post('/shifts', async (req, res) => {
  try {
    const { user_id, date, day_night } = req.body || {};
    const uid = Number(user_id);
    const dn = String(day_night || 'DS');
    if (!uid || !date) return res.status(400).json({ error: 'missing fields' });

    // keep legacy endpoints working with the current schema (denormalized user + required site)
    const u = await pool.query('SELECT site, email, name FROM users WHERE id=$1', [uid]);
    const site = String(u.rows?.[0]?.site || 'default');
    const user_email = String(u.rows?.[0]?.email || '');
    const user_name = String(u.rows?.[0]?.name || '');

    const r = await pool.query(
      `INSERT INTO shifts (user_id, user_email, user_name, site, date, dn, totals_json)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7::jsonb)
       ON CONFLICT (user_id, date, dn) DO UPDATE SET totals_json=EXCLUDED.totals_json
       RETURNING id`,
      [uid, user_email, user_name, site, date, dn, JSON.stringify({})],
    );
    return res.json({ id: r.rows[0].id });
  } catch (err) {
    console.error('legacy shift insert failed', err);
    return res.status(400).json({ error: 'insert failed' });
  }
});

router.post('/shifts/:id/finalize', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    await pool.query('UPDATE shifts SET finalized_at=NOW() WHERE id=$1', [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('legacy shift finalize failed', err);
    return res.status(400).json({ error: 'update failed' });
  }
});

router.post('/activities', async (req, res) => {
  try {
    const { shift_id, payload } = req.body || {};
    const sid = Number(shift_id);
    if (!sid || !payload) return res.status(400).json({ error: 'missing fields' });
    const p = payload || {};

    const sh = await pool.query('SELECT site, user_email, user_name FROM shifts WHERE id=$1', [sid]);
    const site = String(sh.rows?.[0]?.site || 'default');
    const user_email = String(sh.rows?.[0]?.user_email || '');
    const user_name = String(sh.rows?.[0]?.user_name || '');

    const r = await pool.query(
      `INSERT INTO shift_activities (shift_id, user_email, user_name, site, activity, sub_activity, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id`,
      [sid, user_email, user_name, site, p.activity || '', p.sub || '', JSON.stringify(p)],
    );
    return res.json({ id: r.rows[0].id });
  } catch (err) {
    console.error('legacy activities insert failed', err);
    return res.status(400).json({ error: 'insert failed' });
  }
});

// -------------------- Connections (simple invite workflow) --------------------
router.post('/connections/request', authMiddleware, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const { requester_id, addressee_id } = req.body || {};
    const rid = Number(req.user_id || requester_id);
    const aid = Number(addressee_id);

    if (!rid || !aid) return res.status(400).json({ error: 'missing fields' });
    if (rid === aid) return res.status(400).json({ error: 'cannot connect to self' });

    await client.query('BEGIN');

    // 1) Existing request in the same direction?
    const same = await client.query(
      'SELECT id, status FROM connections WHERE requester_id=$1 AND addressee_id=$2 LIMIT 1',
      [rid, aid],
    );

    if (same.rowCount) {
      const row = same.rows[0];
      if (row.status === 'pending' || row.status === 'accepted') {
        await client.query('COMMIT');
        return res.json({ id: row.id, status: row.status });
      }
      // revive
      await client.query('UPDATE connections SET status=$1 WHERE id=$2', ['pending', row.id]);
      await client.query('COMMIT');

      // notify + push addressee
      try {
        const u = await pool.query('SELECT name FROM users WHERE id=$1', [rid]);
        const nm = String(u.rows?.[0]?.name || 'A crew member');

        await notify(
          aid,
          'connection_request',
          'New crew request',
          `${nm} sent you a crew request.`,
          {
            requester_id: rid,
            requester_name: nm,
          },
          '/ViewConnections?tab=incoming',
        );

      } catch (e) {
        console.log('[push] connection_request failed (revive same)', e);
      }

      return res.json({ id: row.id, status: 'pending' });
    }

    // 2) Existing request in the opposite direction?
    const opp = await client.query(
      'SELECT id, status FROM connections WHERE requester_id=$1 AND addressee_id=$2 LIMIT 1',
      [aid, rid],
    );

    if (opp.rowCount) {
      const row = opp.rows[0];
      if (row.status === 'accepted') {
        await client.query('COMMIT');
        return res.json({ id: row.id, status: 'accepted' });
      }
      if (row.status === 'pending') {
        // There's already a pending request from the other user; treat as ok.
        await client.query('COMMIT');
        return res.json({ id: row.id, status: 'pending' });
      }
      // revive but flip direction to the current requester → addressee
      await client.query(
        'UPDATE connections SET requester_id=$1, addressee_id=$2, status=$3 WHERE id=$4',
        [rid, aid, 'pending', row.id],
      );
      await client.query('COMMIT');

      // notify + push addressee
      try {
        const u = await pool.query('SELECT name FROM users WHERE id=$1', [rid]);
        const nm = String(u.rows?.[0]?.name || 'A crew member');

        await notify(
          aid,
          'connection_request',
          'New crew request',
          `${nm} sent you a crew request.`,
          {
            requester_id: rid,
            requester_name: nm,
          },
          '/ViewConnections?tab=incoming',
        );

      } catch (e) {
        console.log('[push] connection_request failed (revive opp)', e);
      }

      return res.json({ id: row.id, status: 'pending' });
    }

    // 3) No existing row in either direction → insert new
    const r = await client.query(
      'INSERT INTO connections (requester_id, addressee_id, status) VALUES ($1,$2,$3) RETURNING id',
      [rid, aid, 'pending'],
    );

    await client.query('COMMIT');

    // notify + push addressee
    try {
      const u = await pool.query('SELECT name FROM users WHERE id=$1', [rid]);
      const nm = String(u.rows?.[0]?.name || 'A crew member');

      await notify(
        aid,
        'connection_request',
        'New crew request',
        `${nm} sent you a crew request.`,
        {
          requester_id: rid,
          requester_name: nm,
        },
        '/ViewConnections?tab=incoming',
      );

    } catch (e) {
      console.log('[push] connection_request failed (new)', e);
    }

    return res.json({ id: r.rows[0].id, status: 'pending' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('connections request failed', err);
    return res.status(400).json({ error: 'insert failed' });
  } finally {
    client.release();
  }
});

router.post('/connections/:id/accept', authMiddleware, async (req: any, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('UPDATE connections SET status=$1 WHERE id=$2', ['accepted', id]);

    // Notify both parties
    try {
      const r = await pool.query('SELECT requester_id, addressee_id FROM connections WHERE id=$1', [id]);
      const rid = Number(r.rows?.[0]?.requester_id || 0);
      const aid = Number(r.rows?.[0]?.addressee_id || 0);

      if (rid && aid) {
        const a = await pool.query('SELECT name FROM users WHERE id=$1', [aid]);
        const b = await pool.query('SELECT name FROM users WHERE id=$1', [rid]);
        const an = String(a.rows?.[0]?.name || 'A crew mate');
        const bn = String(b.rows?.[0]?.name || 'A crew mate');

        await notify(
          rid,
          'connection_accepted',
          'Crew request accepted',
          `${an} accepted your crew request.`,
          {
            other_id: aid,
            other_name: an,
          },
          '/ViewConnections?tab=accepted',
        );
        await notify(
          aid,
          'connection_accepted',
          'Crew request accepted',
          `You and ${bn} are now crew mates.`,
          {
            other_id: rid,
            other_name: bn,
          },
          '/ViewConnections?tab=accepted',
        );

        // push both parties
      }
    } catch (e) {
      console.log('[push] connection_accepted failed', e);
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: 'update failed' });
  }
});

router.post('/connections/:id/decline', authMiddleware, async (req: any, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('UPDATE connections SET status=$1 WHERE id=$2', ['declined', id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: 'update failed' });
  }
});

// Requester can cancel an outgoing pending request
router.post('/connections/:id/cancel', authMiddleware, async (req: any, res) => {
  try {
    const id = Number(req.params?.id || 0);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const uid = Number(req.user_id);
    const r = await pool.query('SELECT requester_id, status FROM connections WHERE id=$1', [id]);
    const row = r.rows?.[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (Number(row.requester_id) !== uid) return res.status(403).json({ error: 'forbidden' });
    if (String(row.status) !== 'pending') return res.status(400).json({ error: 'not pending' });

    await pool.query('UPDATE connections SET status=$2 WHERE id=$1', [id, 'cancelled']);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: 'update failed' });
  }
});

router.post('/connections/:id/remove', authMiddleware, async (req: any, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('UPDATE connections SET status=$1 WHERE id=$2', ['declined', id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: 'update failed' });
  }
});

router.get('/connections/incoming', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number(req.user_id || req.query.user_id);
    const r = await pool.query(
      `SELECT c.id, c.requester_id, u.name, c.status, c.created_at
         FROM connections c
         JOIN users u ON u.id=c.requester_id
        WHERE c.addressee_id=$1 AND c.status='pending'
        ORDER BY c.created_at DESC`,
      [uid],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    return res.status(400).json({ error: 'query failed' });
  }
});

// GET /api/connections/incoming-count
// Used for in-app badges on the Crew tab.
router.get('/connections/incoming-count', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number(req.user_id || req.query.user_id);
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    const r = await pool.query(
      `SELECT COUNT(1)::int AS count
         FROM connections
        WHERE addressee_id=$1 AND status='pending'`,
      [uid],
    );
    return res.json({ count: r.rows?.[0]?.count || 0 });
  } catch (err) {
    return res.status(400).json({ error: 'query failed' });
  }
});

router.get('/connections/outgoing', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number(req.user_id || req.query.user_id);
    const r = await pool.query(
      `SELECT c.id, c.addressee_id, u.name, c.status, c.created_at
         FROM connections c
         JOIN users u ON u.id=c.addressee_id
        WHERE c.requester_id=$1 AND c.status='pending'
        ORDER BY c.created_at DESC`,
      [uid],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    return res.status(400).json({ error: 'query failed' });
  }
});

router.get('/connections/accepted', authMiddleware, async (req: any, res) => {
  try {
    const uid = Number(req.user_id || req.query.user_id);
    const r = await pool.query(
      `SELECT c.id,
              CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END as other_id,
              u.name, u.email, c.status, c.created_at
         FROM connections c
         JOIN users u ON u.id = CASE WHEN c.requester_id=$1 THEN c.addressee_id ELSE c.requester_id END
        WHERE (c.requester_id=$1 OR c.addressee_id=$1) AND c.status='accepted'
        ORDER BY c.created_at DESC`,
      [uid],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    return res.status(400).json({ error: 'query failed' });
  }
});

// Finalize: create shift + activities atomically (simple version)
router.post('/shift/finalize', async (req, res) => {
  const { user_id, date, day_night, activities } = req.body || {};
  const uid = Number(user_id);
  const dn = String(day_night || 'DS');
  if (!uid || !date || !dn) return res.status(400).json({ error: 'missing fields' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query('SELECT site, email, name FROM users WHERE id=$1', [uid]);
    const site = String(u.rows?.[0]?.site || 'default');
    const user_email = String(u.rows?.[0]?.email || '');
    const user_name = String(u.rows?.[0]?.name || '');

    const up = await client.query(
      `INSERT INTO shifts (user_id, user_email, user_name, site, date, dn, totals_json, finalized_at)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7::jsonb,NOW())
       ON CONFLICT (user_id, date, dn)
       DO UPDATE SET totals_json=EXCLUDED.totals_json, finalized_at=NOW()
       RETURNING id`,
      [uid, user_email, user_name, site, date, dn, JSON.stringify({})],
    );
    const shiftId = up.rows[0].id;

    await client.query('DELETE FROM shift_activities WHERE shift_id=$1', [shiftId]);
    if (Array.isArray(activities)) {
      for (const a of activities) {
        const p = a?.payload || a || {};
        await client.query(
          `INSERT INTO shift_activities (shift_id, user_email, user_name, site, activity, sub_activity, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [shiftId, user_email, user_name, site, p.activity || '', p.sub || '', JSON.stringify(p)],
        );
      }
    }
    await client.query('COMMIT');
    return res.json({ ok: true, shift_id: shiftId, activities: Array.isArray(activities) ? activities.length : 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('legacy shift/finalize failed', err);
    return res.status(400).json({ error: 'insert failed' });
  } finally {
    client.release();
  }
});

export default router;