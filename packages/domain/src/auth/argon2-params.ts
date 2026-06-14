/**
 * Pure helpers for reasoning about an encoded argon2 hash string.
 *
 * The PHC-format hash carries its own parameters, e.g.:
 *   $argon2id$v=19$m=19456,t=3,p=1$<saltB64>$<hashB64>
 *
 * These functions let the auth service decide — without any crypto library —
 * whether a stored hash was produced with the canonical algorithm and with
 * parameters at least as strong as the current policy. If not, the service can
 * transparently re-hash the password on the next successful login.
 */

export interface Argon2Params {
  /** Variant, e.g. "argon2id". */
  type: string;
  /** Memory cost in KiB (the `m` parameter). */
  memoryKiB: number;
  /** Time cost / iterations (the `t` parameter). */
  iterations: number;
  /** Degree of parallelism (the `p` parameter). */
  parallelism: number;
}

export interface Argon2PolicyTarget {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/**
 * Parse the parameters out of an encoded argon2 hash. Returns `null` when the
 * string is not a recognizable argon2 PHC hash.
 */
export function parseArgon2Hash(encoded: string): Argon2Params | null {
  // $argon2id$v=19$m=...,t=...,p=...$salt$hash
  const match = /^\$(argon2(?:id|i|d))\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!match) return null;
  const [, type, m, t, p] = match;
  return {
    type: type as string,
    memoryKiB: Number(m),
    iterations: Number(t),
    parallelism: Number(p),
  };
}

/**
 * Decide whether a stored hash should be upgraded on next successful login.
 *
 * Returns true when the hash is not argon2id, is unparseable, or was produced
 * with any cost parameter weaker than the current policy target. A stronger
 * stored hash is left untouched.
 */
export function needsRehash(encoded: string, target: Argon2PolicyTarget): boolean {
  const params = parseArgon2Hash(encoded);
  if (!params) return true;
  if (params.type !== 'argon2id') return true;
  return (
    params.memoryKiB < target.memoryKiB ||
    params.iterations < target.iterations ||
    params.parallelism < target.parallelism
  );
}
