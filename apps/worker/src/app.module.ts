import { Module } from '@nestjs/common';
import { WorkerConfigModule } from './common/config/worker-config.module';
import { LoggerModule } from './common/logging/logger.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [WorkerConfigModule, LoggerModule, QueueModule],
})
export class AppModule {}
