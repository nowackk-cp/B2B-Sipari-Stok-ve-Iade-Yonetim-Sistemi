/** A freshly minted opaque token and its storable digest. */
export interface OpaqueToken {
  /** The plaintext token — returned to the client exactly once, never stored. */
  token: string;
  /** SHA-256 hex digest persisted in place of the plaintext. */
  digest: string;
}

/**
 * Cryptographically-secure opaque-token port. Used for refresh tokens and
 * single-use password-reset tokens. The database only ever sees the digest.
 */
export interface TokenGenerator {
  /** Generate a new random token together with its digest. */
  generate(): OpaqueToken;
  /** Compute the digest of an incoming token for constant-time DB lookup. */
  digest(token: string): string;
}
