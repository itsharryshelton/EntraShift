/**
 * ⚠️ DEVELOPMENT-ONLY Entra ID SSO bypass. ⚠️
 *
 * Lets an engineer exercise the UI on localhost via `wrangler dev` WITHOUT a real Entra ID /
 * Microsoft 365 connection. It replaces only the *identity source* — a normal server-side
 * session (real CSRF token, HttpOnly cookie, ≤8h expiry) is still minted, so nothing else in
 * the auth stack is weakened.
 *
 * SECURITY — double-gated, fails closed. The bypass activates ONLY when BOTH hold:
 *   1. env.DEV_AUTH_BYPASS === "true"  — set ONLY in `.dev.vars` (git-ignored). It must NEVER
 *      appear in wrangler.jsonc vars and must NEVER be set as a production Worker Secret.
 *   2. the request host is localhost / 127.0.0.1 / [::1].
 * If the flag is set on a non-localhost host it is IGNORED (normal SSO runs) and a loud error
 * is logged — a deployed Worker can never be bypassed even if the flag leaks into its config.
 *
 * This entire file must be removed (or the flag verified-absent) before the security review
 * gate (SoW §5). Grep the repo for DEV_AUTH_BYPASS to find every touch-point.
 */

import type { Env } from '../env';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True only for loopback hosts. */
export function isLocalRequest(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

/** Whether the dev SSO bypass should activate for this request. Fails closed off localhost. */
export function devBypassActive(env: Env, url: URL): boolean {
  if (env.DEV_AUTH_BYPASS !== 'true') return false;
  if (!isLocalRequest(url)) {
    // Flag is on but we are NOT on localhost → refuse to bypass and shout. This is the
    // last line of defence against the flag ever reaching a deployed environment.
    console.error(
      `SECURITY: DEV_AUTH_BYPASS is set but the request host is "${url.hostname}", not localhost. ` +
        `Ignoring the bypass and enforcing normal Entra ID SSO. Unset DEV_AUTH_BYPASS here immediately.`,
    );
    return false;
  }
  return true;
}

/** The synthetic identity used for a bypassed local session. Obviously not a real user. */
export const DEV_IDENTITY = {
  upn: 'dev@localhost',
  oid: 'dev-local-bypass',
  displayName: 'Local Dev (SSO bypassed)',
  groupOk: true,
} as const;
