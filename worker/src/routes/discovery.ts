/**
 * Directory discovery (`/api/discovery`, SoW Phase 2).
 * Live source-tenant users via Graph `User.Read.All`, run Worker-side and paginated.
 * Read-only — no budget writes.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { decryptSecret } from '../lib/crypto';
import { acquireAppToken, discoverUsers } from '../graph/client';
import * as tenantsDb from '../db/tenants';

export const discoveryRouter = new Hono<AppEnv>();

/** GET /api/discovery/users?search=&cursor= */
discoveryRouter.get('/users', async (c) => {
  const material = await tenantsDb.getSecretMaterial(c.env.DB, 'source');
  if (!material) throw err.validation('No source tenant is connected');

  const secret = await decryptSecret(c.env.MASTER_ENCRYPTION_KEY, { ciphertext: material.ciphertext, iv: material.iv });
  const token = await acquireAppToken(material.tenantId, material.clientId, secret);

  const search = c.req.query('search') || undefined;
  const cursor = c.req.query('cursor') || undefined;
  const { users, nextCursor } = await discoverUsers(token.accessToken, { search, cursor });

  // Client contract: Paged<T> = { items, cursor }.
  return c.json({ items: users, cursor: nextCursor });
});
