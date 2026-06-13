import { Global, Module } from '@nestjs/common';
import { loadWorkerConfig } from '@b2b/config';
import { WORKER_CONFIG, WORKER_IDENTITY } from '../../worker.constants';
import { WorkerConfigService } from './worker-config.service';
import { buildWorkerIdentity } from '../../identity';

/** Loads + validates worker env (fail-fast) and resolves the worker identity. */
@Global()
@Module({
  providers: [
    { provide: WORKER_CONFIG, useFactory: () => loadWorkerConfig() },
    WorkerConfigService,
    {
      provide: WORKER_IDENTITY,
      useFactory: (config: WorkerConfigService) =>
        buildWorkerIdentity({ WORKER_INSTANCE_ID: config.instanceId }),
      inject: [WorkerConfigService],
    },
  ],
  exports: [WORKER_CONFIG, WORKER_IDENTITY, WorkerConfigService],
})
export class WorkerConfigModule {}
