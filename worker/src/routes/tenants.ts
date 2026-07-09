/**
 * Tenant connection routes (`/api/tenants`, SoW Phase 1).
 *
 * SECURITY: the client secret is AES-256-GCM encrypted in the Worker; only ciphertext + IV are
 * stored in D1. Responses return metadata ONLY — never the secret, never the ciphertext.
 * There is no reveal; rotation requires re-entry.
 */

import { Hono } from 'hono';
import type { TenantRole } from '@shared/contracts';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { uuid } from '../lib/ids';
import { nowIso } from '../lib/time';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import { testConnection } from '../graph/client';
import * as tenantsDb from '../db/tenants';

export const tenantsRouter = new Hono<AppEnv>();

function isRole(v: unknown): v is TenantRole {
  return v === 'source' || v === 'destination';
}

/** GET /api/tenants — metadata only. */
tenantsRouter.get('/', async (c) => {
  return c.json(await tenantsDb.list(c.env.DB));
});

/** POST /api/tenants — connect a tenant (encrypts + stores the secret). */
tenantsRouter.post('/', async (c) => {
  const body = await c.req.json<{
    role?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    secretExpiry?: string | null;
    displayName?: string | null;
  }>();

  if (!isRole(body.role)) throw err.validation("role must be 'source' or 'destination'");
  if (!body.tenantId || !body.clientId || !body.clientSecret) {
    throw err.validation('tenantId, clientId and clientSecret are required');
  }

  const { ciphertext, iv } = await encryptSecret(c.env.MASTER_ENCRYPTION_KEY, body.clientSecret);
  const id = uuid();
  await tenantsDb.upsert(c.env.DB, {
    id,
    role: body.role,
    tenantId: body.tenantId,
    clientId: body.clientId,
    secretCiphertext: ciphertext,
    secretIv: iv,
    secretExpiry: body.secretExpiry ?? null,
    displayName: body.displayName ?? null,
    createdAt: nowIso(),
  });
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  const actor = c.get('session').actorUpn;
  await audit(c.env.DB, actor, 'tenant_connect', `${body.role}:${body.tenantId}`, null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  // Return the stored tenant (metadata only) — never the secret.
  const stored = await tenantsDb.getByRole(c.env.DB, body.role);
  return c.json(stored, 201);
});

/** POST /api/tenants/:id/test — probe token acquisition + required admin consents. */
tenantsRouter.post('/:id/test', async (c) => {
  const id = c.req.param('id');
  const tenant = await tenantsDb.getById(c.env.DB, id);
  if (!tenant) throw err.notFound('Tenant not found');

  const material = await tenantsDb.getSecretMaterialById(c.env.DB, id);
  if (!material) throw err.notFound('Tenant secret not found');

  // Decrypt transiently, run the probe, discard the plaintext.
  const secret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: material.ciphertext, iv: material.iv });
  const result = await testConnection(material.tenantId, material.clientId, secret, tenant.role);

  const status = result.tokenAcquired && result.missingConsents.length === 0 ? 'connected' : 'error';
  await tenantsDb.setStatus(c.env.DB, id, status, nowIso());
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(
    c.env.DB,
    c.get('session').actorUpn,
    'tenant_test',
    `${tenant.role}:${material.tenantId}`,
    result.missingConsents.length ? `missing: ${result.missingConsents.join(', ')}` : 'ok',
  );
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json(result);
});

/** POST /api/tenants/:id/secret — rotate the secret (re-entry; no reveal). */
tenantsRouter.post('/:id/secret', async (c) => {
  const id = c.req.param('id');
  const tenant = await tenantsDb.getById(c.env.DB, id);
  if (!tenant) throw err.notFound('Tenant not found');

  const body = await c.req.json<{ clientSecret?: string; secretExpiry?: string | null }>();
  if (!body.clientSecret) throw err.validation('clientSecret is required');

  const { ciphertext, iv } = await encryptSecret(c.env.MASTER_ENCRYPTION_KEY, body.clientSecret);
  await tenantsDb.rotateSecret(c.env.DB, id, ciphertext, iv, body.secretExpiry ?? tenant.secretExpiry);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(c.env.DB, c.get('session').actorUpn, 'secret_rotate', `${tenant.role}:${tenant.tenantId}`, null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  // Return updated metadata (never the secret) — client types this as TenantSummary.
  return c.json(await tenantsDb.getByRole(c.env.DB, tenant.role));
});

/** DELETE /api/tenants/:id — disconnect (typed-confirmation gated in the UI). */
tenantsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const tenant = await tenantsDb.getById(c.env.DB, id);
  if (!tenant) throw err.notFound('Tenant not found');

  await tenantsDb.remove(c.env.DB, id);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(c.env.DB, c.get('session').actorUpn, 'tenant_disconnect', `${tenant.role}:${tenant.tenantId}`, null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json({ ok: true });
});
