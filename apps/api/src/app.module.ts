import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigModule } from './common/config/app-config.module';
import { LoggerModule } from './common/logging/logger.module';
import { LoggingInterceptor } from './common/logging/logging.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [AppConfigModule, LoggerModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
