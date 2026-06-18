import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrdersModule } from '../orders/orders.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceRepository } from './invoice.repository';

/**
 * Billing module (Invoice/Billing Foundation). Owns the `invoices`,
 * `invoice_items` and `invoice_series` tables via {@link InvoiceRepository}
 * (MODULE_BOUNDARIES §2). It issues an invoice for a SHIPPED order, reading order
 * data ONLY through {@link OrdersService} (never the orders tables directly —
 * §2/§5), so it imports OrdersModule. Imports AuthorizationModule so the
 * globally-bound PermissionGuard and the WarehouseScopeService resolve in this
 * context; the clock, database and audit modules are global.
 */
@Module({
  imports: [AuthorizationModule, OrdersModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceRepository],
  exports: [InvoicesService],
})
export class InvoicesModule {}
