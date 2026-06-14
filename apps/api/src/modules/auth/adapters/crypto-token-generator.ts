import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OpaqueToken, TokenGenerator } from '../ports/token-generator.port';

/** Token entropy in bytes (256 bits → 43-char base64url string). */
const TOKEN_BYTES = 32;

/**
 * CSPRNG opaque-token generator. Tokens are 256-bit random base64url strings;
 * the stored value is their SHA-256 hex digest. SHA-256 is appropriate here
 * because the input is high-entropy random (unlike a password), so no slow KDF
 * is required and digest lookup stays a simple unique-index probe.
 */
@Injectable()
export class CryptoTokenGenerator implements TokenGenerator {
  generate(): OpaqueToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, digest: this.digest(token) };
  }

  digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
