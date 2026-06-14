/** DI tokens for the swappable auth adapters (hashing, tokens, throttling). */
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const TOKEN_GENERATOR = Symbol('TOKEN_GENERATOR');
export const ACCESS_TOKEN_SIGNER = Symbol('ACCESS_TOKEN_SIGNER');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const EMAIL_OUTBOX = Symbol('EMAIL_OUTBOX');
