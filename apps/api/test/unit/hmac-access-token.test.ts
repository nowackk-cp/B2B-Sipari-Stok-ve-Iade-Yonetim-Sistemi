import { describe, expect, it } from 'vitest';
import { HmacAccessTokenSigner } from '../../src/modules/auth/adapters/hmac-access-token.signer';
import { InvalidAccessTokenError } from '../../src/modules/auth/ports/access-token.port';
import { FakeClock, fakeConfig } from './_fakes';

function signer(clock = new FakeClock(), config = fakeConfig()) {
  return new HmacAccessTokenSigner(config, clock);
}

describe('HmacAccessTokenSigner', () => {
  it('issues a token with the minimal required claims', () => {
    const { token, claims, expiresIn } = signer().issue({
      subject: 'user-uuid',
      sessionId: 'sess-uuid',
    });
    expect(token.split('.')).toHaveLength(3);
    expect(claims.sub).toBe('user-uuid');
    expect(claims.sid).toBe('sess-uuid');
    expect(claims.iss).toBe('b2b-operations-suite');
    expect(claims.aud).toBe('b2b-api');
    expect(claims.exp - claims.iat).toBe(expiresIn);
    // No PII / authorization data embedded.
    expect(Object.keys(claims).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'].concat(['sid']).sort(),
    );
  });

  it('round-trips issue → verify', () => {
    const s = signer();
    const { token } = s.issue({ subject: 'u', sessionId: 's' });
    expect(s.verify(token).sub).toBe('u');
  });

  it('rejects a tampered signature', () => {
    const s = signer();
    const { token } = s.issue({ subject: 'u', sessionId: 's' });
    const tampered = `${token.slice(0, -3)}xyz`;
    expect(() => s.verify(tampered)).toThrow(InvalidAccessTokenError);
  });

  it('rejects a token signed with a different secret', () => {
    const a = signer(new FakeClock(), fakeConfig({ jwtAccessSecret: 'a'.repeat(40) }));
    const b = signer(new FakeClock(), fakeConfig({ jwtAccessSecret: 'b'.repeat(40) }));
    const { token } = a.issue({ subject: 'u', sessionId: 's' });
    expect(() => b.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it('rejects an expired token', () => {
    const clock = new FakeClock();
    const s = signer(clock);
    const { token } = s.issue({ subject: 'u', sessionId: 's' });
    clock.advanceMs(901_000); // past the 900s TTL
    expect(() => s.verify(token)).toThrow(/expired/);
  });

  it('rejects a wrong issuer / audience', () => {
    const issued = signer().issue({ subject: 'u', sessionId: 's' });
    const wrongIss = signer(new FakeClock(), fakeConfig({ jwtIssuer: 'evil' }));
    const wrongAud = signer(new FakeClock(), fakeConfig({ jwtAudience: 'evil' }));
    expect(() => wrongIss.verify(issued.token)).toThrow(/issuer/);
    expect(() => wrongAud.verify(issued.token)).toThrow(/audience/);
  });

  it('rejects a malformed token', () => {
    expect(() => signer().verify('a.b')).toThrow(InvalidAccessTokenError);
    expect(() => signer().verify('not-a-jwt')).toThrow(InvalidAccessTokenError);
  });
});
