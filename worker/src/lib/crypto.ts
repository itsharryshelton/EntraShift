/**
 * Envelope encryption for the control plane (SoW Phase 0).
 *
 * AES-256-GCM under a single master key held ONLY as a Worker Secret
 * (`MASTER_ENCRYPTION_KEY`, base64 32 bytes). Tenant client secrets and temporary
 * provisioning passwords are stored in D1 as ciphertext + IV only — never plaintext,
 * never returned to the browser, never logged.
 *
 * SECURITY NOTES:
 *  - 12-byte random IV per encryption (GCM nonce). Never reuse an IV under the same key.
 *  - GCM auth tag is appended to the ciphertext by WebCrypto and verified on decrypt;
 *    a tampered ciphertext throws (integrity + confidentiality).
 *  - The master key is imported non-extractable so it cannot be exported from the isolate.
 *  - Key rotation re-encrypts on secret re-entry (there is no reveal path).
 */

import { ApiError } from './errors';

const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const MASTER_KEY_BYTES = 32; // AES-256.

export interface EnvelopeCiphertext {
  /** base64 AES-256-GCM ciphertext (includes the 16-byte auth tag). */
  ciphertext: string;
  /** base64 12-byte random IV / nonce. */
  iv: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(masterKeyB64);
  } catch {
    throw new ApiError('internal', 'MASTER_ENCRYPTION_KEY is not valid base64');
  }
  if (raw.byteLength !== MASTER_KEY_BYTES) {
    throw new ApiError('internal', `MASTER_ENCRYPTION_KEY must decode to ${MASTER_KEY_BYTES} bytes (AES-256)`);
  }
  // extractable=false → the key material can never be read back out of the isolate.
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt UTF-8 plaintext. Returns base64 ciphertext (with tag) + base64 IV. */
export async function encryptSecret(masterKeyB64: string, plaintext: string): Promise<EnvelopeCiphertext> {
  const key = await importMasterKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
}

/** Decrypt back to UTF-8 plaintext. Throws if the ciphertext/tag/IV fails verification. */
export async function decryptSecret(masterKeyB64: string, env: EnvelopeCiphertext): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ciphertext));
  } catch {
    // Wrong key, corrupted ciphertext, or tampering — never leak which.
    throw new ApiError('internal', 'Secret decryption failed (bad key or corrupted ciphertext)');
  }
  return new TextDecoder().decode(plain);
}

// Character classes for a complexity-valid Entra temporary password.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O (ambiguous)
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const DIGIT = '23456789'; // no 0/1
const SYMBOL = '!@#$%^&*-_=+?';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/** Pick one char from `set` using rejection sampling for an unbiased choice. */
function pick(set: string): string {
  const max = 256 - (256 % set.length);
  const buf = new Uint8Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0]!;
  } while (v >= max);
  return set[v % set.length]!;
}

/**
 * Cryptographically-random temporary password that satisfies the Entra default policy
 * (>=8 chars, at least 3 of 4 character classes — we guarantee all 4).
 * Used with forceChangePasswordNextSignIn; delivered once via the password CSV, then purged.
 */
export function generateTempPassword(length = 20): string {
  if (length < 8) length = 8;
  // Guarantee one of each class, then fill the rest, then shuffle.
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher–Yates shuffle with CSPRNG so the guaranteed chars aren't positionally predictable.
  for (let i = chars.length - 1; i > 0; i--) {
    const r = new Uint8Array(1);
    let j: number;
    const max = 256 - (256 % (i + 1));
    do {
      crypto.getRandomValues(r);
      j = r[0]!;
    } while (j >= max);
    j %= i + 1;
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
