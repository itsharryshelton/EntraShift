/**
 * Server-side sessions (SoW Phase 0).
 *
 * Cookie: `es_session` — HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age ≤ 8h.
 * The cookie carries a high-entropy random token; only its SHA-256 hash is persisted as the
 * session row id, so a D1 read never yields a usable cookie. A per-session CSRF token guards
 * all state-changing (non-GET) UI requests.
 */

import type { CookieOptions } from 'hono/utils/cookie';
import type { Env } from '../env';
import type { SessionRecord } from '../db/sessions';
import * as sessionsDb from '../db/sessions';
import { opaqueToken, sha256Hex } from '../lib/ids';
import { isoInSeconds, nowIso } from '../lib/time';

export const SESSION_COOKIE = 'es_session';
const MAX_TTL_SECONDS = 8 * 60 * 60; // hard 8h ceiling regardless of config.

function ttlSeconds(env: Env): number {
  const configured = Number(env.SESSION_TTL_SECONDS);
  const ttl = Number.isFinite(configured) && configured > 0 ? configured : MAX_TTL_SECONDS;
  return Math.min(ttl, MAX_TTL_SECONDS);
}

/** Cookie attributes — the security posture is fixed here, not per call-site. */
export function sessionCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: ttlSeconds(env),
  };
}

export interface NewSession {
  rawToken: string; // set as the cookie value
  csrfToken: string; // returned to the client via /api/me; echoed in X-CSRF-Token
  expiresAt: string;
}

/** Create and persist a session for a verified identity. */
export async function createSession(
  env: Env,
  identity: { upn: string; oid: string; displayName: string | null; groupOk: boolean },
): Promise<NewSession> {
  const rawToken = opaqueToken(32);
  const id = await sha256Hex(rawToken);
  const csrfToken = opaqueToken(24);
  const createdAt = nowIso();
  const expiresAt = isoInSeconds(ttlSeconds(env));

  const record: SessionRecord = {
    id,
    actorUpn: identity.upn,
    actorOid: identity.oid,
    displayName: identity.displayName,
    groupOk: identity.groupOk,
    csrfToken,
    createdAt,
    expiresAt,
  };
  await sessionsDb.createSession(env.DB, record);
  // Opportunistic cleanup of expired rows (keeps the table small on the free tier).
  await sessionsDb.deleteExpiredSessions(env.DB, createdAt);
  return { rawToken, csrfToken, expiresAt };
}

/** Resolve a raw cookie token to a live session, or null if missing/expired. */
export async function resolveSession(env: Env, rawToken: string | undefined): Promise<SessionRecord | null> {
  if (!rawToken) return null;
  const id = await sha256Hex(rawToken);
  const record = await sessionsDb.getSession(env.DB, id);
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= Date.now()) {
    await sessionsDb.deleteSession(env.DB, id);
    return null;
  }
  return record;
}

/** Destroy the session behind a raw cookie token. */
export async function destroySession(env: Env, rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await sessionsDb.deleteSession(env.DB, await sha256Hex(rawToken));
}
