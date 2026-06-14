import { Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/time/clock';
import type { RateLimiter, RateLimitResult } from '../ports/rate-limiter.port';
import { Inject } from '@nestjs/common';

interface Bucket {
  count: number;
  resetAtMs: number;
}

/**
 * Single-process, in-memory fixed-window limiter.
 *
 * NOT a production binding — a per-instance memory limiter is explicitly
 * rejected for production (TASK-009 §7) because it does not share state across
 * API instances. It exists for hermetic tests and local single-process dev,
 * where it makes the rate-limit behavior deterministic without Redis.
 */
@Injectable()
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.clock.now().getTime();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= now) {
      const bucket = { count: 1, resetAtMs: now + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: windowSeconds };
    }
    existing.count += 1;
    const retryAfterSeconds = Math.ceil((existing.resetAtMs - now) / 1000);
    if (existing.count > limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    return { allowed: true, remaining: Math.max(0, limit - existing.count), retryAfterSeconds };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /** Clear every counter (test isolation; harmless for the dev/test binding). */
  clearAll(): void {
    this.buckets.clear();
  }
}
