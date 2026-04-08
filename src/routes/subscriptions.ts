import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import crypto from 'crypto';

import getSupabase from '../utils/supabase.js';

const router = Router();

const ACTIVE_EVENTS = new Set([
  'initial_purchase',
  'direct_sub_start',
  'trial_start',
  'trial_convert',
  'renewal',
  'uncancellation',
]);

const INACTIVE_EVENTS = new Set([
  'expiration',
  'refund',
  'billing_issue',
]);

type SuperwallWebhookPayload = {
  object: string;
  type: string;
  timestamp?: number;
  data: {
    name?: string;
    originalAppUserId?: string;
    productId?: string;
    expirationAt?: number;
    [key: string]: any;
  };
};

export async function handleSuperwallWebhook(req: Request, res: Response) {
  try {
    const webhookSecret = process.env.SUPERWALL_WEBHOOK_SECRET;
    const signature = req.headers['x-superwall-signature'] as string | undefined;

    if (webhookSecret && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload = req.body as SuperwallWebhookPayload;
    const eventType = payload.type || payload.data?.name || '';
    const data = payload.data;

    if (!data) {
      return res.status(400).json({ error: 'Missing data' });
    }

    let appUserId = (data.originalAppUserId || '').replace(/^\$SuperwallAlias:/, '');
    if (!appUserId) {
      console.warn('Webhook missing user identifier:', eventType);
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    let isSubscribed: boolean | null = null;
    if (ACTIVE_EVENTS.has(eventType)) {
      isSubscribed = true;
    } else if (INACTIVE_EVENTS.has(eventType)) {
      isSubscribed = false;
    }
    // 'cancellation' — user cancelled but subscription is still active until expiration.
    // Don't flip to false yet; 'expiration' event will handle that.

    if (isSubscribed === null) {
      console.log(`Webhook received (no status change): ${eventType} for ${appUserId}`);
      return res.status(200).json({ received: true, processed: false });
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('users')
      .update({ is_subscribed: isSubscribed, updated_at: new Date().toISOString() })
      .eq('clerk_id', appUserId);

    if (error) {
      console.error('Webhook: failed to update user:', error);
      return res.status(500).json({ error: 'Failed to update user' });
    }

    console.log(`Webhook: ${eventType} → is_subscribed=${isSubscribed} for ${appUserId}`);
    return res.status(200).json({ received: true, processed: true });
  } catch (err) {
    console.error('Error in POST /api/subscription/webhook:', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
}

router.post('/api/subscription/webhook', handleSuperwallWebhook);

// Client calls this after a Superwall purchase to flip is_subscribed immediately
router.post('/api/subscription/sync', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const supabase = getSupabase();
    const { error } = await supabase
      .from('users')
      .update({ is_subscribed: true, updated_at: new Date().toISOString() })
      .eq('clerk_id', userId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ is_subscribed: true });
  } catch (err) {
    console.error('Error in POST /api/subscription/sync:', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;
