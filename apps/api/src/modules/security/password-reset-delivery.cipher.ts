import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service';

/** AES-256-GCM: 256-bit key, 96-bit nonce (recommended for GCM), 128-bit tag. */
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MIN_KEY_BYTES = 32;

/** Envelope-encrypted secret. All three parts are required to decrypt. */
export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

/**
 * Envelope cipher for the deliverable password-reset token (AUTH-BLOCK-001).
 *
 * The raw bearer token is NEVER persisted in plaintext. It is sealed with
 * AES-256-GCM using a key that exists ONLY in the environment
 * (`PASSWORD_RESET_DELIVERY_KEY`) — never written to the database, a log, or an
 * audit row. GCM's authentication tag means a tampered ciphertext or a wrong key
 * fails `decrypt` instead of returning garbage.
 *
 * Fail-fast: the constructor (run at app boot, since this is a singleton
 * provider) rejects a missing/short key, so the API cannot start with a weak or
 * absent delivery key.
 */
@Injectable()
export class PasswordResetDeliveryCipher {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    const secret = config.passwordResetDeliveryKey;
    const raw = Buffer.from(secret, 'utf8');
    if (raw.byteLength < MIN_KEY_BYTES) {
      throw new Error(
        `PASSWORD_RESET_DELIVERY_KEY must be at least ${MIN_KEY_BYTES} bytes (got ${raw.byteLength}).`,
      );
    }
    // Derive a fixed 256-bit AES key from the env secret. The key material lives
    // only in memory; the source secret is never persisted.
    this.key = createHash('sha256').update(raw).digest();
  }

  /** Seal a plaintext token. A fresh random nonce is used for every call. */
  encrypt(plaintext: string): SealedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag() };
  }

  /**
   * Open a sealed secret. Throws when the auth tag does not verify — i.e. the
   * ciphertext/nonce/tag was tampered with, or the wrong key is configured.
   */
  decrypt(sealed: SealedSecret): string {
    if (sealed.authTag.byteLength !== AUTH_TAG_BYTES) {
      throw new Error('password-reset delivery secret: invalid auth tag length');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, sealed.nonce);
    decipher.setAuthTag(sealed.authTag);
    // `final()` throws if GCM integrity verification fails (tamper / wrong key).
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  }
}
