import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Logger } from '@b2b/logger';
import { AppModule } from './app.module';
import { APP_VERSION, WORKER_IDENTITY, WORKER_LOGGER } from './worker.constants';
import { PinoNestLogger } from './common/logging/nest-logger.adapter';
import { WorkerConfigService } from './common/config/worker-config.service';
import { QueueService } from './queue/queue.service';
import type { WorkerIdentity } from './identity';

async function bootstrap(): Promise<void> {
  // Config validation happens inside WorkerConfigModule (fail-fast).
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  const logger = app.get<Logger>(WORKER_LOGGER);
  app.useLogger(new PinoNestLogger(logger));
  app.enableShutdownHooks();

  const config = app.get(WorkerConfigService);
  const identity = app.get<WorkerIdentity>(WORKER_IDENTITY);
  const queue = app.get(QueueService);

  try {
    await queue.connect();
  } catch (err) {
    logger.error(
      { err, event: 'worker.redis_unavailable', instanceId: identity.instanceId },
      'Redis is unavailable — worker cannot start. Check REDIS_URL and that Redis is running.',
    );
    await app.close();
    process.exit(1);
    return;
  }

  logger.info(
    {
      event: 'worker.ready',
      version: APP_VERSION,
      instanceId: identity.instanceId,
      hostname: identity.hostname,
      pid: identity.pid,
      environment: config.nodeEnv,
      concurrency: config.concurrency,
      queuePrefix: config.queuePrefix,
    },
    'Worker ready (no business processors registered yet)',
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info(
      { event: 'worker.shutdown', signal, instanceId: identity.instanceId },
      'Shutting down',
    );
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal: worker failed to start', err);
  process.exit(1);
});
