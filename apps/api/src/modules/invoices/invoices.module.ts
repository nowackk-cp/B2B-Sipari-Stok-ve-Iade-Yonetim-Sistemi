import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { OrdersModule } from '../orders/orders.module';
import { ReturnsModule } from '../returns/returns.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoiceRepository } from './invoice.repository';
import { CreditNotesController } from './credit-notes.controller';
import { CreditNotesService } from './credit-notes.service';
import { CreditNoteRepository } from './credit-note.repository';

/**
 * Billing module (Invoice/Billing + Credit Note Foundations). Owns the `invoices`,
 * `invoice_items`, `invoice_series`, `credit_notes` and `credit_note_items` tables
 * (MODULE_BOUNDARIES §2). It issues an invoice for a SHIPPED order (reading order
 * data ONLY through {@link OrdersService}) and a credit note for an APPROVED return
 * (reading return data ONLY through {@link ReturnsService} and order data through
 * OrdersService — never the orders/returns tables directly, §2/§5), so it imports
 * OrdersModule and ReturnsModule. The credit note reuses the gapless `invoice_series`
 * counter (series code 'CRN') via {@link InvoiceRepository}. Imports
 * AuthorizationModule so the globally-bound PermissionGuard and the
 * WarehouseScopeService resolve in this context; the clock, database and audit
 * modules are global.
 */
@Module({
  imports: [AuthorizationModule, OrdersModule, ReturnsModule],
  controllers: [InvoicesController, CreditNotesController],
  providers: [InvoicesService, InvoiceRepository, CreditNotesService, CreditNoteRepository],
  exports: [InvoicesService],
})
export class InvoicesModule {}
