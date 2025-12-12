import { Router } from 'express';
const router = Router();

router.get('/status', (_req, res) => {
  res.json({ offline_capable: true, version: '1.0.0' });
});

export default router;
