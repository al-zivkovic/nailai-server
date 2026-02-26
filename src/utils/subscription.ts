import { type Request } from 'express';
import getSupabase from './supabase.js';
import getOrCreateInternalUserId from './userLookup.js';

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface SubscriptionInfo {
  id: string;
  user_id: string;
  plan: string | null;
  subscription_status: SubscriptionStatus | null;
  subscription_source: string | null;
  renewal_date: string | null;
  cancelled_at: string | null;
  inserted_at: string;
  updated_at: string;
}

/**
 * Get the current user's active subscription
 * Returns null if no active subscription exists
 * 
 * This queries your local database first (fast, reliable).
 * The database is kept in sync via Superwall webhooks.
 * 
 * Why use DB instead of querying Superwall directly?
 * - Performance: Local queries are much faster
 * - Reliability: Works even if Superwall API is down
 * - Data ownership: Full control and custom analytics
 * - Offline capability: Check status without external calls
 */
export async function getUserSubscription(req: Request): Promise<SubscriptionInfo | null> {
  try {
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
      console.error('Error fetching subscription:', error);
      return null;
    }

    if (!data) return null;

    // Check if subscription is still valid based on renewal_date
    const renewalDate = data.renewal_date ? new Date(data.renewal_date) : null;
    const isExpired = renewalDate && renewalDate < new Date();

    if (isExpired) {
      return null;
    }

    return data as SubscriptionInfo;
  } catch (err) {
    console.error('Error in getUserSubscription:', err);
    return null;
  }
}

/**
 * Check if the user has an active subscription
 */
export async function hasActiveSubscription(req: Request): Promise<boolean> {
  const subscription = await getUserSubscription(req);
  return subscription !== null;
}

/**
 * Check if the user has access to a specific plan
 */
export async function hasPlanAccess(req: Request, requiredPlan?: string): Promise<boolean> {
  const subscription = await getUserSubscription(req);
  if (!subscription) return false;
  
  if (requiredPlan) {
    return subscription.plan === requiredPlan;
  }
  
  return true;
}

/**
 * Middleware helper to check subscription status
 * Use this in route handlers to gate access based on subscription
 */
export async function requireSubscription(req: Request, requiredPlan?: string): Promise<{ hasAccess: boolean; subscription: SubscriptionInfo | null }> {
  const subscription = await getUserSubscription(req);
  
  if (!subscription) {
    return { hasAccess: false, subscription: null };
  }

  if (requiredPlan && subscription.plan !== requiredPlan) {
    return { hasAccess: false, subscription };
  }

  return { hasAccess: true, subscription };
}

