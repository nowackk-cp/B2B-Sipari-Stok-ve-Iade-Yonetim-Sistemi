import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../common/config/app-config.service';
import { CLOCK, type Clock } from '../../../common/time/clock';
import {
  type AccessTokenClaims,
  type AccessTokenSigner,
  InvalidAccessTokenError,
  type IssueAccessTokenInput,
  type IssuedAccessToken,
} from '../ports/access-token.port';

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Compact-JWS access-token signer (HS256) built on Node's `crypto`. No external
 * JWT library: a dependency-free, fully controllable implementation that
 * verifies the signature with a constant-time compare and validates `exp`,
 * `iss` and `aud`. The HMAC secret length is enforced at config load (>=32).
 *
 * Verification NEVER decodes claims without checking the signature first
 * (no `jwt.decode`-style trust).
 */
@Injectable()
export class HmacAccessTokenSigner implements AccessTokenSigner {
  constructor(
    private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  issue(input: IssueAccessTokenInput): IssuedAccessToken {
    const expiresIn = this.config.jwtAccessTtlSeconds;
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const claims: AccessTokenClaims = {
      sub: input.subject,
      sid: input.sessionId,
      jti: randomUUID(),
      iat,
      exp: iat + expiresIn,
      iss: this.config.jwtIssuer,
      aud: this.config.jwtAudience,
    };
    const signingInput = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(claims))}`;
    const token = `${signingInput}.${this.sign(signingInput)}`;
    return { token, expiresIn, claims };
  }

  verify(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new InvalidAccessTokenError('malformed token');
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const expected = this.sign(`${headerB64}.${payloadB64}`);
    if (!constantTimeEquals(signatureB64, expected)) {
      throw new InvalidAccessTokenError('bad signature');
    }

    const header = safeJsonParse(headerB64);
    if (!header || header.alg !== HEADER.alg || header.typ !== HEADER.typ) {
      throw new InvalidAccessTokenError('unsupported header');
    }

    const claims = safeJsonParse(payloadB64) as AccessTokenClaims | null;
    if (!claims) throw new InvalidAccessTokenError('unparseable claims');
    if (claims.iss !== this.config.jwtIssuer) throw new InvalidAccessTokenError('wrong issuer');
    if (claims.aud !== this.config.jwtAudience) throw new InvalidAccessTokenError('wrong audience');
    const now = Math.floor(this.clock.now().getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) {
      throw new InvalidAccessTokenError('expired');
    }
    if (!claims.sub || !claims.sid) throw new InvalidAccessTokenError('missing subject/session');
    return claims;
  }

  private sign(signingInput: string): string {
    return createHmac('sha256', this.config.jwtAccessSecret)
      .update(signingInput)
      .digest('base64url');
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function safeJsonParse(b64: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
