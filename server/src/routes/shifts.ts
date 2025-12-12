import { Router } from 'express';
import { db } from '../lib/db.js';
import { authMiddleware } from '../lib/auth.js';

const router = Router();

// GET /api/shifts/dates-with-data
// Returns distinct shift dates for the current user: { dates: ["2025-12-01", ...] }
router.get('/dates-with-data', authMiddleware, (req, res) => {
  const user_id = (req as any).user_id;
  if (!user_id) {
    return res.status(401).json({ error: 'missing user' });
  }

  db.all(
    'SELECT DISTINCT date FROM shifts WHERE user_id = ? ORDER BY date ASC',
    [user_id],
    (err, rows) => {
      if (err) {
        console.error('dates-with-data failed', err);
        return res.status(500).json({ error: 'db failed' });
      }
      const dates = rows.map((r: any) => r.date).filter(Boolean);
      res.json({ dates });
    },
  );
});


function ensureShiftTables(cb: (err?: any) => void) {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT,
      dn TEXT,
      totals_json TEXT,
      finalized_at TEXT,
      UNIQUE (user_id, date, dn)
    )`,
      (e: any) => {
        if (e) return cb(e);
        db.run(
          `CREATE TABLE IF NOT EXISTS shift_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER,
        activity TEXT,
        sub_activity TEXT,
        payload_json TEXT
      )`,
          cb,
        );
      },
    );
  });
}

// POST /api/shifts/finalize
router.post('/finalize', authMiddleware, (req, res) => {
  const { date, dn, totals, activities } = req.body || {};
  const user_id = (req as any).user_id || null;

  if (!date || !dn) return res.status(400).json({ error: 'missing date or dn' });
  if (!user_id) return res.status(401).json({ error: 'missing user' });
  if (!Array.isArray(activities))
    return res.status(400).json({ error: 'activities must be an array' });

  ensureShiftTables((err?: any) => {
    if (err) return res.status(500).json({ error: 'db init failed', detail: String(err) });
    db.serialize(() => {
      db.run('BEGIN');
      // Try update first (broad SQLite compatibility without UPSERT support)
      db.run(
        `UPDATE shifts SET totals_json=?, finalized_at=datetime('now') WHERE user_id=? AND date=? AND dn=?`,
        [JSON.stringify(totals || {}), user_id, date, dn],
        function (updateErr: any) {
          if (updateErr) {
            db.run('ROLLBACK');
            return res
              .status(500)
              .json({ error: 'update shift failed', detail: String(updateErr) });
          }
          const updated = (this as any)?.changes || 0;
          const doInsert = updated === 0;
          const insert = () => {
            db.run(
              `INSERT INTO shifts (user_id, date, dn, totals_json, finalized_at) VALUES (?,?,?,?,datetime('now'))`,
              [user_id, date, dn, JSON.stringify(totals || {})],
              function (insErr: any) {
                if (insErr) {
                  db.run('ROLLBACK');
                  return res
                    .status(500)
                    .json({ error: 'insert shift failed', detail: String(insErr) });
                }
                afterShift();
              },
            );
          };
          const afterShift = () => {
            db.get(
              'SELECT id FROM shifts WHERE user_id=? AND date=? AND dn=?',
              [user_id, date, dn],
              (ge: any, row: any) => {
                if (ge || !row) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: 'select shift failed', detail: String(ge) });
                }
                const shift_id = row.id;
                db.run('DELETE FROM shift_activities WHERE shift_id=?', [shift_id], (de: any) => {
                  if (de) {
                    db.run('ROLLBACK');
                    return res
                      .status(500)
                      .json({ error: 'delete activities failed', detail: String(de) });
                  }
                  const stmt = db.prepare(
                    'INSERT INTO shift_activities (shift_id, activity, sub_activity, payload_json) VALUES (?,?,?,?)',
                  );
                  try {
                    for (const it of activities as any[]) {
                      const p = it?.payload || {};
                      const activity = p.activity || '';
                      const sub = p.sub || '';
                      stmt.run([shift_id, activity, sub, JSON.stringify(p)]);
                    }
                    stmt.finalize((fe: any) => {
                      if (fe) {
                        db.run('ROLLBACK');
                        return res
                          .status(500)
                          .json({ error: 'insert activities failed', detail: String(fe) });
                      }
                      db.run('COMMIT', (ce: any) => {
                        if (ce)
                          return res
                            .status(500)
                            .json({ error: 'commit failed', detail: String(ce) });
                        return res.json({ ok: true, shift_id });
                      });
                    });
                  } catch (ex: any) {
                    stmt.finalize(() => {});
                    db.run('ROLLBACK');
                    return res
                      .status(500)
                      .json({ error: 'exception', detail: String(ex?.message || ex) });
                  }
                });
              },
            );
          };
          if (doInsert) insert();
          else afterShift();
        },
      );
    });
  });
});

export default router;
