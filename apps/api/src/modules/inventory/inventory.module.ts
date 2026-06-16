import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { StockRepository } from './stock.repository';

/**
 * Inventory module (Stock Ledger Foundation). Owns the `stock_balances` and
 * append-only `stock_ledger` tables via {@link StockRepository}
 * (MODULE_BOUNDARIES §2). Imports AuthorizationModule so the globally-bound
 * PermissionGuard and the WarehouseScopeService resolve in this context; the
 * clock, database and audit modules are global, so no further imports are needed.
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [StockController],
  providers: [StockService, StockRepository],
  exports: [StockService],
})
export class InventoryModule {}
