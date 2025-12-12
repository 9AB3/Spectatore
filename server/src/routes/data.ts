import { Router } from 'express';
import { db } from '../lib/db';

const router = Router();

// Equipment
router.post('/equipment', (req, res) => {
  const { user_id, type, equipment_id } = req.body;
  const eid = (equipment_id || '').trim().toUpperCase();

  if (!user_id || !eid || !type) {
    return res.status(400).json({ error: 'missing user_id, type or equipment_id' });
  }

  db.run(
    // ignore duplicate rows instead of failing
    'INSERT OR IGNORE INTO equipment (user_id, type, equipment_id) VALUES (?,?,?)',
    [user_id, type, eid],
    function (err) {
      if (err) {
        console.error('equipment insert failed', err);
        return res.status(500).json({ error: 'insert failed', detail: String(err) });
      }
      // if it was a duplicate, lastID will be 0/null but that’s fine
      res.json({ id: this.lastID || null });
    },
  );
});

// Locations
router.post('/locations', (req, res) => {
  const { user_id, name } = req.body;
  const trimmed = (name || '').trim();

  if (!user_id || !trimmed) {
    return res.status(400).json({ error: 'missing user_id or name' });
  }

  db.run(
    // ignore duplicate rows instead of failing
    'INSERT OR IGNORE INTO locations (user_id, name) VALUES (?,?)',
    [user_id, trimmed],
    function (err) {
      if (err) {
        console.error('locations insert failed', err);
        return res.status(500).json({ error: 'insert failed', detail: String(err) });
      }
      res.json({ id: this.lastID || null });
    },
  );
});

// Delete a single equipment entry for a user
router.delete('/equipment', (req, res) => {
  const { user_id, equipment_id } = req.body || {};
  if (!user_id || !equipment_id) {
    return res.status(400).json({ error: 'missing user_id or equipment_id' });
  }

  db.run(
    'DELETE FROM equipment WHERE user_id = ? AND equipment_id = ?',
    [user_id, equipment_id],
    function (err) {
      if (err) {
        return res.status(400).json({ error: 'delete failed' });
      }
      res.json({ deleted: this.changes });
    },
  );
});

// Delete a single location entry for a user
router.delete('/locations', (req, res) => {
  const { user_id, name } = req.body || {};
  if (!user_id || !name) {
    return res.status(400).json({ error: 'missing user_id or name' });
  }

  db.run(
    'DELETE FROM locations WHERE user_id = ? AND name = ?',
    [user_id, name],
    function (err) {
      if (err) {
        return res.status(400).json({ error: 'delete failed' });
      }
      res.json({ deleted: this.changes });
    },
  );
});



// Shifts
router.post('/shifts', (req, res) => {
  const { user_id, date, day_night } = req.body;
  db.run(
    'INSERT INTO shifts (user_id, date, day_night) VALUES (?,?,?)',
    [user_id, date, day_night],
    function (err) {
      if (err) return res.status(400).json({ error: 'insert failed' });
      res.json({ id: this.lastID });
    },
  );
});

router.post('/shifts/:id/finalize', (req, res) => {
  db.run('UPDATE shifts SET finalized=1 WHERE id=?', [req.params.id], function (err) {
    if (err) return res.status(400).json({ error: 'update failed' });
    res.json({ ok: true });
  });
});

// Activities
router.post('/activities', (req, res) => {
  const { shift_id, payload } = req.body;
  db.run(
    'INSERT INTO activities (shift_id, payload) VALUES (?,?)',
    [shift_id, JSON.stringify(payload)],
    function (err) {
      if (err) return res.status(400).json({ error: 'insert failed' });
      res.json({ id: this.lastID });
    },
  );
});

// Connections (simple invite workflow)
router.post('/connections/request', (req, res) => {
  const { requester_id, addressee_id } = req.body;
  db.run(
    'INSERT INTO connections (requester_id, addressee_id, status) VALUES (?,?,?)',
    [requester_id, addressee_id, 'pending'],
    function (err) {
      if (err) return res.status(400).json({ error: 'insert failed' });
      res.json({ id: this.lastID });
    },
  );
});

