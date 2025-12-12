import { Router } from 'express';
import { db } from '../lib/db';

const router = Router();

router.get('/search', (req, res) => {
  const name = ((req.query.name as string) || '').trim();
  if (!name) return res.json({ items: [] });
  const like = `%${name}%`;
  db.all(
    'SELECT id, name, email FROM users WHERE name LIKE ? ORDER BY name LIMIT 50',
    [like],
    (err, rows) => {
      if (err) return res.status(400).json({ error: 'query failed' });
      res.json({ items: rows });
    },
  );
});

export default router;
