import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@b2b/logger';
import { REDIS_CONNECTION, WORKER_LOGGER } from '../worker.constants';
import { WorkerConfigService } from '../common/config/worker-config.service';

/** Raised when the worker cannot establish a usable Redis connection. */
export class RedisUnavailableError extends Error {
  constructor(detail: string) {
    super(`Redis is unavailable: ${detail}`);
    this.name = 'RedisUnavailableError';
  }
}

/**
 * Owns the shared Redis connection and the BullMQ queue registry.
 * Connecting is explicit ({@link connect}) so failures are reported in a
 * controlled way at boot rather than as uncaught background errors.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private connected = false;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
    private readonly config: WorkerConfigService,
  ) {
    // Surface connection-level problems without crashing the process.
    this.redis.on('error', (err) => {
      this.logger.error({ err, event: 'redis.error' }, 'Redis connection error');
    });
  }

  /** Dial Redis and verify reachability. Throws {@link RedisUnavailableError}. */
  async connect(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'close') {
        await this.redis.connect();
      }
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new RedisUnavailableError(`unexpected ping reply: ${pong}`);
      }
      this.connected = true;
      this.logger.info({ event: 'redis.connected' }, 'Connected to Redis');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RedisUnavailableError(detail);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Lazily create (and cache) a BullMQ queue. Business queues are registered by
   * later tasks; the infrastructure to do so lives here.
   */
  getQueue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.redis, prefix: this.config.queuePrefix });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
    this.connected = false;
    this.logger.info({ event: 'redis.disconnected' }, 'Closed Redis connection');
  }
}
