import { Global, Module } from '@nestjs/common';
import {
  ACCESS_TOKEN_SIGNER,
  EMAIL_OUTBOX,
  PASSWORD_HASHER,
  RATE_LIMITER,
  TOKEN_GENERATOR,
} from './auth.constants';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher';
import { CryptoTokenGenerator } from './adapters/crypto-token-generator';
import { HmacAccessTokenSigner } from './adapters/hmac-access-token.signer';
import { RedisRateLimiter } from './adapters/redis-rate-limiter';
import { OutboxEmailAdapter } from './adapters/outbox-email.adapter';

/**
 * Global bindings for the swappable auth adapters (hashing, opaque tokens,
 * access-token signing, rate limiting, email outbox). Provided globally so the
 * identity/sessions/security/auth modules share one set without circular wiring.
 * Tests override individual tokens (e.g. an in-memory rate limiter / capturing
 * email outbox) via `overrideProvider`.
 */
@Global()
@Module({
  providers: [
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_GENERATOR, useClass: CryptoTokenGenerator },
    { provide: ACCESS_TOKEN_SIGNER, useClass: HmacAccessTokenSigner },
    { provide: RATE_LIMITER, useClass: RedisRateLimiter },
    { provide: EMAIL_OUTBOX, useClass: OutboxEmailAdapter },
  ],
  exports: [PASSWORD_HASHER, TOKEN_GENERATOR, ACCESS_TOKEN_SIGNER, RATE_LIMITER, EMAIL_OUTBOX],
})
export class AuthAdaptersModule {}
