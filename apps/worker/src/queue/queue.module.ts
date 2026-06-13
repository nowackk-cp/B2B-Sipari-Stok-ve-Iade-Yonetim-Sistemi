import { Global, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CONNECTION } from '../worker.constants';
import { WorkerConfigService } from '../common/config/worker-config.service';
import { QueueService } from './queue.service';

/**
 * BullMQ infrastructure module.
 *
 * Provides the shared ioredis connection (lazy — it does not dial Redis until
 * {@link QueueService.connect} is called at boot) and the {@link QueueService}
 * used to create queues. No business processors are registered yet.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      useFactory: (config: WorkerConfigService) =>
        new Redis(config.redisUrl, {
          lazyConnect: true,
          // BullMQ requires these settings on the shared connection.
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
        }),
      inject: [WorkerConfigService],
    },
    QueueService,
  ],
  exports: [REDIS_CONNECTION, QueueService],
})
export class QueueModule {}
