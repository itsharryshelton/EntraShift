/**
 * Minimal RS256 JWT verification against a remote JWKS, using WebCrypto only.
 *
 * Used by:
 *  - auth/oidc.ts  — verify the Entra `id_token` (issuer/aud/nonce/exp + signature).
 *  - auth/access.ts — verify the Cloudflare Access `Cf-Access-Jwt-Assertion` (aud + signature).
 *
 * We verify the signature against the issuer's published keys as defence in depth even though
 * both tokens arrive over TLS from a trusted endpoint. JWKS is cached in-isolate for a short TTL
 * to avoid a network round-trip (and Workers request) on every call.
 */

import { ApiError } from './errors';

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

/** Decoded, unverified claims. */
export type JwtClaims = Record<string, unknown> & {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
};

interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface CachedJwks {
  keys: Jwk[];
  fetchedAt: number;
}

const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const jwksCache = new Map<string, CachedJwks>();

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment<T>(seg: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;
}

/** Decode (WITHOUT verifying) the header + claims of a JWT. */
export function decodeJwt(token: string): { header: JwtHeader; claims: JwtClaims } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ApiError('unauthorized', 'Malformed JWT');
  return { header: decodeSegment<JwtHeader>(parts[0]!), claims: decodeSegment<JwtClaims>(parts[1]!) };
}

async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const res = await fetch(jwksUri, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError('unauthorized', `Unable to fetch JWKS (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export interface VerifyOptions {
  jwksUri: string;
  /** Required audience. */
  audience: string;
  /** Required issuer (exact match). Optional for Access tokens. */
  issuer?: string;
  /** Clock-skew tolerance in seconds. */
  clockSkewSec?: number;
}

/**
 * Verify an RS256 JWT: signature (against JWKS by `kid`), `exp`/`nbf`, `aud`, and optional `iss`.
 * Returns the verified claims. Throws ApiError('unauthorized') on any failure.
 */
export async function verifyRs256(token: string, opts: VerifyOptions): Promise<JwtClaims> {
  const { header, claims } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new ApiError('unauthorized', `Unsupported JWT alg: ${header.alg}`);

  const keys = await fetchJwks(opts.jwksUri);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new ApiError('unauthorized', 'Signing key (kid) not found in JWKS');

  const [h, p, s] = token.split('.');
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const signature = b64urlToBytes(s!);
  const key = await importRsaKey(jwk);
  const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signingInput);
  if (!ok) throw new ApiError('unauthorized', 'JWT signature verification failed');

  const skew = opts.clockSkewSec ?? 60;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && now > claims.exp + skew) throw new ApiError('unauthorized', 'JWT expired');
  if (typeof claims.nbf === 'number' && now + skew < claims.nbf) throw new ApiError('unauthorized', 'JWT not yet valid');

  const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!auds.includes(opts.audience)) throw new ApiError('unauthorized', 'JWT audience mismatch');

  if (opts.issuer && claims.iss !== opts.issuer) throw new ApiError('unauthorized', 'JWT issuer mismatch');

  return claims;
}