router.post('/connections/:id/accept', (req, res) => {
  db.run('UPDATE connections SET status=? WHERE id=?', ['accepted', req.params.id], function (err) {
    if (err) return res.status(400).json({ error: 'update failed' });
    res.json({ ok: true });
  });
});

router.post('/connections/:id/decline', (req, res) => {
  db.run('UPDATE connections SET status=? WHERE id=?', ['declined', req.params.id], function (err) {
    if (err) return res.status(400).json({ error: 'update failed' });
    res.json({ ok: true });
  });
});

export default router;

// List Equipment by user
router.get('/equipment', (req, res) => {
  const user_id = req.query.user_id;
  db.all(
    'SELECT id, type, equipment_id FROM equipment WHERE user_id=? ORDER BY created_at DESC',
    [user_id],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

// List Locations by user
router.get('/locations', (req, res) => {
  const user_id = req.query.user_id;
  db.all(
    'SELECT id, name FROM locations WHERE user_id=? ORDER BY created_at DESC',
    [user_id],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

// Finalize: create shift + activities atomically (simple version)
router.post('/shift/finalize', (req, res) => {
  const { user_id, date, day_night, activities } = req.body;
  if (!user_id || !date || !day_night) return res.status(400).json({ error: 'missing fields' });
  db.run(
    'INSERT INTO shifts (user_id, date, day_night, finalized) VALUES (?,?,?,1)',
    [user_id, date, day_night],
    function (err) {
      if (err) return res.status(400).json({ error: 'insert shift failed' });
      const shiftId = this.lastID;
      if (!Array.isArray(activities) || activities.length === 0)
        return res.json({ ok: true, shift_id: shiftId, activities: 0 });
      const stmt = db.prepare('INSERT INTO activities (shift_id, payload) VALUES (?,?)');
      for (const a of activities) {
        stmt.run(shiftId, JSON.stringify(a));
      }
      stmt.finalize((e) => {
        if (e) return res.status(400).json({ error: 'insert activities failed' });
        res.json({ ok: true, shift_id: shiftId, activities: activities.length });
      });
    },
  );
});

// List incoming/outgoing connection requests
router.get('/connections/incoming', (req, res) => {
  const user_id = req.query.user_id;
  db.all(
    'SELECT c.id, c.requester_id, u.name, u.email, c.status, c.created_at FROM connections c JOIN users u ON u.id=c.requester_id WHERE c.addressee_id=? AND c.status="pending" ORDER BY c.created_at DESC',
    [user_id],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

router.get('/connections/outgoing', (req, res) => {
  const user_id = req.query.user_id;
  db.all(
    'SELECT c.id, c.addressee_id, u.name, u.email, c.status, c.created_at FROM connections c JOIN users u ON u.id=c.addressee_id WHERE c.requester_id=? AND c.status="pending" ORDER BY c.created_at DESC',
    [user_id],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

// List accepted connections (show the counterpart user)
router.get('/connections/accepted', (req, res) => {
  const user_id = req.query.user_id;
  const sql = `
    SELECT c.id,
      CASE WHEN c.requester_id = ? THEN c.addressee_id ELSE c.requester_id END as other_id,
      u.name, u.email, c.status, c.created_at
    FROM connections c
    JOIN users u ON u.id = CASE WHEN c.requester_id = ? THEN c.addressee_id ELSE c.requester_id END
    WHERE (c.requester_id = ? OR c.addressee_id = ?) AND c.status = 'accepted'
    ORDER BY c.created_at DESC
  `;
  db.all(sql, [user_id, user_id, user_id, user_id], (err, rows) => {
    if (err) return res.status(400).json({ error: 'query failed' });
    res.json({ items: rows });
  });
});
