/**
 * Per-session request cap on UI endpoints (SoW §1.1 — explicit Worker rate limiting).
 *
 * Fixed-window counter kept in isolate memory (no D1 writes — keeping the limiter itself off the
 * D1 budget). PROTOTYPE caveat: Workers may run across multiple isolates, so this is a best-effort
 * per-isolate cap, not a globally exact one; the D1 budget governor is the authoritative backstop.
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';

const WINDOW_MS = 60_000; // 1-minute window
const MAX_PER_WINDOW = 120; // generous for an admin console; blocks runaway loops

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.get('session');
  const key = session?.id ?? c.req.header('cf-connecting-ip') ?? 'anon';
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    c.header('Retry-After', String(retryAfter));
    throw err.rateLimited(`Per-session request cap (${MAX_PER_WINDOW}/min) exceeded`);
  }
  await next();
});
