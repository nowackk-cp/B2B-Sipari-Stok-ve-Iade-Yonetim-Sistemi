import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from '../../src/modules/auth/adapters/argon2-password-hasher';
import { fakeConfig } from './_fakes';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher(fakeConfig());

  it('produces an argon2id PHC hash that verifies', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('wrong password value', hash)).toBe(false);
  });

  it('returns false (never throws) for a malformed hash', async () => {
    expect(await hasher.verify('whatever', 'not-a-hash')).toBe(false);
  });

  it('generates a distinct salt per hash', async () => {
    const a = await hasher.hash('correct horse battery staple');
    const b = await hasher.hash('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('flags a weaker stored hash for rehash and leaves a current one alone', async () => {
    const weak = `$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo`;
    expect(hasher.needsRehash(weak)).toBe(true);
    const current = await hasher.hash('correct horse battery staple');
    expect(hasher.needsRehash(current)).toBe(false);
  });
});
