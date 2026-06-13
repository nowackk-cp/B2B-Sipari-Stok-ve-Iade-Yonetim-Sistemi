import { Global, Module } from '@nestjs/common';
import { createLogger } from '@b2b/logger';
import { SERVICE_NAME, WORKER_LOGGER } from '../../worker.constants';
import { WorkerConfigService } from '../config/worker-config.service';

@Global()
@Module({
  providers: [
    {
      provide: WORKER_LOGGER,
      useFactory: (config: WorkerConfigService) =>
        createLogger({
          service: SERVICE_NAME,
          environment: config.nodeEnv,
          level: config.logLevel,
          pretty: config.nodeEnv === 'development',
        }),
      inject: [WorkerConfigService],
    },
  ],
  exports: [WORKER_LOGGER],
})
export class LoggerModule {}
