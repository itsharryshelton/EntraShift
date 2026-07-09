/**
 * Auth routes (`/auth/*`). The ONLY routes reachable without a session are `/auth/login` and
 * `/auth/callback` (the OIDC redirect + return). Everything else requires a session.
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { isoInSeconds, isPast, nowIso } from '../lib/time';
import { opaqueToken } from '../lib/ids';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import { buildAuthorizeUrl, createPkcePair, exchangeCode, validateIdToken } from '../auth/oidc';
import { SESSION_COOKIE, createSession, destroySession, resolveSession, sessionCookieOptions } from '../auth/session';
import { DEV_IDENTITY, devBypassActive } from '../auth/devbypass';
import * as sessionsDb from '../db/sessions';

/** Same-site relative redirect only (avoid open-redirect). */
function safeRedirect(target: string | undefined): string {
  return target && target.startsWith('/') ? target : '/';
}

const AUTH_FLOW_TTL_SEC = 600; // 10 minutes for the round-trip.

export const authRouter = new Hono<AppEnv>();

/** GET /auth/login — start the PKCE auth-code flow. */
authRouter.get('/login', async (c) => {
  // ⚠️ DEV ONLY: localhost SSO bypass (auth/devbypass.ts). Double-gated + fails closed off
  // localhost. Mints a normal server-side session for a synthetic dev identity, skipping Entra.
  if (devBypassActive(c.env, new URL(c.req.url))) {
    const session = await createSession(c.env, DEV_IDENTITY);
    billUsage(c.executionCtx, c.env, { d1Writes: 2 });
    setCookie(c, SESSION_COOKIE, session.rawToken, sessionCookieOptions(c.env));
    await audit(c.env.DB, DEV_IDENTITY.upn, 'sign_in', DEV_IDENTITY.upn, 'DEV_AUTH_BYPASS (localhost)');
    billUsage(c.executionCtx, c.env, { d1Writes: 1 });
    console.warn('⚠️ DEV_AUTH_BYPASS: minted a local dev session without Entra SSO. NOT FOR PRODUCTION.');
    return c.redirect(safeRedirect(c.req.query('redirect_to')), 302);
  }

  const { verifier, challenge } = await createPkcePair();
  const state = opaqueToken(24);
  const nonce = opaqueToken(24);
  const redirectTo = c.req.query('redirect_to') ?? '/';

  await sessionsDb.createAuthFlow(c.env.DB, {
    state,
    codeVerifier: verifier,
    nonce,
    // Only allow same-site relative redirects (avoid open-redirect).
    redirectTo: redirectTo.startsWith('/') ? redirectTo : '/',
    createdAt: nowIso(),
    expiresAt: isoInSeconds(AUTH_FLOW_TTL_SEC),
  });
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.redirect(buildAuthorizeUrl(c.env, { state, nonce, challenge }), 302);
});

/** GET /auth/callback — validate the response, enforce the group claim, mint the session. */
authRouter.get('/callback', async (c) => {
  const url = new URL(c.req.url);
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    throw err.unauthorized('Sign-in failed', url.searchParams.get('error_description') ?? oauthError);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw err.validation('Missing code or state');

  const flow = await sessionsDb.takeAuthFlow(c.env.DB, state); // single-use (deletes on read)
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });
  if (!flow) throw err.unauthorized('Unknown or reused state');
  if (isPast(flow.expiresAt)) throw err.unauthorized('Sign-in state expired; please retry');

  const idToken = await exchangeCode(c.env, code, flow.codeVerifier);
  const identity = await validateIdToken(c.env, idToken, flow.nonce); // throws if not in MSP group

  const session = await createSession(c.env, identity);
  billUsage(c.executionCtx, c.env, { d1Writes: 2 }); // session insert + expired-cleanup
  setCookie(c, SESSION_COOKIE, session.rawToken, sessionCookieOptions(c.env));

  await audit(c.env.DB, identity.upn, 'sign_in', identity.upn, null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.redirect(flow.redirectTo ?? '/', 302);
});

/** POST /auth/logout — destroy the session. Verifies session + CSRF explicitly (not behind the UI guard). */
authRouter.post('/logout', async (c) => {
  const raw = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c.env, raw);
  if (session) {
    const provided = c.req.header('X-CSRF-Token');
    if (!provided || provided !== session.csrfToken) throw err.csrf();
    await destroySession(c.env, raw);
    await audit(c.env.DB, session.actorUpn, 'sign_out', session.actorUpn, null);
    billUsage(c.executionCtx, c.env, { d1Writes: 2 });
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});
