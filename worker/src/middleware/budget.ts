/**
 * Free-tier budget middleware (SoW §1.1):
 *  - countWorkerRequest : increments the daily Workers-request counter (fire-and-forget).
 *  - budgetGuard        : refuses state-changing requests once a hard Cloudflare cap is reached.
 *  - progressFloor      : enforces the ≥30s floor between VM progress writes (server-side).
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { isHardExhausted, recordUsage } from '../lib/budget';
import * as jobsDb from '../db/jobs';

/**
 * Count one Worker request against the daily budget. Runs after the response is produced (via
 * waitUntil) so it never adds latency. NOTE: this is itself one D1 write per request — an accepted
 * cost of a D1-backed counter on the free tier; a production build could sample/aggregate.
 */
export const countWorkerRequest = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.executionCtx.waitUntil(recordUsage(c.env, { workers: 1 }).catch(() => {}));
});

/** Block writes once a hard cap is hit. GET/HEAD (reads) are always allowed. */
export const budgetGuard = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (await isHardExhausted(c.env)) {
      throw err.budgetExhausted('Daily Cloudflare free-tier cap reached; writes are paused');
    }
  }
  await next();
});

/**
 * Enforce the server-side floor: the engine may write progress for a given job at most once per
 * `MIN_POLL_INTERVAL_SEC` (default 30s). Over-frequent calls get 429 + Retry-After (api-spec).
 */
export const progressFloor = createMiddleware<AppEnv>(async (c, next) => {
  const id = c.req.param('id');
  if (!id) throw err.validation('Missing job id');
  const job = await jobsDb.getInternal(c.env.DB, id);
  if (!job) throw err.notFound('Job not found');

  const min = Number(c.env.MIN_POLL_INTERVAL_SEC) || 30;
  if (job.lastProgressAt) {
    const elapsedSec = (Date.now() - Date.parse(job.lastProgressAt)) / 1000;
    if (elapsedSec < min) {
      const retryAfter = Math.ceil(min - elapsedSec);
      c.header('Retry-After', String(retryAfter));
      throw err.rateLimited(`Progress updates limited to 1 per ${min}s for this job`);
    }
  }
  await next();
});
