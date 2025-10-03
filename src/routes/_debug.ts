import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import { readUserSnapshots } from '../utils/rateLimit.js';

const router = Router();

// Expose last-known rate limit snapshots for the current user (dev only)
router.get('/api/_debug/rate-limit', (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).end();
  }
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const snaps = readUserSnapshots(userId);
  return res.status(200).json({ userId, ...snaps });
});

export default router;


