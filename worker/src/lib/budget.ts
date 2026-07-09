/**
 * Free-tier budget governor (SoW §1.1 — a HARD design constraint).
 *
 * Counters live in D1 (`budget_counters`, one row per UTC day):
 *   - workers_requests : Worker invocations
 *   - d1_writes        : D1 row writes
 *   - queue_ops        : Queue dispatch operations
 *
 * At `budgetSoftFraction` (default 0.85) of any Cloudflare cap we DEGRADE: flip `degraded`,
 * which makes `EngineConfig.paused = true` so the engine idles and the Worker refuses
 * non-essential writes — BEFORE any real Cloudflare limit is hit. At 100% we hard-block
 * state-changing requests with `budget_exhausted`.
 *
 * This is prototype governance; a reviewer should confirm the thresholds against the live
 * Cloudflare account plan before production use.
 */

import type { EngineConfig, FreeTierBudget } from '@shared/contracts';
import type { Env } from '../env';
import * as budgetDb from '../db/budget';
import { getAllConfig, num } from '../db/config';

interface Limits {
  workers: number;
  d1Writes: number;
  queueOps: number;
  softFraction: number;
}

async function limits(env: Env): Promise<Limits> {
  const cfg = await getAllConfig(env.DB);
  return {
    workers: num(cfg, 'workersDailyLimit', 100_000),
    d1Writes: num(cfg, 'd1WritesDailyLimit', 100_000),
    queueOps: num(cfg, 'queueOpsDailyLimit', 10_000),
    softFraction: num(cfg, 'budgetSoftFraction', 0.85),
  };
}

function isDegradedAtSoft(row: budgetDb.BudgetRow, l: Limits): boolean {
  return (
    row.workersRequests >= l.workers * l.softFraction ||
    row.d1Writes >= l.d1Writes * l.softFraction ||
    row.queueOps >= l.queueOps * l.softFraction
  );
}

/**
 * Increment today's counters and (re)evaluate the degrade flag.
 * Returns the current degraded state so callers can act on it.
 */
export async function recordUsage(
  env: Env,
  deltas: { workers?: number; d1Writes?: number; queueOps?: number },
): Promise<boolean> {
  const row = await budgetDb.increment(env.DB, deltas);
  const l = await limits(env);
  const degradedNow = isDegradedAtSoft(row, l);
  if (degradedNow !== row.degraded) await budgetDb.setDegraded(env.DB, degradedNow);
  return degradedNow;
}

/**
 * Fire-and-forget billing for route handlers: record D1 writes / queue ops against the daily
 * budget without adding latency to the response. Errors are swallowed (billing must never fail a
 * request), and the governor re-evaluates degrade state on the next request.
 */
export function billUsage(
  // Structural type: accepts Hono's `c.executionCtx` and the Workers runtime
  // `ExecutionContext` alike (their nominal types drift across @cloudflare/workers-types
  // versions; we only ever need `waitUntil`).
  ctx: { waitUntil(promise: Promise<unknown>): void },
  env: Env,
  deltas: { d1Writes?: number; queueOps?: number },
): void {
  ctx.waitUntil(recordUsage(env, deltas).catch(() => {}));
}

/** True once the governor has engaged (soft threshold crossed). Drives `EngineConfig.paused`. */
export async function isPaused(env: Env): Promise<boolean> {
  const row = await budgetDb.getToday(env.DB);
  if (row.degraded) return true;
  // Recompute defensively in case a threshold was lowered mid-day.
  return isDegradedAtSoft(row, await limits(env));
}

/** True when any counter has reached its HARD Cloudflare cap — refuse further writes. */
export async function isHardExhausted(env: Env): Promise<boolean> {
  const row = await budgetDb.getToday(env.DB);
  const l = await limits(env);
  return row.workersRequests >= l.workers || row.d1Writes >= l.d1Writes || row.queueOps >= l.queueOps;
}

/** Dashboard summary. */
export async function getBudget(env: Env): Promise<FreeTierBudget> {
  const row = await budgetDb.getToday(env.DB);
  const l = await limits(env);
  return {
    day: row.day,
    workers: { used: row.workersRequests, limit: l.workers },
    d1Writes: { used: row.d1Writes, limit: l.d1Writes },
    queueOps: { used: row.queueOps, limit: l.queueOps },
    degraded: row.degraded,
  };
}

/** Assemble the engine runtime config from the `config` table + the current pause state. */
export async function getEngineConfig(env: Env): Promise<EngineConfig> {
  const cfg = await getAllConfig(env.DB);
  return {
    minPollIntervalSec: num(cfg, 'minPollIntervalSec', 30),
    perMailboxConcurrency: num(cfg, 'perMailboxConcurrency', 2),
    perTenantConcurrency: num(cfg, 'perTenantConcurrency', 4),
    exchangeExportBatchSize: num(cfg, 'exchangeExportBatchSize', 20),
    onedriveUploadSessionThresholdBytes: num(cfg, 'onedriveUploadSessionThresholdBytes', 4_194_304),
    itemMaxRetries: num(cfg, 'itemMaxRetries', 5),
    paused: await isPaused(env),
  };
}
