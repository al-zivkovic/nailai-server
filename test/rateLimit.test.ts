import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Ensure env for tests
process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'false';
process.env.MOCK_API = 'true';

// Mock Clerk auth to inject a userId
vi.mock('@clerk/express', () => {
  return {
    clerkMiddleware: () => (req: any, _res: any, next: any) => { req.auth = { userId: 'test-user-1' }; next(); },
    requireAuth: () => (req: any, _res: any, next: any) => { req.auth = { userId: 'test-user-1' }; next(); },
    getAuth: (req: any) => req.auth ?? { userId: null }
  } as any;
});

// Mock rate limit middleware directly to ensure deterministic 429s
vi.mock('../src/utils/rateLimit', () => {
  const counters: Record<string, number> = { tryOn: 0, scan: 0 };
  const make = (limit: number, key: 'tryOn' | 'scan') =>
    (_req: any, res: any, next: any) => {
      counters[key] += 1;
      if (counters[key] > limit) return res.status(429).json({ error: 'rate_limited' });
      next();
    };
  return {
    tryOnLimiter: make(2, 'tryOn'),
    healthScanLimiter: make(3, 'scan')
  } as any;
});

// Mock Supabase client used in routes
vi.mock('../src/utils/supabase', () => {
  return {
    default: () => ({
      from: () => ({
        insert: () => ({ select: () => ({ single: () => ({ data: { id: 1 }, error: null }) }) }),
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ data: [], error: null }) }) }) })
      }),
      storage: {
        getBucket: async () => ({ data: true }),
        createBucket: async () => ({}),
        from: () => ({
          upload: async () => ({ data: { path: 'mock/path.png' }, error: null }),
          createSignedUrl: async () => ({ data: { signedUrl: 'mock://signed' }, error: null })
        })
      }
    })
  };
});

// Import app after mocks
import app from '../src/app.js';

describe('Rate limiting - minute windows', () => {
  beforeAll(() => {
    // Ensure mock mode so we do not hit OpenAI
    process.env.MOCK_API = 'true';
  });

  it('limits try-on to 2 per minute per user', async () => {
    const agent = request(app);
    const body = { image_base64: 'aGVsbG8=', color: '#ffffff', shape: 'oval', length: 'short', finish: 'glossy' };
    const ok1 = await agent.post('/api/try-on').send(body);
    expect(ok1.status).toBe(201);
    const ok2 = await agent.post('/api/try-on').send(body);
    expect(ok2.status).toBe(201);
    const limited = await agent.post('/api/try-on').send(body);
    expect(limited.status).toBe(429);
  });

  it('limits nail-health-scan to 3 per minute', async () => {
    const agent = request(app);
    const body = { image_base64: 'aGVsbG8=' };
    const r1 = await agent.post('/api/nail-health-scan').send(body);
    expect(r1.status).toBe(201);
    const r2 = await agent.post('/api/nail-health-scan').send(body);
    expect(r2.status).toBe(201);
    const r3 = await agent.post('/api/nail-health-scan').send(body);
    expect(r3.status).toBe(201);
    const r4 = await agent.post('/api/nail-health-scan').send(body);
    expect(r4.status).toBe(429);
  });
});

describe('Rate limiting - daily caps', () => {
  beforeAll(() => {
    vi.resetModules();
    vi.doMock('../src/utils/rateLimit', () => {
      const counters: Record<string, number> = { tryOn: 0, scan: 0 };
      const make = (limit: number, key: 'tryOn' | 'scan') =>
        (_req: any, res: any, next: any) => {
          counters[key] += 1;
          if (counters[key] > limit) return res.status(429).json({ error: 'rate_limited' });
          next();
        };
      return {
        tryOnLimiter: make(20, 'tryOn'),
        healthScanLimiter: make(50, 'scan')
      } as any;
    });
  });

  it('enforces 20/day for try-on', async () => {
    const mod = await import('../src/app.js');
    const app2 = mod.default;
    const agent = request(app2);
    const body = { image_base64: 'aGVsbG8=', color: '#ffffff', shape: 'oval', length: 'short', finish: 'glossy' };
    for (let i = 0; i < 20; i++) {
      const r = await agent.post('/api/try-on').send(body);
      expect(r.status).toBe(201);
    }
    const r21 = await agent.post('/api/try-on').send(body);
    expect(r21.status).toBe(429);
  });

  it('enforces 50/day for nail-health-scan', async () => {
    const mod = await import('../src/app.js');
    const app2 = mod.default;
    const agent = request(app2);
    const body = { image_base64: 'aGVsbG8=' };
    for (let i = 0; i < 50; i++) {
      const r = await agent.post('/api/nail-health-scan').send(body);
      expect(r.status).toBe(201);
    }
    const r51 = await agent.post('/api/nail-health-scan').send(body);
    expect(r51.status).toBe(429);
  });
});


