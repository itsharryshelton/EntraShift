/**
 * Temporary-password delivery (`/api/passwords`, SoW Phase 3).
 *
 * ONE-TIME CSV download to the engineer. The plaintext is decrypted transiently to build the CSV,
 * then the ciphertext is PURGED from D1 in the same request. Requires an explicit acknowledge flag
 * (the UI shows a credential-handling warning + checkbox). The download is audit-logged.
 *
 * SECURITY: after download the passwords are unrecoverable from the control plane. Every account is
 * force-change-at-next-sign-in, so the exposure window is a single first sign-in. The CSV itself
 * contains live credentials — the engineer must handle and delete it per credential-handling policy.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { nowIso } from '../lib/time';
import { decryptSecret } from '../lib/crypto';
import { serializeCsv } from '../lib/csv';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import * as credsDb from '../db/credentials';

export const passwordsRouter = new Hono<AppEnv>();

/** GET /api/passwords — how many credentials await the one-time download (drives the UI gate). */
passwordsRouter.get('/', async (c) => {
  return c.json({ pending: await credsDb.countPending(c.env.DB) });
});

/** GET /api/passwords/download?acknowledge=true — one-time CSV, then purge. */
passwordsRouter.get('/download', async (c) => {
  if (c.req.query('acknowledge') !== 'true') {
    throw err.validation('Download requires acknowledge=true (the file contains live credentials)');
  }

  const pending = await credsDb.listPending(c.env.DB);
  if (pending.length === 0) throw err.notFound('No temporary passwords are pending download');

  const rows: Array<Array<string | boolean>> = [];
  for (const cred of pending) {
    const password = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: cred.ciphertext, iv: cred.iv });
    rows.push([cred.targetUpn, password, true]);
  }
  const csv = serializeCsv(['TargetUpn', 'TemporaryPassword', 'ForceChangeAtNextSignIn'], rows);

  // Purge in the same request so this truly is one-time.
  const now = nowIso();
  await credsDb.markDownloadedAndPurge(c.env.DB, pending.map((p) => p.id), now);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(c.env.DB, c.get('session').actorUpn, 'password_csv_download', null, `downloaded ${pending.length} credential(s)`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="entrashift-temp-passwords.csv"',
      // Never cache credentials at any layer.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
    },
  });
});
