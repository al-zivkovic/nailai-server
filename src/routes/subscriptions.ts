import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import crypto from 'crypto';

import getSupabase from '../utils/supabase.js';
import getOrCreateInternalUserId from '../utils/userLookup.js';

const router = Router();

// Subscription status types
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired' | 'incomplete' | 'incomplete_expired' | 'paused';
type SubscriptionSource = 'superwall' | 'stripe' | 'app_store' | 'play_store' | 'manual';

// Superwall webhook event types
type SuperwallEvent = {
  event: string;
  user_id?: string;
  alias?: string;
  product_id?: string;
  transaction_id?: string;
  environment?: string;
  app_user_id?: string;
  revenue?: number;
  currency?: string;
  period_type?: 'NORMAL' | 'TRIAL' | 'INTRO';
  expiration_at?: string;
  purchased_at?: string;
  [key: string]: any;
};

// Get current user's subscription
router.get('/api/subscription', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);

    // Get the most recent active subscription
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', internalUserId)
      .in('subscription_status', ['active', 'trialing', 'past_due'])
      .order('inserted_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(400).json({ error: (error as any)?.message ?? 'Unknown error' });
    }

    // If no active subscription, check for any subscription (including expired/canceled)
    if (!data) {
      const { data: anySub, error: anyError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', internalUserId)
        .order('inserted_at', { ascending: false })
        .limit(1)
        .single();

      if (anyError && anyError.code !== 'PGRST116') {
        return res.status(400).json({ error: (anyError as any)?.message ?? 'Unknown error' });
      }

      return res.status(200).json({
        subscription: anySub || null,
        is_active: false
      });
    }

    // Check if subscription is still valid based on renewal_date
    const isActive = data.subscription_status === 'active' || data.subscription_status === 'trialing';
    const renewalDate = data.renewal_date ? new Date(data.renewal_date) : null;
    const isExpired = renewalDate && renewalDate < new Date();

    return res.status(200).json({
      subscription: data,
      is_active: isActive && !isExpired,
      expires_at: renewalDate?.toISOString() || null
    });
  } catch (err) {
    console.error('Error in GET /api/subscription:', err);
    console.error('Stack:', err instanceof Error ? err.stack : 'No stack trace');
    return res.status(500).json({
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err))
    });
  }
});

