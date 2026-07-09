/**
 * VM / engine plane (`/api/vm/*`, SoW Phase 4). Cloudflare Access service-token required
 * (applied at the router mount in routes/index.ts). This is the engine's ONLY channel back to
 * the control plane — all progress/state flows through D1 here, never back through Queues.
 *
 * SECURITY: `/token` runs the client-credentials flow using the decrypted tenant secret and
 * returns a SHORT-LIVED Graph access token. The tenant client secret NEVER leaves the Worker.
 */

import { Hono } from 'hono';
import type { CheckpointUpdate, ItemLogBatch, ProgressUpdate, StatusUpdate, TenantRole, VmTokenRequest, VmTokenResponse } from '@shared/contracts';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { decryptSecret } from '../lib/crypto';
import { billUsage, getEngineConfig } from '../lib/budget';
import { progressFloor } from '../middleware/budget';
import { acquireAppToken, DEFAULT_SCOPE } from '../graph/client';
import * as tenantsDb from '../db/tenants';
import * as jobsDb from '../db/jobs';
import * as jobItemsDb from '../db/jobItems';

export const vmRouter = new Hono<AppEnv>();

function isRole(v: unknown): v is TenantRole {
  return v === 'source' || v === 'destination';
}

/** GET /api/vm/config — engine runtime configuration (includes governor `paused`). */
vmRouter.get('/config', async (c) => {
  return c.json(await getEngineConfig(c.env));
});

/** POST /api/vm/token — short-lived Graph token for a tenant role. Secret never leaves the Worker. */
vmRouter.post('/token', async (c) => {
  const body = await c.req.json<VmTokenRequest>();
  if (!isRole(body.tenantRole)) throw err.validation("tenantRole must be 'source' or 'destination'");

  const material = await tenantsDb.getSecretMaterial(c.env.DB, body.tenantRole);
  if (!material) throw err.notFound(`No ${body.tenantRole} tenant connected`);

  const secret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: material.ciphertext, iv: material.iv });
  const token = await acquireAppToken(material.tenantId, material.clientId, secret, body.scope ?? DEFAULT_SCOPE);

  const res: VmTokenResponse = { accessToken: token.accessToken, expiresAt: token.expiresAt, tenantId: material.tenantId };
  return c.json(res);
});

/** GET /api/vm/jobs/:id — current job state (for resume after reboot). */
vmRouter.get('/jobs/:id', async (c) => {
  const job = await jobsDb.getById(c.env.DB, c.req.param('id'));
  if (!job) throw err.notFound('Job not found');
  return c.json(job);
});

/** POST /api/vm/jobs/:id/status — explicit status transition (incl. distinct failure states). */
vmRouter.post('/jobs/:id/status', async (c) => {
  const id = c.req.param('id');
  if (!(await jobsDb.getInternal(c.env.DB, id))) throw err.notFound('Job not found');

  const body = await c.req.json<StatusUpdate>();
  if (!body.status) throw err.validation('status is required');

  await jobsDb.updateStatus(c.env.DB, id, body.status, body.errorClass ?? null, body.errorDetail ?? null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });
  return c.json({ ok: true });
});

/**
 * POST /api/vm/jobs/:id/progress — batched progress. The `progressFloor` middleware rejects
 * calls more frequent than MIN_POLL_INTERVAL_SEC (≤1 write/job/30s) with 429 + Retry-After.
 */
vmRouter.post('/jobs/:id/progress', progressFloor, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<ProgressUpdate>();
  if (!body.status) throw err.validation('status is required');

  await jobsDb.updateProgress(c.env.DB, id, body);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });
  return c.json({ ok: true });
});

/** POST /api/vm/jobs/:id/checkpoint — durable resume point (survives VM reboot). */
vmRouter.post('/jobs/:id/checkpoint', async (c) => {
  const id = c.req.param('id');
  if (!(await jobsDb.getInternal(c.env.DB, id))) throw err.notFound('Job not found');

  const body = await c.req.json<CheckpointUpdate>();
  if (!body.checkpoint || typeof body.checkpoint !== 'object') throw err.validation('checkpoint object is required');

  await jobsDb.updateCheckpoint(c.env.DB, id, body.checkpoint, body.progressCurrent ?? 0, body.bytesDone ?? 0);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });
  return c.json({ ok: true });
});

/** POST /api/vm/jobs/:id/items — batched item-level skip/fail log. */
vmRouter.post('/jobs/:id/items', async (c) => {
  const id = c.req.param('id');
  if (!(await jobsDb.getInternal(c.env.DB, id))) throw err.notFound('Job not found');

  const body = await c.req.json<ItemLogBatch>();
  if (!Array.isArray(body.items)) throw err.validation('items[] is required');

  const inserted = await jobItemsDb.insertBatch(c.env.DB, id, body.items);
  billUsage(c.executionCtx, c.env, { d1Writes: inserted });
  return c.json({ inserted });
});
