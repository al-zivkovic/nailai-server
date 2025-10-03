import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { Request, Response, NextFunction } from 'express';

// Dev toggle: allow disabling rate limit locally when Redis is not configured
const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const isExplicitlyDisabled = String(process.env.DISABLE_RATE_LIMIT).toLowerCase() === 'true';
const hasUpstashEnv = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const rateLimitDisabled = isExplicitlyDisabled || (isDev && !hasUpstashEnv);
const useTestMemory = String(process.env.TEST_MEMORY_RATE_LIMIT).toLowerCase() === 'true';

let redis: ReturnType<typeof Redis.fromEnv> | null = null;
function getRedis() {
  if (rateLimitDisabled) return null;
  if (redis) return redis;
  try {
    redis = Redis.fromEnv();
    return redis;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Upstash Redis not configured; rate limiting disabled.', err);
    return null;
  }
}

export type LimitSpec = {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
};

type LimitClient = { limit: (key: string) => Promise<{ success: boolean; remaining?: number; reset?: number }> };
const testMemoryCounters = new Map<string, number>();
function makeLimiter(count: number, window: '1 m' | '1 h' | '1 d'): LimitClient {
  if (useTestMemory) {
    return {
      async limit(key: string) {
        const used = (testMemoryCounters.get(key) || 0) + 1;
        testMemoryCounters.set(key, used);
        const success = used <= count;
        return { success, remaining: Math.max(0, count - used), reset: Date.now() + 60000 };
      }
    };
  }
  const client = getRedis();
  if (!client) {
    return {
      async limit() {
        return { success: true, remaining: count, reset: Date.now() + 1000 };
      }
    };
  }
  return new Ratelimit({
    redis: client,
    limiter: Ratelimit.slidingWindow(count, window),
    analytics: true,
    timeout: 1000
  }) as unknown as LimitClient;
}

// Build a composed limiter for minute/hour/day using distinct keys
function buildComposedLimiter(prefix: string, spec: LimitSpec) {
  const minute = spec.perMinute ? makeLimiter(spec.perMinute, '1 m') : null;
  const hour = spec.perHour ? makeLimiter(spec.perHour, '1 h') : null;
  const day = spec.perDay ? makeLimiter(spec.perDay, '1 d') : null;

  return async (key: string) => {
    const namespaced = (suffix: string) => `${prefix}:${suffix}:${key}`;
    const results = await Promise.all([
      minute ? minute.limit(namespaced('m')) : Promise.resolve({ success: true } as any),
      hour ? hour.limit(namespaced('h')) : Promise.resolve({ success: true } as any),
      day ? day.limit(namespaced('d')) : Promise.resolve({ success: true } as any)
    ]);

    const success = results.every(r => (r as any).success !== false);
    const detail = results.map((r, idx) => ({
      scope: idx === 0 ? 'minute' : idx === 1 ? 'hour' : 'day',
      ...(r as any)
    }));
    return { success, detail };
  };
}

// In-memory snapshot of last seen limiter results (per process, dev/debug only)
type Snapshot = {
  success: boolean;
  limits: LimitSpec;
  detail: Array<{ scope: 'minute' | 'hour' | 'day'; remaining?: number; reset?: number }>;
  updatedAt: number;
};
const lastSnapshot = new Map<string, Snapshot>();

function storeSnapshot(namespace: string, baseKey: string, limits: LimitSpec, detail: Snapshot['detail'], success: boolean) {
  const k = `${namespace}|${baseKey}`;
  lastSnapshot.set(k, { success, limits, detail, updatedAt: Date.now() });
}

export function readUserSnapshots(userId: string) {
  const mk = (ns: string) => `${ns}|u:${userId}`;
  return {
    tryOn: lastSnapshot.get(mk('rl:try-on')) || null,
    nailHealthScan: lastSnapshot.get(mk('rl:nail-health-scan')) || null
  };
}

export function rateLimitMiddleware(spec: LimitSpec, keyFn?: (req: Request) => string, namespace = 'rl') {
  const limiter = buildComposedLimiter(namespace, spec);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Prefer Clerk userId; fallback to IP
      const userId = (req as any).auth?.userId;
      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
      const baseKey = keyFn ? keyFn(req) : (userId ? `u:${userId}` : `ip:${ip}`);

      const { success, detail } = await limiter(baseKey);
      // Store last seen snapshot in memory (does not affect limits)
      try { storeSnapshot(namespace, baseKey, spec, detail as any, success); } catch {}
      if (!success) {
        return res.status(429).json({ error: 'rate_limited', limits: spec, detail });
      }
      next();
    } catch (err) {
      // Fail-open to avoid blocking in case of Redis outages, but log
      // eslint-disable-next-line no-console
      console.error('rate limit error', err);
      next();
    }
  };
}

// Predefined limiters for this app
export const tryOnLimiter = rateLimitMiddleware({ perMinute: 2, perDay: 20 }, undefined, 'rl:try-on');
export const healthScanLimiter = rateLimitMiddleware({ perMinute: 3, perHour: 30, perDay: 50 }, undefined, 'rl:nail-health-scan');