// Superwall webhook handler (exported for use without auth middleware)
export async function handleSuperwallWebhook(req: Request, res: Response) {
  try {
    // Verify webhook signature if Superwall provides one
    // You should configure a webhook secret in Superwall dashboard
    const webhookSecret = process.env.SUPERWALL_WEBHOOK_SECRET;
    const signature = req.headers['x-superwall-signature'] as string | undefined;

    if (webhookSecret && signature) {
      // Verify signature (adjust based on Superwall's signature method)
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      
      if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body as SuperwallEvent;
    
    // Superwall sends events like:
    // - subscription.started
    // - subscription.renewed
    // - subscription.canceled
    // - subscription.expired
    // - transaction.completed
    const eventType = event.event || '';
    const appUserId = event.app_user_id || event.user_id || event.alias;

    if (!appUserId) {
      console.warn('Webhook received without user identifier:', event);
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    const supabase = getSupabase();

    // Find user by Clerk ID (Superwall's app_user_id should match Clerk userId)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('clerk_id', appUserId)
      .single();

    if (userError || !user) {
      console.warn(`User not found for Clerk ID: ${appUserId}`, userError);
      // Return 200 to prevent webhook retries for invalid users
      return res.status(200).json({ received: true, message: 'User not found' });
    }

    const internalUserId = user.id as string;

    // Map Superwall event to subscription status
    let subscriptionStatus: SubscriptionStatus = 'active';
    let renewalDate: Date | null = null;
    let cancelledAt: Date | null = null;

    if (eventType.includes('started') || eventType.includes('renewed') || eventType.includes('completed')) {
      subscriptionStatus = event.period_type === 'TRIAL' ? 'trialing' : 'active';
      if (event.expiration_at) {
        renewalDate = new Date(event.expiration_at);
      } else if (event.purchased_at) {
        // Estimate renewal date (e.g., 1 month from purchase)
        renewalDate = new Date(event.purchased_at);
        renewalDate.setMonth(renewalDate.getMonth() + 1);
      }
    } else if (eventType.includes('canceled') || eventType.includes('cancelled')) {
      subscriptionStatus = 'canceled';
      cancelledAt = new Date();
      if (event.expiration_at) {
        renewalDate = new Date(event.expiration_at);
      }
    } else if (eventType.includes('expired')) {
      subscriptionStatus = 'expired';
      renewalDate = new Date(); // Already expired
    } else if (eventType.includes('past_due')) {
      subscriptionStatus = 'past_due';
      if (event.expiration_at) {
        renewalDate = new Date(event.expiration_at);
      }
    }

    // Check for existing subscription
    const { data: existing, error: existingError } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', internalUserId)
      .eq('subscription_source', 'superwall')
      .order('inserted_at', { ascending: false })
      .limit(1)
      .single();

    const subscriptionData = {
      user_id: internalUserId,
      plan: event.product_id || null,
      subscription_status: subscriptionStatus,
      subscription_source: 'superwall' as SubscriptionSource,
      renewal_date: renewalDate?.toISOString() || null,
      cancelled_at: cancelledAt?.toISOString() || null,
      updated_at: new Date().toISOString()
    };

    if (existing && !existingError) {
      // Update existing subscription
      const { error: updateError } = await supabase
        .from('subscriptions')
        .update(subscriptionData)
        .eq('id', existing.id);

      if (updateError) {
        console.error('Error updating subscription:', updateError);
        return res.status(500).json({ error: 'Failed to update subscription' });
      }
    } else {
      // Create new subscription record
      const { error: insertError } = await supabase
        .from('subscriptions')
        .insert(subscriptionData);

      if (insertError) {
        console.error('Error creating subscription:', insertError);
        return res.status(500).json({ error: 'Failed to create subscription' });
      }
    }

    return res.status(200).json({ received: true, processed: true });
  } catch (err) {
    console.error('Error in POST /api/subscription/webhook:', err);
    console.error('Stack:', err instanceof Error ? err.stack : 'No stack trace');
    return res.status(500).json({
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err))
    });
  }
}

// Superwall webhook endpoint
// This should be called by Superwall when subscription events occur
router.post('/api/subscription/webhook', handleSuperwallWebhook);

// Manual subscription update endpoint (for admin/testing)
// This can be used to manually sync subscription data or for testing
router.post('/api/subscription/sync', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body as {
      plan?: string;
      status?: SubscriptionStatus;
      source?: SubscriptionSource;
      renewal_date?: string;
      cancelled_at?: string;
    };

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);

    // Check for existing subscription
    const { data: existing, error: existingError } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', internalUserId)
      .order('inserted_at', { ascending: false })
      .limit(1)
      .single();

    const subscriptionData = {
      user_id: internalUserId,
      plan: body.plan || null,
      subscription_status: body.status || 'active',
      subscription_source: body.source || 'manual',
      renewal_date: body.renewal_date || null,
      cancelled_at: body.cancelled_at || null,
      updated_at: new Date().toISOString()
    };

    if (existing && !existingError) {
      // Update existing subscription
      const { data, error: updateError } = await supabase
        .from('subscriptions')
        .update(subscriptionData)
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) {
        return res.status(400).json({ error: (updateError as any)?.message ?? 'Update failed' });
      }

      return res.status(200).json({ subscription: data, updated: true });
    } else {
      // Create new subscription
      const { data, error: insertError } = await supabase
        .from('subscriptions')
        .insert(subscriptionData)
        .select()
        .single();

      if (insertError) {
        return res.status(400).json({ error: (insertError as any)?.message ?? 'Insert failed' });
      }

      return res.status(201).json({ subscription: data, created: true });
    }
  } catch (err) {
    console.error('Error in POST /api/subscription/sync:', err);
    console.error('Stack:', err instanceof Error ? err.stack : 'No stack trace');
    return res.status(500).json({
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err))
    });
  }
});

export default router;

