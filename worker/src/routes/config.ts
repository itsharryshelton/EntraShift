/**
 * Engine/app configuration (`/api/config`, SoW Phase 4/5 — Settings screen).
 * GET returns the effective EngineConfig (+ retention); PATCH updates tunables.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { billUsage, getEngineConfig } from '../lib/budget';
import { audit } from '../lib/audit';
import { getConfigValue, setConfigValue } from '../db/config';

export const configRouter = new Hono<AppEnv>();

// Numeric tunables the UI may change, with sane bounds (exchangeExportBatchSize is capped at the
// Graph hard limit of 20).
const NUMERIC_KEYS: Record<string, { min: number; max: number }> = {
  minPollIntervalSec: { min: 30, max: 3600 }, // never below the 30s floor
  perMailboxConcurrency: { min: 1, max: 10 },
  perTenantConcurrency: { min: 1, max: 20 },
  exchangeExportBatchSize: { min: 1, max: 20 },
  onedriveUploadSessionThresholdBytes: { min: 1_048_576, max: 268_435_456 },
  itemMaxRetries: { min: 0, max: 20 },
  auditRetentionDays: { min: 1, max: 365 },
  budgetSoftFraction: { min: 0.5, max: 0.99 },
};

/** GET /api/config */
configRouter.get('/', async (c) => {
  const engine = await getEngineConfig(c.env);
  const auditRetentionDays = Number(await getConfigValue(c.env.DB, 'auditRetentionDays', '90'));
  return c.json({ ...engine, auditRetentionDays });
});

/** PATCH /api/config */
configRouter.patch('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const changed: string[] = [];

  for (const [key, bounds] of Object.entries(NUMERIC_KEYS)) {
    if (!(key in body)) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
      throw err.validation(`${key} must be a number in [${bounds.min}, ${bounds.max}]`);
    }
    await setConfigValue(c.env.DB, key, String(value));
    changed.push(`${key}=${value}`);
  }

  if (changed.length === 0) throw err.validation('No recognised config keys to update');
  billUsage(c.executionCtx, c.env, { d1Writes: changed.length });

  await audit(c.env.DB, c.get('session').actorUpn, 'config_change', null, changed.join(', '));
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  const engine = await getEngineConfig(c.env);
  const auditRetentionDays = Number(await getConfigValue(c.env.DB, 'auditRetentionDays', '90'));
  return c.json({ ...engine, auditRetentionDays });
});
