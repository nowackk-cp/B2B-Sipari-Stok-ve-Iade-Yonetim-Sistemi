import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderRepository } from './order.repository';

/**
 * Order module (Order Draft + Approval Foundation). Owns the `orders`,
 * `order_items` and `order_status_history` tables via {@link OrderRepository}
 * (MODULE_BOUNDARIES §2). The DRAFT lifecycle (create/update/cancel) touches NO
 * stock; APPROVE reserves stock by calling the inventory module's service (never
 * by writing stock tables directly — MODULE_BOUNDARIES §3.1), so it imports
 * InventoryModule for {@link StockService}. Imports AuthorizationModule so the
 * globally-bound PermissionGuard and the WarehouseScopeService resolve in this
 * context; the clock, database and audit modules are global.
 */
@Module({
  imports: [AuthorizationModule, InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
