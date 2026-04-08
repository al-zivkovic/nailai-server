import { type Request, type Response, type NextFunction } from 'express';
import { getAuth } from '@clerk/express';
import getSupabase from '../utils/supabase.js';

export function requireActiveSubscription() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { data } = await getSupabase()
        .from('users')
        .select('is_subscribed')
        .eq('clerk_id', userId)
        .maybeSingle();

      if (!data?.is_subscribed) {
        return res.status(403).json({
          error: 'subscription_required',
          message: 'An active subscription is required to use this feature.',
        });
      }

      next();
    } catch (err) {
      console.error('Subscription check failed:', err);
      return res.status(403).json({
        error: 'subscription_required',
        message: 'Unable to verify subscription status.',
      });
    }
  };
}
