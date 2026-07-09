/** UUID + opaque-token helpers (WebCrypto, available in workerd). */

/** RFC-4122 v4 UUID. Used for all primary keys. */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * A high-entropy URL-safe opaque token (default 32 bytes → 43 base64url chars).
 * Used for raw session cookie values and OIDC `state`.
 */
export function opaqueToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(buf);
}

/** base64url (no padding) of raw bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of a string, returned as lowercase hex. Used to hash session ids at rest. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
