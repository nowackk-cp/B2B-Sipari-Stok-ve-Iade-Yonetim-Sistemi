import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../src/common/config/app-config.service';
import {
  PasswordResetDeliveryCipher,
  type SealedSecret,
} from '../../src/modules/security/password-reset-delivery.cipher';

/** Build a cipher bound to a specific env key (only that getter is needed). */
function cipherWithKey(key: string): PasswordResetDeliveryCipher {
  return new PasswordResetDeliveryCipher({
    passwordResetDeliveryKey: key,
  } as unknown as AppConfigService);
}

const KEY_A = 'unit-test-reset-delivery-key-aaaaaaaaaaaaaaaa';
const KEY_B = 'unit-test-reset-delivery-key-bbbbbbbbbbbbbbbb';
const RAW_TOKEN = 'Eh-Vh1l3aQp4r6Wc9Zt2sFnK8bX0mYgJ7uLqD5oN1A';

describe('PasswordResetDeliveryCipher (AES-256-GCM)', () => {
  it('fails fast when the key is shorter than 32 bytes', () => {
    expect(() => cipherWithKey('too-short-key')).toThrow(/at least 32 bytes/);
  });

  it('round-trips a token: decrypt(encrypt(x)) === x', () => {
    const cipher = cipherWithKey(KEY_A);
    const sealed = cipher.encrypt(RAW_TOKEN);
    expect(cipher.decrypt(sealed)).toBe(RAW_TOKEN);
  });

  it('ciphertext is not the raw token and uses a fresh nonce each time', () => {
    const cipher = cipherWithKey(KEY_A);
    const a = cipher.encrypt(RAW_TOKEN);
    const b = cipher.encrypt(RAW_TOKEN);
    expect(a.ciphertext.toString('utf8')).not.toBe(RAW_TOKEN);
    expect(a.ciphertext.toString('base64')).not.toContain(RAW_TOKEN);
    // Random nonce → identical plaintext yields different ciphertext/nonce.
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('decrypts with the correct key', () => {
    const sealed = cipherWithKey(KEY_A).encrypt(RAW_TOKEN);
    expect(cipherWithKey(KEY_A).decrypt(sealed)).toBe(RAW_TOKEN);
  });

  it('fails to decrypt with the wrong key', () => {
    const sealed = cipherWithKey(KEY_A).encrypt(RAW_TOKEN);
    expect(() => cipherWithKey(KEY_B).decrypt(sealed)).toThrow();
  });

  it('fails authentication when the ciphertext is tampered with', () => {
    const cipher = cipherWithKey(KEY_A);
    const sealed = cipher.encrypt(RAW_TOKEN);
    const corrupted = Buffer.from(sealed.ciphertext);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff; // flip a bit
    const tampered: SealedSecret = { ...sealed, ciphertext: corrupted };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('fails authentication when the auth tag is tampered with', () => {
    const cipher = cipherWithKey(KEY_A);
    const sealed = cipher.encrypt(RAW_TOKEN);
    const corrupted = Buffer.from(sealed.authTag);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    const tampered: SealedSecret = { ...sealed, authTag: corrupted };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });
});
