import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductRepository } from './product.repository';

/**
 * Catalog product module (TASK-011). Owns the `products` table via
 * {@link ProductRepository} (MODULE_BOUNDARIES §2). Imports AuthorizationModule
 * so the globally-bound PermissionGuard can resolve its services in this context;
 * authentication providers and the AuditWriter are global. The clock, database
 * and audit modules are global, so no further imports are needed.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductRepository],
  exports: [ProductsService],
})
export class ProductsModule {}
