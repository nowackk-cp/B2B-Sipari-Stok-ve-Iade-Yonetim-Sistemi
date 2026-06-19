import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrdersModule } from '../orders/orders.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { ReturnRepository } from './return.repository';

/**
 * Returns module (Return/Refund Foundation). Owns the `returns`, `return_items` and
 * `return_status_history` tables via {@link ReturnRepository} (MODULE_BOUNDARIES
 * §2). It raises a return for a SHIPPED order and, on approval, restocks the goods.
 * It reads order data ONLY through {@link OrdersService} (imports OrdersModule) and
 * writes stock ONLY through {@link StockService} (imports InventoryModule) — never
 * the orders/stock tables directly (§2/§3.1/§5). Imports AuthorizationModule so the
 * globally-bound PermissionGuard and the WarehouseScopeService resolve in this
 * context; the clock, database and audit modules are global.
 */
@Module({
  imports: [AuthorizationModule, OrdersModule, InventoryModule],
  controllers: [ReturnsController],
  providers: [ReturnsService, ReturnRepository],
  exports: [ReturnsService],
})
export class ReturnsModule {}
