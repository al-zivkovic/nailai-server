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
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(clerkMiddleware());

// Root
app.get('/', (_req: Request, res: Response) => {
  res.send('nailai-server running');
});

// Health check endpoint (no auth required)
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const env = process.env.NODE_ENV || 'development';
    const hasSupabaseUrl = !!process.env.SUPABASE_URL;
    const hasSupabaseKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    // Test Supabase connection
    let supabaseStatus = 'not_configured';
    let keyPreview = null;
    let urlPreview = null;
    if (hasSupabaseUrl && hasSupabaseKey) {
      urlPreview = process.env.SUPABASE_URL?.substring(0, 30) + '...';
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      // Show first 8 and last 4 chars of key for debugging
      keyPreview = key.length > 12 
        ? `${key.substring(0, 8)}...${key.substring(key.length - 4)}`
        : '***';
      
      try {
        const { getSupabase } = await import('./utils/supabase.js');
        const supabase = getSupabase();
        // Simple query to test connection
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
          // Check if it's an auth error
          if (error.message.includes('Invalid API key') || error.message.includes('JWT')) {
            supabaseStatus = `error: Invalid API key - Make sure you're using the SECRET_KEY (not publishable key). Check your .env.prod file.`;
          } else {
            supabaseStatus = `error: ${error.message}`;
          }
        } else {
          supabaseStatus = 'connected';
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Invalid API key') || errMsg.includes('JWT')) {
          supabaseStatus = `error: Invalid API key - Make sure you're using the SECRET_KEY (not publishable key). Check your .env.prod file.`;
        } else {
          supabaseStatus = `error: ${errMsg}`;
        }
      }
    }
    
    res.json({
      ok: true,
      env,
      supabase: {
        url_configured: hasSupabaseUrl,
        key_configured: hasSupabaseKey,
        status: supabaseStatus,
        ...(urlPreview && { url_preview: urlPreview }),
        ...(keyPreview && { key_preview: keyPreview })
      }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
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


