# Superwall Integration Guide

This document outlines how to integrate Superwall subscription management with your nailai-server backend.

## Overview

Superwall is a paywall and subscription management platform that handles subscription lifecycle events. This integration allows you to:

- Track subscription status in your database
- Receive webhook events from Superwall
- Check subscription status in your API endpoints
- Gate features based on subscription plans

## Database Schema

The `subscriptions` table stores subscription data with the following structure:

- `id` - UUID primary key
- `user_id` - References internal user ID (from `users` table)
- `plan` - Subscription plan identifier (e.g., "premium", "pro")
- `subscription_status` - Status: `active`, `trialing`, `past_due`, `canceled`, `expired`, etc.
- `subscription_source` - Source: `superwall`, `stripe`, `app_store`, `play_store`, `manual`
- `renewal_date` - When the subscription renews/expires
- `cancelled_at` - When the subscription was cancelled
- `inserted_at` - When the record was created
- `updated_at` - When the record was last updated

## API Endpoints

### GET `/api/subscription`

Get the current user's subscription status.

**Authentication:** Required (Clerk)

**Response:**
```json
{
  "subscription": {
    "id": "uuid",
    "user_id": "uuid",
    "plan": "premium",
    "subscription_status": "active",
    "subscription_source": "superwall",
    "renewal_date": "2024-02-01T00:00:00Z",
    "cancelled_at": null,
    "inserted_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-15T00:00:00Z"
  },
  "is_active": true,
  "expires_at": "2024-02-01T00:00:00Z"
}
```

### POST `/api/subscription/webhook`

Webhook endpoint for Superwall events. This endpoint should be configured in your Superwall dashboard.

**Authentication:** Webhook signature verification (optional but recommended)

**Headers:**
- `x-superwall-signature` - HMAC signature for verification

**Body:** Superwall event payload

**Response:**
```json
{
  "received": true,
  "processed": true
}
```

### POST `/api/subscription/sync`

Manually sync subscription data (useful for testing or admin operations).

**Authentication:** Required (Clerk)

**Body:**
```json
{
  "plan": "premium",
  "status": "active",
  "source": "manual",
  "renewal_date": "2024-02-01T00:00:00Z",
  "cancelled_at": null
}
```

## Superwall Setup

### 1. Configure Webhook in Superwall Dashboard

1. Log in to your Superwall dashboard
2. Navigate to **Settings** → **Webhooks**
3. Add a new webhook endpoint: `https://your-domain.com/api/subscription/webhook`
4. Select the events you want to receive:
   - `subscription.started`
   - `subscription.renewed`
   - `subscription.canceled`
   - `subscription.expired`
   - `transaction.completed`
5. Generate and copy the webhook secret

### 2. Environment Variables

Add the following to your `.env` file:

```bash
# Superwall Webhook Secret (for signature verification)
SUPERWALL_WEBHOOK_SECRET=your_webhook_secret_here
```

### 3. User ID Mapping

**Important:** Superwall's `app_user_id` must match your Clerk `userId`. 

In your frontend, when initializing Superwall:

```typescript
import Superwall from 'superwall-react-native'; // or superwall-js for web

// Get Clerk userId
const { userId } = useAuth(); // or however you get Clerk userId

// Set the user identifier in Superwall
Superwall.setUserAttributes({
  appUserId: userId, // This must match Clerk userId
});
```

### 4. Frontend Integration

In your React/React Native app, use Superwall to:

1. **Show paywalls** when users need to subscribe
2. **Check subscription status** via the API endpoint
3. **Handle subscription events** and sync with backend

Example:

```typescript
// Check subscription status
const checkSubscription = async () => {
  const response = await fetch('/api/subscription', {
    headers: {
      'Authorization': `Bearer ${clerkToken}`
    }
  });
  const data = await response.json();
  return data.is_active;
};

// After successful purchase in Superwall
Superwall.on('subscription.started', async (event) => {
  // Superwall will send webhook to backend automatically
  // But you can also manually sync if needed
  await fetch('/api/subscription/sync', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${clerkToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      plan: event.productId,
      status: 'active',
      source: 'superwall',
      renewal_date: event.expirationDate
    })
  });
});
```

## Using Subscription Utilities

You can use the subscription utilities in your route handlers to gate features:

```typescript
import { hasActiveSubscription, requireSubscription } from '../utils/subscription.js';

// Example: Require active subscription
router.post('/api/premium-feature', async (req: Request, res: Response) => {
  const { hasAccess } = await requireSubscription(req);
  
  if (!hasAccess) {
    return res.status(403).json({ 
      error: 'Subscription required',
      message: 'This feature requires an active subscription'
    });
  }
  
  // Proceed with premium feature
});

// Example: Require specific plan
router.post('/api/pro-feature', async (req: Request, res: Response) => {
  const { hasAccess } = await requireSubscription(req, 'pro');
  
  if (!hasAccess) {
    return res.status(403).json({ 
      error: 'Pro plan required',
      message: 'This feature requires a Pro subscription'
    });
  }
  
  // Proceed with pro feature
});
```

## Webhook Event Mapping

The webhook handler maps Superwall events to subscription statuses:

| Superwall Event | Subscription Status |
|----------------|---------------------|
| `subscription.started` (TRIAL) | `trialing` |
| `subscription.started` (NORMAL) | `active` |
| `subscription.renewed` | `active` |
| `subscription.canceled` | `canceled` |
| `subscription.expired` | `expired` |
| `subscription.past_due` | `past_due` |
| `transaction.completed` | `active` |

## Testing

### Test Webhook Locally

Use a tool like [ngrok](https://ngrok.com/) to expose your local server:

```bash
ngrok http 3001
```

Then configure the ngrok URL in Superwall dashboard for testing.

### Manual Testing

You can manually test subscription sync:

```bash
curl -X POST http://localhost:3001/api/subscription/sync \
  -H "Authorization: Bearer YOUR_CLERK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plan": "premium",
    "status": "active",
    "source": "manual",
    "renewal_date": "2024-12-31T23:59:59Z"
  }'
```

## Best Practices

1. **Always verify webhook signatures** in production
2. **Use idempotent operations** - the webhook handler updates existing subscriptions rather than creating duplicates
3. **Handle edge cases** - expired subscriptions, cancelled subscriptions, etc.
4. **Log webhook events** for debugging
5. **Set up monitoring** for webhook failures
6. **Keep subscription data in sync** - consider periodic sync jobs if needed

## Troubleshooting

### Webhook not receiving events

1. Check Superwall dashboard webhook configuration
2. Verify webhook URL is accessible
3. Check server logs for incoming requests
4. Verify webhook secret matches

### Subscription status not updating

1. Check if user exists in database
2. Verify `app_user_id` matches Clerk `userId`
3. Check webhook payload structure
4. Review server logs for errors

### User not found errors

- Ensure Superwall's `app_user_id` matches Clerk `userId`
- Verify user exists in `users` table
- Check that `getOrCreateInternalUserId` is working correctly

## Additional Resources

- [Superwall Documentation](https://superwall.com/docs)
- [Superwall Webhook Events](https://superwall.com/docs/webhooks)
- [Clerk Authentication](https://clerk.com/docs)

