import express, { type Request, type Response } from 'express';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import nailHealthScanRouter from './routes/nail-health-scan.js';
import usersRouter from './routes/users.js';
import tryOnRouter from './routes/nail-customizer.js';
import subscriptionsRouter, { handleSuperwallWebhook } from './routes/subscriptions.js';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
// Image-bearing endpoints (try-on, nail-health-scan) accept base64
// photos. The client downscales to ~1280 px wide and JPEG-compresses
// before upload (see nailai-app/src/lib/prepareImage.ts), which lands
// payloads comfortably under 1 MB. We allow 5 MB as headroom for edge
// cases (very wide panoramas, retried bigger images, future endpoints
// that pass additional metadata). Auth + per-user rate limits provide
// the abuse ceiling.
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(clerkMiddleware());

// Root
app.get('/', (_req: Request, res: Response) => {
  res.send('nailai-server running');
});

// Health check endpoint (no auth required).
//
// SECURITY: this endpoint is publicly reachable, so it must never echo
// any portion of a secret (not even a prefix/suffix preview). Any extra
// diagnostic detail (error messages, URL previews) is only included
// outside production to aid local debugging.
app.get('/health', async (_req: Request, res: Response) => {
  const env = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';

  try {
    const hasSupabaseUrl = !!process.env.SUPABASE_URL;
    const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Test Supabase connection
    let supabaseStatus: 'not_configured' | 'connected' | 'error' = 'not_configured';
    let supabaseError: string | undefined;

    if (hasSupabaseUrl && hasSupabaseKey) {
      try {
        const { getSupabase } = await import('./utils/supabase.js');
        const supabase = getSupabase();
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
          supabaseStatus = 'error';
          supabaseError = error.message;
        } else {
          supabaseStatus = 'connected';
        }
      } catch (err) {
        supabaseStatus = 'error';
        supabaseError = err instanceof Error ? err.message : String(err);
      }
    }

    res.json({
      ok: true,
      env,
      supabase: {
        url_configured: hasSupabaseUrl,
        key_configured: hasSupabaseKey,
        status: supabaseStatus,
        // Only surface the error text in non-production environments.
        ...(!isProd && supabaseError ? { error: supabaseError } : {}),
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      ...(!isProd && { error: err instanceof Error ? err.message : String(err) }),
    });
  }
});

// Webhook routes (no auth required - verified via signature)
// Register webhook routes before requireAuth middleware
app.post('/api/subscription/webhook', handleSuperwallWebhook);

// Protect all /api/* endpoints with Clerk auth
app.use('/api', requireAuth());

// Routes
app.use(nailHealthScanRouter);
app.use(usersRouter);
app.use(tryOnRouter);
app.use(subscriptionsRouter);

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  console.error('Stack:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;


