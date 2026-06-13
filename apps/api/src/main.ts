import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Logger } from '@b2b/logger';
import { API_DOCS_PATH, API_GLOBAL_PREFIX } from '@b2b/shared';
import { AppModule } from './app.module';
import { APP_LOGGER } from './app.constants';
import { AppConfigService } from './common/config/app-config.service';
import { PinoNestLogger } from './common/logging/nest-logger.adapter';
import { configureApp, setupSwagger } from './bootstrap';

async function bootstrap(): Promise<void> {
  // Config is validated inside AppConfigModule; a failure here is fail-fast.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get<Logger>(APP_LOGGER);
  app.useLogger(new PinoNestLogger(logger));

  const config = app.get(AppConfigService);
  configureApp(app, config);

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  await app.listen(config.port);

  logger.info(
    {
      event: 'api.started',
      port: config.port,
      environment: config.nodeEnv,
      prefix: `/${API_GLOBAL_PREFIX}`,
      docs: config.swaggerEnabled ? `/${API_DOCS_PATH}` : undefined,
    },
    'API listening',
  );
}

bootstrap().catch((err: unknown) => {
  // The logger may not exist yet (e.g. config validation failure): use console.
  console.error('Fatal: API failed to start', err);
  process.exit(1);
});
