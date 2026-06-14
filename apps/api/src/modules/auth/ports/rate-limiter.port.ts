export interface RateLimitResult {
  /** Whether this attempt is permitted. */
  allowed: boolean;
  /** Remaining attempts in the current window (>= 0). */
  remaining: number;
  /** Seconds until the window resets (relevant when `allowed` is false). */
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter port (secondary brute-force defense). The durable,
 * authoritative account lockout lives in PostgreSQL (`users.locked_until`);
 * this limiter only throttles request bursts per IP and per login identifier.
 *
 * The production binding is Redis-backed (shared across instances). Redis is
 * NEVER the source of truth for security state — see RedisRateLimiter for the
 * documented fail-open-on-outage behavior.
 */
export interface RateLimiter {
  /** Record an attempt against `key`, returning whether it is allowed. */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Clear the counter for `key` (e.g. after a successful login). */
  reset(key: string): Promise<void>;
}
