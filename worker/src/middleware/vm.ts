/**
 * VM-plane guard: requires a valid Cloudflare Access service-token assertion.
 * Applied to every /api/vm/* route (SoW Phase 0). No session/CSRF applies here.
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { validateAccessToken } from '../auth/access';

export const requireAccessToken = createMiddleware<AppEnv>(async (c, next) => {
  const subject = await validateAccessToken(c.env, c.req.raw);
  c.set('accessSubject', subject);
  await next();
});
