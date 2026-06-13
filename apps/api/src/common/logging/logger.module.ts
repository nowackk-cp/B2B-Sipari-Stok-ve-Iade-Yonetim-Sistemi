import { Global, Module } from '@nestjs/common';
import { createLogger } from '@b2b/logger';
import { APP_LOGGER, SERVICE_NAME } from '../../app.constants';
import { AppConfigService } from '../config/app-config.service';

/** Provides the shared pino logger, configured from the API environment. */
@Global()
@Module({
  providers: [
    {
      provide: APP_LOGGER,
      useFactory: (config: AppConfigService) =>
        createLogger({
          service: SERVICE_NAME,
          environment: config.nodeEnv,
          level: config.logLevel,
          pretty: config.nodeEnv === 'development',
        }),
      inject: [AppConfigService],
    },
  ],
  exports: [APP_LOGGER],
})
export class LoggerModule {}
