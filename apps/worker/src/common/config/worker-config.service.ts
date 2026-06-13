import { Inject, Injectable } from '@nestjs/common';
import type { WorkerConfig } from '@b2b/config';
import { WORKER_CONFIG } from '../../worker.constants';

@Injectable()
export class WorkerConfigService {
  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {}

  get raw(): WorkerConfig {
    return this.config;
  }

  get nodeEnv(): WorkerConfig['NODE_ENV'] {
    return this.config.NODE_ENV;
  }

  get logLevel(): WorkerConfig['LOG_LEVEL'] {
    return this.config.LOG_LEVEL;
  }

  get redisUrl(): string {
    return this.config.REDIS_URL;
  }

  get concurrency(): number {
    return this.config.WORKER_CONCURRENCY;
  }

  get queuePrefix(): string {
    return this.config.WORKER_QUEUE_PREFIX;
  }

  get instanceId(): string | undefined {
    return this.config.WORKER_INSTANCE_ID;
  }
}
