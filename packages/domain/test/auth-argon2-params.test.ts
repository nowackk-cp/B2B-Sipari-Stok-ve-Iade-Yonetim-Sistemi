import { describe, expect, it } from 'vitest';
import { needsRehash, parseArgon2Hash } from '../src';

const TARGET = { memoryKiB: 19456, iterations: 3, parallelism: 1 };
const sample = (m: number, t: number, p: number) =>
  `$argon2id$v=19$m=${m},t=${t},p=${p}$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo`;

describe('argon2 params', () => {
  it('parses the encoded parameters', () => {
    expect(parseArgon2Hash(sample(19456, 3, 1))).toEqual({
      type: 'argon2id',
      memoryKiB: 19456,
      iterations: 3,
      parallelism: 1,
    });
  });

  it('returns null for a non-argon2 string', () => {
    expect(parseArgon2Hash('not-a-hash')).toBeNull();
    expect(parseArgon2Hash('$2b$12$abcdef')).toBeNull();
  });

  it('does not require rehash when params meet or exceed the target', () => {
    expect(needsRehash(sample(19456, 3, 1), TARGET)).toBe(false);
    expect(needsRehash(sample(32768, 4, 2), TARGET)).toBe(false);
  });

  it('requires rehash when any param is weaker than the target', () => {
    expect(needsRehash(sample(8192, 3, 1), TARGET)).toBe(true); // weaker memory
    expect(needsRehash(sample(19456, 2, 1), TARGET)).toBe(true); // fewer iterations
  });

  it('requires rehash for a non-argon2id variant or unparseable hash', () => {
    expect(needsRehash('$argon2i$v=19$m=19456,t=3,p=1$x$y', TARGET)).toBe(true);
    expect(needsRehash('garbage', TARGET)).toBe(true);
  });
});
