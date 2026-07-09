import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateTempPassword } from '../src/lib/crypto';

/** Generate a fresh base64 32-byte AES-256 key for a test. */
function makeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('envelope encryption (AES-256-GCM)', () => {
  it('round-trips plaintext', async () => {
    const key = makeKey();
    const plaintext = 'a-tenant-client-secret~with symbols !@#$';
    const env = await encryptSecret(key, plaintext);

    expect(env.ciphertext).toBeTypeOf('string');
    expect(env.iv).toBeTypeOf('string');
    expect(env.ciphertext).not.toContain(plaintext);

    const back = await decryptSecret(key, env);
    expect(back).toBe(plaintext);
  });

  it('uses a fresh IV (and therefore different ciphertext) each time', async () => {
    const key = makeKey();
    const a = await encryptSecret(key, 'same-input');
    const b = await encryptSecret(key, 'same-input');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects decryption under the wrong key', async () => {
    const env = await encryptSecret(makeKey(), 'hello');
    await expect(decryptSecret(makeKey(), env)).rejects.toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag)', async () => {
    const key = makeKey();
    const env = await encryptSecret(key, 'integrity-protected');
    // Flip one byte of the ciphertext.
    const raw = atob(env.ciphertext);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    await expect(decryptSecret(key, { ciphertext: btoa(bin), iv: env.iv })).rejects.toThrow();
  });

  it('rejects a non-32-byte master key', async () => {
    await expect(encryptSecret(btoa('too-short'), 'x')).rejects.toThrow();
  });
});

describe('generateTempPassword', () => {
  it('meets complexity (upper, lower, digit, symbol) and length', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword(20);
      expect(pw.length).toBe(20);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
      expect(/[^A-Za-z0-9]/.test(pw)).toBe(true);
    }
  });

  it('produces distinct passwords', () => {
    const a = generateTempPassword();
    const b = generateTempPassword();
    expect(a).not.toBe(b);
  });
});
