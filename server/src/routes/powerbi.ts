import { Router } from 'express';
const router = Router();

// Placeholder endpoints for future Power BI integration
router.get('/datasets', (_req, res) => {
  res.json({ datasets: [] });
});

router.post('/push', (_req, res) => {
  // TODO: implement row push to Power BI Streaming dataset / REST API
  res.json({ ok: true, message: 'Power BI push placeholder' });
});

export default router;
