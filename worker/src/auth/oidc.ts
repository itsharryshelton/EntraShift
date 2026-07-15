/**
 * Entra ID SSO for the Web UI (SoW Phase 0).
 *
 * OpenID Connect Authorization-Code flow with PKCE (S256), handled entirely in the Worker.
 * Delegated scopes are `openid profile email` ONLY. Access is restricted to members of the
 * designated MSP security group, validated via the `groups` claim in the id_token.
 *
 * Overage note: if the signed-in user is a member of too many groups, Entra emits a `_claim_names`
 * overage instead of an inline `groups` array and the membership must be resolved via Graph.
 * v1 requires the group to appear inline; configure the app registration's
 * groupMembershipClaims to emit SecurityGroup and, for large directories, use a group-filtered
 * assignment so the claim never overflows. Document this in the deployment guide.
 */

import type { Env } from '../env';
import { err } from '../lib/errors';
import { base64UrlEncode, opaqueToken } from '../lib/ids';
import { verifyRs256 } from '../lib/jwt';

const SCOPES = 'openid profile email';

function authority(env: Env): string {
  return `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}`;
}

/** PKCE code_verifier (43–128 chars, high entropy) + its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = opaqueToken(48); // ~64 base64url chars
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

/** Build the Entra authorize URL. `state` and `nonce` are correlated server-side (auth_flow). */
export function buildAuthorizeUrl(env: Env, params: { state: string; nonce: string; challenge: string }): string {
  const url = new URL(`${authority(env)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.OIDC_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Exchange the auth code for tokens (confidential client — uses OIDC_CLIENT_SECRET). */
export async function exchangeCode(env: Env, code: string, codeVerifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.OIDC_CLIENT_ID,
    client_secret: env.OIDC_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.OIDC_REDIRECT_URI,
    code_verifier: codeVerifier,
    scope: SCOPES,
  });
  const res = await fetch(`${authority(env)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.id_token) {
    throw err.token('OIDC code exchange failed', json.error_description ?? json.error ?? `HTTP ${res.status}`);
  }
  return json.id_token;
}

export interface VerifiedIdentity {
  upn: string;
  oid: string;
  displayName: string | null;
  groupOk: boolean;
}

/**
 * Verify the id_token: RS256 signature (Entra JWKS), issuer, audience, nonce, exp — and REQUIRE
 * the MSP security-group membership via the `groups` claim.
 */
export async function validateIdToken(env: Env, idToken: string, expectedNonce: string): Promise<VerifiedIdentity> {
  const claims = await verifyRs256(idToken, {
    jwksUri: `${authority(env)}/discovery/v2.0/keys`,
    audience: env.OIDC_CLIENT_ID,
    issuer: `${authority(env)}/v2.0`,
  });

  if (claims.nonce !== expectedNonce) throw err.unauthorized('id_token nonce mismatch');

  const groups = Array.isArray((claims as { groups?: unknown }).groups)
    ? ((claims as { groups: unknown[] }).groups as unknown[]).map(String)
    : [];
  const groupOk = groups.includes(env.ALLOWED_GROUP_ID);
  if (!groupOk) {
    // Not a member of the MSP security group (or a group-claim overage occurred).
    throw err.forbidden('Not a member of the required MSP security group');
  }

  const upn = (claims['preferred_username'] as string) ?? (claims['upn'] as string) ?? (claims['email'] as string) ?? '';
  const oid = (claims['oid'] as string) ?? (claims['sub'] as string) ?? '';
  const displayName = (claims['name'] as string) ?? null;
  if (!upn || !oid) throw err.unauthorized('id_token missing subject/upn claims');

  return { upn, oid, displayName, groupOk };
}
