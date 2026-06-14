import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../../app.constants';
import { AppConfigService } from '../../../common/config/app-config.service';
import type { RateLimiter, RateLimitResult } from '../ports/rate-limiter.port';

/**
 * Redis-backed fixed-window limiter — the production binding. Counters are
 * shared across all API instances (unlike a per-process memory limiter, which
 * is rejected for production).
 *
 * Fail-open-on-outage (documented, TASK-009 §7): if Redis is unreachable, this
 * limiter allows the request and logs a warning, because the AUTHORITATIVE
 * brute-force control is the durable PostgreSQL per-account lockout
 * (`users.locked_until`), which keeps working without Redis. Redis is never the
 * source of truth for security state. Failing closed here would turn a Redis
 * outage into a full login outage; the Postgres lockout still caps per-account
 * guessing, so fail-open is the deliberate trade-off.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    config: AppConfigService,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Swallow connection errors at the emitter level; per-call handling logs.
    this.redis.on('error', () => undefined);
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.expire(redisKey, windowSeconds);
      }
      const ttl = await this.redis.ttl(redisKey);
      const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
      if (count > limit) {
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds };
    } catch (err) {
      this.logger.warn(
        { event: 'auth.ratelimit.degraded', err },
        'rate limiter unavailable; failing open (PostgreSQL lockout remains authoritative)',
      );
      return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`ratelimit:${key}`);
    } catch {
      // Non-fatal: a stale counter at worst over-throttles briefly.
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
