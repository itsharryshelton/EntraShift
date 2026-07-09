/**
 * Automated provisioning (`POST /api/provision`, SoW Phase 3).
 *
 * For each auto-create user: create the destination user from source metadata (User.ReadWrite.All),
 * set a random temp password with force-change-at-next-sign-in, trigger OneDrive pre-provisioning,
 * and hold the password envelope-encrypted until the one-time CSV download.
 *
 * SECURITY: the temp password is generated in the Worker, sent to Graph once, and stored ONLY as
 * AES-256-GCM ciphertext. It is never returned in this response and never logged.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { uuid } from '../lib/ids';
import { nowIso } from '../lib/time';
import { decryptSecret, encryptSecret, generateTempPassword } from '../lib/crypto';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import { acquireAppToken, getUserByEmail, preProvisionOneDrive, provisionUser } from '../graph/client';
import * as usersDb from '../db/migrationUsers';
import * as tenantsDb from '../db/tenants';
import * as credsDb from '../db/credentials';

export const provisionRouter = new Hono<AppEnv>();

provisionRouter.post('/', async (c) => {
  const body = await c.req.json<{ migrationUserIds?: string[] }>();
  const ids = body.migrationUserIds ?? [];
  if (!Array.isArray(ids) || ids.length === 0) throw err.validation('migrationUserIds[] is required');

  // Destination tenant token (required to create users).
  const destMat = await tenantsDb.getSecretMaterial(c.env.DB, 'destination');
  if (!destMat) throw err.validation('No destination tenant is connected');
  const destSecret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: destMat.ciphertext, iv: destMat.iv });
  const destToken = await acquireAppToken(destMat.tenantId, destMat.clientId, destSecret);

  // Source tenant token (optional — used to enrich provisioning metadata).
  const srcMat = await tenantsDb.getSecretMaterial(c.env.DB, 'source');
  let srcAccess: string | null = null;
  if (srcMat) {
    try {
      const srcSecret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: srcMat.ciphertext, iv: srcMat.iv });
      srcAccess = (await acquireAppToken(srcMat.tenantId, srcMat.clientId, srcSecret)).accessToken;
    } catch {
      srcAccess = null; // proceed with minimal metadata
    }
  }

  const actor = c.get('session').actorUpn;
  const results: Array<{ migrationUserId: string; ok: boolean; targetUpn?: string; error?: string }> = [];

  for (const id of ids) {
    const user = await usersDb.getById(c.env.DB, id);
    if (!user) {
      results.push({ migrationUserId: id, ok: false, error: 'not found' });
      continue;
    }
    if (!user.autoCreateTarget) {
      results.push({ migrationUserId: id, ok: false, error: 'not marked for auto-create' });
      continue;
    }
    const upn = user.targetUpn ?? user.targetEmail;
    if (!upn) {
      results.push({ migrationUserId: id, ok: false, error: 'no resolved target UPN' });
      continue;
    }

    try {
      // Enrich from source metadata where available.
      let displayName = user.sourceEmail.split('@')[0]!;
      let givenName: string | null = null;
      let surname: string | null = null;
      if (srcAccess) {
        const src = await getUserByEmail(srcAccess, user.sourceEmail);
        if (src) {
          displayName = src.displayName ?? displayName;
          givenName = src.givenName;
          surname = src.surname;
        }
      }

      const password = generateTempPassword();
      const created = await provisionUser(destToken.accessToken, {
        userPrincipalName: upn,
        displayName,
        givenName,
        surname,
        mailNickname: upn.split('@')[0]!,
        password,
      });

      // Best-effort OneDrive personal-site pre-provisioning.
      await preProvisionOneDrive(destToken.accessToken, created.id);

      // Store the temp password envelope-encrypted; purged after the one-time CSV download.
      const enc = await encryptSecret(c.env.MASTER_ENCRYPTION_KEY, password);
      await credsDb.insert(c.env.DB, {
        id: uuid(),
        migrationUserId: id,
        targetUpn: upn,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        createdAt: nowIso(),
      });
      await usersDb.updateMapping(c.env.DB, id, { targetEmail: user.targetEmail, targetUpn: upn, mappingStatus: 'provisioned' });
      billUsage(c.executionCtx, c.env, { d1Writes: 2 });

      await audit(c.env.DB, actor, 'provision', upn, 'created + credential stored');
      billUsage(c.executionCtx, c.env, { d1Writes: 1 });

      results.push({ migrationUserId: id, ok: true, targetUpn: upn });
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown error';
      await audit(c.env.DB, actor, 'provision', upn, `FAILED: ${detail}`);
      billUsage(c.executionCtx, c.env, { d1Writes: 1 });
      results.push({ migrationUserId: id, ok: false, targetUpn: upn, error: detail });
    }
  }

  // Client contract: ProvisionResult { provisioned, failed, credentialsPending }.
  const provisioned = results
    .filter((r) => r.ok)
    .map((r) => ({ migrationUserId: r.migrationUserId, targetUpn: r.targetUpn ?? '' }));
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ migrationUserId: r.migrationUserId, reason: r.error ?? 'unknown error' }));
  // Credentials are stored (envelope-encrypted) only on successful provisioning.
  return c.json({ provisioned, failed, credentialsPending: provisioned.length > 0 });
});
