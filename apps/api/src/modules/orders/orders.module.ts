import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderRepository } from './order.repository';

/**
 * Order module (Order Draft Foundation). Owns the `orders` + `order_items` tables
 * via {@link OrderRepository} (MODULE_BOUNDARIES §2) for the DRAFT lifecycle only —
 * NO stock reservation/ledger/balance is touched here. Imports AuthorizationModule
 * so the globally-bound PermissionGuard and the WarehouseScopeService resolve in
 * this context; the clock, database and audit modules are global.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
