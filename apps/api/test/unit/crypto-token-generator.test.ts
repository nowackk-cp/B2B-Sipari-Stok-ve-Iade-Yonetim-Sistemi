import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoTokenGenerator } from '../../src/modules/auth/adapters/crypto-token-generator';

describe('CryptoTokenGenerator', () => {
  const gen = new CryptoTokenGenerator();

  it('returns a token with its matching SHA-256 digest', () => {
    const { token, digest } = gen.generate();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(digest).toBe(createHash('sha256').update(token).digest('hex'));
    expect(digest).toHaveLength(64);
  });

  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => gen.generate().token));
    expect(tokens.size).toBe(100);
  });

  it('digest() is deterministic and matches generate()', () => {
    const { token, digest } = gen.generate();
    expect(gen.digest(token)).toBe(digest);
  });

  it('never returns the plaintext as the digest', () => {
    const { token, digest } = gen.generate();
    expect(digest).not.toBe(token);
  });
});
