import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';
import { WarehouseRepository } from './warehouse.repository';

/**
 * Warehouse master-data module (TASK-012). Owns the `warehouses` table via
 * {@link WarehouseRepository} (MODULE_BOUNDARIES §2). Imports AuthorizationModule
 * so the globally-bound PermissionGuard resolves in this context AND so the
 * service can call {@link WarehouseScopeService} for per-warehouse scope
 * enforcement; authentication providers and the AuditWriter are global. The
 * clock, database and audit modules are global, so no further imports are needed.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [WarehousesController],
  providers: [WarehousesService, WarehouseRepository],
  exports: [WarehousesService],
})
export class WarehousesModule {}
