import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigModule } from './common/config/app-config.module';
import { LoggerModule } from './common/logging/logger.module';
import { LoggingInterceptor } from './common/logging/logging.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { DatabaseModule } from './common/database/database.module';
import { TimeModule } from './common/time/time.module';
import { AuditModule } from './common/audit/audit.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { IdentityModule } from './modules/identity/identity.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './modules/authorization/authorization.module';
import { PermissionGuard } from './modules/authorization/guards/permission.guard';
import { ProductsModule } from './modules/products/products.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CustomersModule } from './modules/customers/customers.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    DatabaseModule,
    TimeModule,
    AuditModule,
    HealthModule,
    AuthModule,
    // Imported directly (in addition to AuthModule) so the globally-bound
    // JwtAuthGuard can resolve UserRepository + SessionService in this context.
    IdentityModule,
    SessionsModule,
    AuthorizationModule,
    ProductsModule,
    WarehousesModule,
    InventoryModule,
    CustomersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // Global guard chain — ORDER MATTERS. NestJS runs APP_GUARD providers in the
    // order declared here, before any controller/route-level guard. Authentication
    // runs first so the principal is attached, then permission enforcement reads
    // it. Routes opt out of authentication with `@Public()`; permission checks
    // only apply to routes carrying `@RequirePermissions(...)` (deny-by-default).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
