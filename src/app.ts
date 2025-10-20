import express, { type Request, type Response } from 'express';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import nailHealthScanRouter from './routes/nail-health-scan.js';
import usersRouter from './routes/users.js';
import tryOnRouter from './routes/nail-customizer.js';
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

// Protect all /api/* endpoints with Clerk auth
app.use('/api', requireAuth());

// Routes
app.use(nailHealthScanRouter);
app.use(usersRouter);
app.use(tryOnRouter);

export default app;


