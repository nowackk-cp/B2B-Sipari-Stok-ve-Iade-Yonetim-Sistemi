/**
 * Password hashing port. Hides the concrete KDF (argon2id) behind an interface
 * so the algorithm/parameters can evolve and so services stay testable.
 */
export interface PasswordHasher {
  /** Produce a self-describing PHC hash string for a (normalized) password. */
  hash(password: string): Promise<string>;

  /**
   * Constant-time verification of a password against a stored hash. Returns
   * false (never throws) for malformed/unsupported hashes.
   */
  verify(password: string, hash: string): Promise<boolean>;

  /**
   * Whether a stored hash should be re-hashed with the current parameters after
   * a successful verify (parameter upgrade / algorithm migration).
   */
  needsRehash(hash: string): boolean;
}
