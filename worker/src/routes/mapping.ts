/**
 * Target mapping (`PATCH /api/migration-users/:id/mapping`, SoW Phase 3).
 *
 * The cutover model provisions/matches against the DESTINATION tenant's existing primary domain;
 * source and target never share a domain assumption. We resolve/validate the target UPN and clearly
 * persist the UPN that will actually be used. Mounted on the /migration-users prefix.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MappingStatus } from '@shared/contracts';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { nowIso } from '../lib/time';
import { decryptSecret } from '../lib/crypto';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import { acquireAppToken, getUserByEmail } from '../graph/client';
import * as usersDb from '../db/migrationUsers';
import * as tenantsDb from '../db/tenants';

export const mappingRouter = new Hono<AppEnv>();

/** Best-effort resolve a target email to a real destination UPN (null if not connected/found). */
async function resolveDestinationUpn(c: Context<AppEnv>, email: string): Promise<string | null> {
  const material = await tenantsDb.getSecretMaterial(c.env.DB, 'destination');
  if (!material) return null;
  try {
    const secret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: material.ciphertext, iv: material.iv });
    const token = await acquireAppToken(material.tenantId, material.clientId, secret);
    const user = await getUserByEmail(token.accessToken, email);
    return user?.userPrincipalName ?? null;
  } catch {
    return null; // destination unreachable / not consented — leave unresolved
  }
}

mappingRouter.patch('/:id/mapping', async (c) => {
  const id = c.req.param('id');
  const existing = await usersDb.getById(c.env.DB, id);
  if (!existing) throw err.notFound('Migration user not found');

  const body = await c.req.json<{ targetEmail?: string | null; targetUpn?: string | null; mappingStatus?: MappingStatus }>();

  const targetEmail = body.targetEmail !== undefined ? body.targetEmail : existing.targetEmail;
  const requested: MappingStatus = body.mappingStatus ?? existing.mappingStatus;

  let targetUpn = body.targetUpn ?? null;
  let status: MappingStatus = requested;

  if (requested === 'auto_create') {
    // The UPN that WILL be created (explicit, or the provided target email).
    targetUpn = targetUpn ?? targetEmail ?? null;
    if (!targetUpn) {
      status = 'invalid';
    }
  } else if (requested === 'mapped') {
    // Must resolve to a real destination user; otherwise flag invalid (never silently assume).
    if (!targetUpn && targetEmail) targetUpn = await resolveDestinationUpn(c, targetEmail);
    status = targetUpn ? 'mapped' : 'invalid';
  }

  await usersDb.updateMapping(c.env.DB, id, { targetEmail, targetUpn, mappingStatus: status });
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(
    c.env.DB,
    c.get('session').actorUpn,
    'mapping_change',
    existing.sourceEmail,
    `→ ${targetUpn ?? '(unresolved)'} [${status}]`,
  );
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json(await usersDb.getById(c.env.DB, id));
});
