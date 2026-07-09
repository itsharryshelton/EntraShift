/**
 * UI-plane guard: requires a valid Entra SSO session and enforces CSRF on state-changing requests.
 * Applied to all /api/* routes EXCEPT /api/vm/* (which use the Access service-token guard).
 */

import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { SESSION_COOKIE, resolveSession } from '../auth/session';
import { err } from '../lib/errors';

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c.env, raw);
  if (!session) throw err.unauthorized('No valid session');
  if (!session.groupOk) throw err.forbidden('Not a member of the required MSP security group');
  c.set('session', session);

  // CSRF: state-changing requests must echo the per-session token (SameSite=Strict is belt+braces).
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const provided = c.req.header('X-CSRF-Token');
    if (!provided || provided !== session.csrfToken) throw err.csrf();
  }

  await next();
});
