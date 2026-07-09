/**
 * D1 access for `sessions` (server-side Entra SSO sessions) and `auth_flow`
 * (transient PKCE/nonce state during the OIDC handshake).
 *
 * The session cookie carries a raw random token; only its SHA-256 hash is stored as the
 * row id (schema comment: "the cookie value, hashed"). A DB read leaks no usable cookie.
 */

export interface SessionRecord {
  /** SHA-256 hex of the raw cookie token — the primary key. */
  id: string;
  actorUpn: string;
  actorOid: string;
  displayName: string | null;
  groupOk: boolean;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

interface SessionRowRaw {
  id: string;
  actor_upn: string;
  actor_oid: string;
  display_name: string | null;
  group_ok: number;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}

function mapSession(r: SessionRowRaw): SessionRecord {
  return {
    id: r.id,
    actorUpn: r.actor_upn,
    actorOid: r.actor_oid,
    displayName: r.display_name,
    groupOk: r.group_ok === 1,
    csrfToken: r.csrf_token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export async function createSession(db: D1Database, s: SessionRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, actor_upn, actor_oid, display_name, group_ok, csrf_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.id, s.actorUpn, s.actorOid, s.displayName, s.groupOk ? 1 : 0, s.csrfToken, s.createdAt, s.expiresAt)
    .run();
}

/** Look up by hashed id. Returns null if missing. Callers must still check expiry. */
export async function getSession(db: D1Database, hashedId: string): Promise<SessionRecord | null> {
  const raw = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(hashedId).first<SessionRowRaw>();
  return raw ? mapSession(raw) : null;
}

export async function deleteSession(db: D1Database, hashedId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(hashedId).run();
}

/** Housekeeping — remove expired sessions (called opportunistically). */
export async function deleteExpiredSessions(db: D1Database, nowIso: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso).run();
}

/* ------------------------- OIDC auth-flow state ------------------------- */

export interface AuthFlowRecord {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectTo: string | null;
  createdAt: string;
  expiresAt: string;
}

interface AuthFlowRowRaw {
  state: string;
  code_verifier: string;
  nonce: string;
  redirect_to: string | null;
  created_at: string;
  expires_at: string;
}

export async function createAuthFlow(db: D1Database, f: AuthFlowRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_flow (state, code_verifier, nonce, redirect_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(f.state, f.codeVerifier, f.nonce, f.redirectTo, f.createdAt, f.expiresAt)
    .run();
}

export async function takeAuthFlow(db: D1Database, state: string): Promise<AuthFlowRecord | null> {
  const raw = await db.prepare('SELECT * FROM auth_flow WHERE state = ?').bind(state).first<AuthFlowRowRaw>();
  if (!raw) return null;
  // Single-use: consume on read so a state/code can never be replayed.
  await db.prepare('DELETE FROM auth_flow WHERE state = ?').bind(state).run();
  return {
    state: raw.state,
    codeVerifier: raw.code_verifier,
    nonce: raw.nonce,
    redirectTo: raw.redirect_to,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
  };
}
